/*
 * Copyright 2026, Salesforce, Inc.
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
import { readFile, readdir, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Connection, SfError } from '@salesforce/core';
import { AgentPreviewInterface, type AgentPreviewSendResponse, type PlannerResponse, PreviewMetadata } from '../types';
import { getHistoryDir, TranscriptEntry } from '../utils';

/**
 * Abstract base class for agent preview functionality.
 * Contains shared properties and methods between ScriptAgent and ProductionAgent.
 */
export abstract class AgentBase {
  /**
   * The display name of the agent (user-friendly name, not API name)
   */
  public name: string | undefined;
  protected sessionId: string | undefined;
  protected historyDir: string | undefined;
  protected apexDebugging: boolean | undefined;
  protected planIds = new Set<string>();
  public abstract preview: AgentPreviewInterface;

  protected constructor(protected readonly connection: Connection) {}

  public async restoreConnection(): Promise<void> {
    delete this.connection.accessToken;
    await this.connection.refreshAuth();
  }

  public setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  public async getHistoryDir(): Promise<string> {
    if (!this.sessionId) {
      throw SfError.create({ message: 'No sessionId set on agent. Call setSessionId() before getHistoryDir().' });
    }
    return getHistoryDir(await this.getAgentIdForStorage(), this.sessionId);
  }

  /**
   * Get all traces from the current session
   * Reads traces from the session directory if available, otherwise fetches from API
   */
  protected async getAllTracesFromDisc(): Promise<PlannerResponse[]> {
    if (!this.historyDir) {
      throw SfError.create({ message: 'history never created' });
    }
    const traces: PlannerResponse[] = [];

    // If we have a session directory, try reading traces from disk first
    const tracesDir = join(this.historyDir, 'traces');
    const files = await readdir(tracesDir);
    const tracePromises = files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        const traceData = await readFile(join(tracesDir, file), 'utf-8');
        return JSON.parse(traceData) as PlannerResponse;
      });
    traces.push(...(await Promise.all(tracePromises)));
    return traces;
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
  protected async saveSessionTo(outputDir: string): Promise<string> {
    if (!this.sessionId || !this.historyDir) {
      throw SfError.create({ name: 'noSessionId', message: 'No active session. Call .start() first.' });
    }

    const agentId = await this.getAgentIdForStorage();

    // Determine output directory
    const destDir = join(outputDir, agentId, `session_${this.sessionId}`);

    // Copy the entire session directory from .sfdx to the output directory
    // This includes transcript.jsonl, traces/, and metadata.json
    await mkdir(destDir, { recursive: true });
    await cp(this.historyDir, destDir, { recursive: true });

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
   * Send a message to the agent using the session ID obtained by calling `start()`.
   *
   * @param message A message to send to the agent.
   * @returns `AgentPreviewSendResponse`
   */

  protected abstract sendMessage(message: string): Promise<AgentPreviewSendResponse>;
  /**
   * Get the agent ID to use for storage/transcript purposes
   */
  protected abstract getAgentIdForStorage(): string | Promise<string>;

  /**
   * Check if Apex debugging should be enabled for this agent type
   */
  protected abstract canApexDebug(): boolean;

  /**
   * Handle Apex debugging setup before sending a message
   */
  protected abstract handleApexDebuggingSetup(): Promise<void>;

  protected abstract getTrace(planId: string): Promise<PlannerResponse | undefined>;

  protected abstract getHistoryFromDisc(): Promise<{
    metadata: PreviewMetadata | null;
    transcript: TranscriptEntry[];
    traces: PlannerResponse[];
  }>;
}
