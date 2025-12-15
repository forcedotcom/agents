/*
 * Copyright 2025, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Connection, SfError } from '@salesforce/core';
import {
  type AgentPreviewEndResponse,
  type AgentPreviewSendResponse,
  type AgentPreviewStartResponse,
  type PlannerResponse,
} from './types';
import {
  type TranscriptEntry,
  getSessionDir,
  copyDirectory,
  appendTranscriptEntryToSession,
  writeTraceToSession,
} from './utils';
import { getDebugLog } from './apexUtils';

/**
 * Common preview interface that both ScriptAgent and ProductionAgent implement
 */
export type AgentPreviewInterface = {
  start: (...args: unknown[]) => Promise<AgentPreviewStartResponse>;
  send: (message: string) => Promise<AgentPreviewSendResponse>;
  getAllTraces: () => Promise<PlannerResponse[]>;
  end: (...args: unknown[]) => Promise<AgentPreviewEndResponse>;
  saveSession: (outputDir?: string) => Promise<string>;
  setApexDebugging: (apexDebugging: boolean) => void;
};

/**
 * Abstract base class for agent preview functionality.
 * Contains shared properties and methods between ScriptAgent and ProductionAgent.
 */
export abstract class AgentInteractionBase {
  /**
   * The display name of the agent (user-friendly name, not API name)
   */
  public name: string | undefined;

  protected sessionId: string | undefined;
  protected sessionDir: string | undefined;
  protected apexDebugging: boolean | undefined;
  protected planIds = new Set<string>();

  public abstract preview: AgentPreviewInterface;

  protected constructor(protected readonly connection: Connection) {}

  public async restoreConnection(): Promise<void> {
    delete this.connection.accessToken;
    await this.connection.refreshAuth();
  }

  /**
   * Send a message to the agent using the session ID obtained by calling `start()`.
   *
   * @param message A message to send to the agent.
   * @returns `AgentPreviewSendResponse`
   */
  protected async sendMessage(message: string): Promise<AgentPreviewSendResponse> {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'Agent not started, please call .start() first' });
    }

    const url = this.getSendMessageUrl();
    const body = {
      message: {
        sequenceId: Date.now(),
        type: 'Text',
        text: message,
      },
      variables: [],
    };

    try {
      const start = Date.now();

      // Handle Apex debugging setup if needed
      if (this.apexDebugging && this.canApexDebug()) {
        await this.handleApexDebuggingSetup();
      }

      const agentId = await this.getAgentIdForStorage();

      // Ensure session directory exists
      if (!this.sessionDir) {
        this.sessionDir = await getSessionDir(agentId, this.sessionId);
      }

      // Write user entry immediately
      const userEntry: TranscriptEntry = {
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: this.sessionId,
        role: 'user',
        text: message,
      };
      await appendTranscriptEntryToSession(userEntry, this.sessionDir);

      const response = await this.connection.request<AgentPreviewSendResponse>({
        method: 'POST',
        url,
        body: JSON.stringify(body),
        headers: {
          'x-client-name': 'afdx',
        },
      });

      const planId = response.messages.at(0)!.planId;
      this.planIds.add(planId);

      // Write agent response immediately
      const agentText = (response.messages ?? [])
        .map((m) => m.message)
        .filter(Boolean)
        .join('\n');
      const agentEntry: TranscriptEntry = {
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: this.sessionId,
        role: 'agent',
        text: agentText || undefined,
        raw: response.messages,
      };
      await appendTranscriptEntryToSession(agentEntry, this.sessionDir);

      // Fetch and write trace immediately if available
      if (planId) {
        try {
          const trace = await this.connection.request<PlannerResponse>({
            method: 'GET',
            url: this.getTraceUrl(planId),
            headers: {
              'x-client-name': 'afdx',
            },
          });
          await writeTraceToSession(planId, trace, this.sessionDir);
        } catch (error) {
          // Trace might not be available yet, that's okay
        }
      }

      if (this.apexDebugging && this.canApexDebug()) {
        const apexLog = await getDebugLog(this.connection, start, Date.now());
        if (apexLog) {
          response.apexDebugLog = apexLog;
        }
      }

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  /**
   * Get all traces from the current session
   * Reads traces from the session directory if available, otherwise fetches from API
   */
  protected async getAllTracesFromSession(): Promise<PlannerResponse[]> {
    if (!this.sessionId) {
      throw SfError.create({ message: 'Session never created' });
    }

    // If we have a session directory, try reading traces from disk first
    if (this.sessionDir) {
      const tracesDir = join(this.sessionDir, 'traces');
      try {
        const files = await readdir(tracesDir);
        const traces: PlannerResponse[] = [];
        const tracePromises = files
          .filter((file) => file.endsWith('.json'))
          .map(async (file) => {
            const traceData = await readFile(join(tracesDir, file), 'utf-8');
            return JSON.parse(traceData) as PlannerResponse;
          });
        traces.push(...(await Promise.all(tracePromises)));
        if (traces.length > 0) {
          return traces;
        }
      } catch {
        // If traces directory doesn't exist or can't be read, fall through to API fetch
      }
    }

    // Fallback to fetching from API
    const promises: Array<Promise<PlannerResponse>> = [];
    for (const id of this.planIds) {
      promises.push(
        this.connection.request<PlannerResponse>({
          method: 'GET',
          url: this.getTraceUrl(id),
          headers: {
            'x-client-name': 'afdx',
          },
        })
      );
    }

    return Promise.all(promises);
  }

  /**
   * Save the complete session data to disk by copying the session directory.
   * The session directory is already populated during the session with:
   * - Transcript entries (transcript.jsonl)
   * - Traces (traces/*.json)
   * - Session metadata (metadata.json)
   *
   * Session directory structure:
   * .sfdx/agents/<agentId>/sessions/<sessionId>/
   * ├── transcript.jsonl    # All transcript entries (one per line)
   * ├── traces/             # Individual trace files
   * │   ├── <planId1>.json
   * │   └── <planId2>.json
   * └── metadata.json       # Session metadata (start time, end time, planIds, etc.)
   *
   * @param outputDir Optional output directory. If not provided, uses default location.
   * @returns The path to the copied session directory
   */
  protected async saveSessionToDisc(outputDir: string): Promise<string> {
    if (!this.sessionId || !this.sessionDir) {
      throw SfError.create({ name: 'noSessionId', message: 'No active session. Call .start() first.' });
    }

    const agentId = await this.getAgentIdForStorage();

    // Determine output directory
    const destDir = join(outputDir, agentId, `session_${this.sessionId}`);

    // Copy the entire session directory from .sfdx to the output directory
    // This includes transcript.jsonl, traces/, and metadata.json
    await copyDirectory(this.sessionDir, destDir);

    return destDir;
  }

  /**
   * Set the Apex debugging mode for the agent preview.
   * This can be called before starting a session.
   *
   * @param apexDebugging true to enable Apex debugging, false to disable
   */
  protected setApexDebugging(apexDebugging: boolean): void {
    this.apexDebugging = apexDebugging;
  }

  /**
   * Get the agent ID to use for storage/transcript purposes
   */
  protected abstract getAgentIdForStorage(): string | Promise<string>;

  /**
   * Get the URL for fetching traces
   */
  protected abstract getTraceUrl(traceId: string): string;

  /**
   * Check if Apex debugging should be enabled for this agent type
   */
  protected abstract canApexDebug(): boolean;

  /**
   * Handle Apex debugging setup before sending a message
   */
  protected abstract handleApexDebuggingSetup(): Promise<void>;

  /**
   * Get the URL for sending messages
   */
  protected abstract getSendMessageUrl(): string;
}
