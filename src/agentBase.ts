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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { env } from '@salesforce/kit';
import {
  type AgentPreviewEndResponse,
  type AgentPreviewSendResponse,
  type AgentPreviewStartResponse,
  type PlannerResponse,
} from './types';
import { readTranscriptEntries, type TranscriptEntry } from './utils';
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
export abstract class AgentBase {
  protected readonly apiBase = `https://${
    env.getBoolean('SF_TEST_API') ? 'test.' : ''
  }api.salesforce.com/einstein/ai-agent`;
  protected sessionId: string | undefined;
  protected apexDebugging: boolean | undefined;
  protected transcriptEntries: TranscriptEntry[] = [];
  protected planIds = new Set<string>();

  public abstract preview: AgentPreviewInterface;

  protected constructor(protected readonly connection: Connection) {}

  protected async restoreConnection(): Promise<void> {
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

      // Store user entry for later writing
      this.transcriptEntries.push({
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: this.sessionId,
        role: 'user',
        text: message,
      });

      const response = await this.connection.request<AgentPreviewSendResponse>({
        method: 'POST',
        url,
        body: JSON.stringify(body),
        headers: {
          'x-client-name': 'afdx',
        },
      });

      this.planIds.add(response.messages.at(0)!.planId);

      // Store agent response entry for later writing
      const agentText = (response.messages ?? [])
        .map((m) => m.message)
        .filter(Boolean)
        .join('\n');
      this.transcriptEntries.push({
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: this.sessionId,
        role: 'agent',
        text: agentText || undefined,
        raw: response.messages,
      });

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
   */
  protected async getAllTracesFromSession(): Promise<PlannerResponse[]> {
    if (!this.sessionId) {
      throw SfError.create({ message: 'Session never created' });
    }
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
   * Save the complete session data to disk including:
   * - Transcript entries (user inputs and agent responses)
   * - Traces (planner responses with execution plans)
   * - Session metadata
   *
   * @param outputDir Optional output directory. If not provided, uses default location.
   * @returns The path to the saved session file
   */
  protected async saveSessionToDisc(outputDir?: string): Promise<string> {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'No active session. Call .start() first.' });
    }

    const agentId = await this.getAgentIdForStorage();

    // Read transcript entries
    const transcriptEntries = await readTranscriptEntries(agentId);
    const sessionTranscripts = transcriptEntries.filter((entry) => entry.sessionId === this.sessionId);

    // Fetch all traces for this session
    const traces: PlannerResponse[] = [];
    try {
      const allTraces = await this.getAllTracesFromSession();
      traces.push(...allTraces);
    } catch (error) {
      // If traces can't be fetched, continue without them
      // This might happen if the session has ended or traces aren't available
    }

    // Create session data structure
    const sessionData = {
      sessionId: this.sessionId,
      agentId,
      timestamp: new Date().toISOString(),
      transcript: sessionTranscripts,
      traces,
      metadata: {
        planIds: Array.from(this.planIds),
        apexDebugging: this.apexDebugging,
      },
    };

    // Determine output directory
    let baseDir: string;
    if (outputDir) {
      baseDir = join(outputDir, agentId);
    } else {
      const project = await SfProject.resolve();
      baseDir = join(project.getPath(), '.sfdx', 'agents', agentId);
    }
    await mkdir(baseDir, { recursive: true });

    const sessionFilePath = join(baseDir, `session_${this.sessionId}.json`);
    await writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2), 'utf-8');

    return sessionFilePath;
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
