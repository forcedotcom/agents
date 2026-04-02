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
import { randomUUID } from 'node:crypto';
import { Messages, SfError } from '@salesforce/core';
import {
  type AgentPreviewEndResponse,
  AgentPreviewInterface,
  type AgentPreviewSendResponse,
  type AgentPreviewStartResponse,
  type BotActivationResponse,
  type BotMetadata,
  type BotVersionMetadata,
  type EndReason,
  PlannerResponse,
  PreviewMetadata,
  ProductionAgentOptions,
} from '../types';
import { MaybeMock } from '../maybe-mock';
import {
  requestWithEndpointFallback,
  getHistoryDir,
  getAllHistory,
  TranscriptEntry,
  logSessionToIndex,
  getAgentIndexDir,
  logTurnToHistory,
  recordTraceForTurn,
  SessionHistoryBuffer,
} from '../utils';
import { createTraceFlag, findTraceFlag, getDebugLog } from '../apexUtils';
import { AgentBase } from './agentBase';
Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

export class ProductionAgent extends AgentBase {
  public preview: AgentPreviewInterface;
  private botMetadata: BotMetadata | undefined;
  private id: string | undefined;
  private apiName: string | undefined;
  private turnCounter = 0;
  private historyBuffer: SessionHistoryBuffer | undefined;
  private readonly apiBase: string;

  public constructor(private options: ProductionAgentOptions) {
    super(options.connection);
    this.apiBase = 'https://api.salesforce.com/einstein/ai-agent/v1';
    if (!options.apiNameOrId) {
      throw messages.createError('missingAgentNameOrId');
    }

    this.preview = {
      start: (apexDebugging?: boolean): Promise<AgentPreviewStartResponse> => this.startPreview(apexDebugging),
      send: (message: string): Promise<AgentPreviewSendResponse> => this.sendMessage(message),
      getAllTraces: (): Promise<PlannerResponse[]> => this.getAllTracesFromDisc(),
      end: (reason: EndReason): Promise<AgentPreviewEndResponse> => this.endSession(reason),
      saveSession: (outputDir: string): Promise<string> => this.saveSessionTo(outputDir),
      setApexDebugging: (apexDebugging: boolean): void => this.setApexDebugging(apexDebugging),
    } as AgentPreviewInterface;

    if (options.apiNameOrId.startsWith('0Xx') && [15, 18].includes(options.apiNameOrId.length)) {
      this.id = options.apiNameOrId;
    } else {
      this.apiName = options.apiNameOrId;
    }
  }

  public async getBotMetadata(): Promise<BotMetadata> {
    if (!this.botMetadata) {
      const whereClause = this.id ? `Id = '${this.id}'` : `DeveloperName = '${this.apiName!}'`;
      const botDefinitionFields =
        'Id, IsDeleted, DeveloperName, MasterLabel, CreatedDate, CreatedById, LastModifiedDate, LastModifiedById, SystemModstamp, BotUserId, Description, Type, AgentType, AgentTemplate';
      const botVersionFields =
        'Id, Status, IsDeleted, BotDefinitionId, DeveloperName, CreatedDate, CreatedById, LastModifiedDate, LastModifiedById, SystemModstamp, VersionNumber, CopilotPrimaryLanguage, ToneType, CopilotSecondaryLanguages';
      this.botMetadata = await this.connection.singleRecordQuery<BotMetadata>(
        `SELECT ${botDefinitionFields}, (SELECT ${botVersionFields} FROM BotVersions WHERE IsDeleted = false ORDER BY VersionNumber) FROM BotDefinition WHERE ${whereClause} LIMIT 1`
      );
      this.id = this.botMetadata.Id;
      this.apiName = this.botMetadata.DeveloperName;
      // Set the display name from MasterLabel
      this.name = this.botMetadata.MasterLabel;
    }
    return this.botMetadata;
  }

  /**
   * Returns the latest bot version metadata.
   *
   * @returns the latest bot version metadata
   */
  public async getLatestBotVersionMetadata(): Promise<BotVersionMetadata> {
    if (!this.botMetadata) {
      this.botMetadata = await this.getBotMetadata();
    }
    const botVersions = this.botMetadata.BotVersions.records;
    if (botVersions.length === 0) {
      throw messages.createError('noVersionsFound', [this.botMetadata.DeveloperName]);
    }
    return botVersions[botVersions.length - 1];
  }

  /**
   * Gets a bot version by its version number, or latest if omitted.
   * Searches for a version with matching VersionNumber property.
   *
   * @param {number} version - The VersionNumber to find (e.g., 0, 1, 2, 31), or undefined for latest
   * @returns {Promise<BotVersionMetadata>}
   */
  public async getBotVersionMetadata(version?: number): Promise<BotVersionMetadata> {
    if (!this.botMetadata) {
      this.botMetadata = await this.getBotMetadata();
    }
    const botVersions = this.botMetadata.BotVersions.records;

    if (botVersions.length === 0) {
      throw messages.createError('noVersionsFound', [this.botMetadata.DeveloperName]);
    }

    // If no version specified, return the latest (last in array)
    if (version === undefined) {
      return botVersions[botVersions.length - 1];
    }

    // Find the version by VersionNumber property
    const foundVersion = botVersions.find((v) => v.VersionNumber === version);
    if (!foundVersion) {
      throw messages.createError('versionNotFound', [version.toString()]);
    }

    return foundVersion;
  }

  // eslint-disable-next-line @typescript-eslint/require-await,class-methods-use-this,@typescript-eslint/no-unused-vars
  public async getTrace(planId: string): Promise<PlannerResponse | undefined> {
    return undefined;
  }

  public getHistoryFromDisc(sessionId?: string): Promise<{
    metadata: PreviewMetadata | null;
    transcript: TranscriptEntry[];
    traces: PlannerResponse[];
  }> {
    // Use provided sessionId, or fall back to this.sessionId, or let getAllHistory find the most recent
    const actualSessionId = sessionId ?? this.sessionId;
    return getAllHistory(this.getAgentIdForStorage(), actualSessionId);
  }

  /**
   * Returns the ID for this agent.
   *
   * @returns The ID of the agent (The `Bot` ID).
   */
  public async getId(): Promise<string> {
    if (!this.id) {
      await this.getBotMetadata();
    }
    return this.id!; // getBotMetadata() ensures this.id is not undefined
  }
  /**
   * Activates the agent.
   *
   * @param version - The VersionNumber to activate (e.g., 0, 1, 2, 31), or undefined for latest
   * @returns The activated bot version metadata
   */
  public async activate(version?: number): Promise<BotVersionMetadata> {
    return this.setAgentStatus('Active', version);
  }

  /**
   * Deactivates the currently active agent version.
   * Only one version can be active at a time, so this automatically finds and deactivates it.
   *
   * @returns The deactivated bot version metadata
   */
  public async deactivate(): Promise<BotVersionMetadata> {
    const botMetadata = await this.getBotMetadata();
    const activeVersion = botMetadata.BotVersions.records.find((v) => v.Status === 'Active');

    if (!activeVersion) {
      throw messages.createError('noActiveVersion', [botMetadata.DeveloperName]);
    }

    return this.setAgentStatus('Inactive', activeVersion.VersionNumber);
  }

  public getAgentIdForStorage(): string {
    if (!this.id) {
      throw SfError.create({ name: 'noId', message: 'Agent ID not found. Call .getBotMetadata() first.' });
    }
    return this.id;
  }

  // eslint-disable-next-line class-methods-use-this
  protected canApexDebug(): boolean {
    return true;
  }

  protected async handleApexDebuggingSetup(): Promise<void> {
    const botMetadata = await this.getBotMetadata();
    if (botMetadata.BotUserId) {
      const traceFlag = await findTraceFlag(this.connection, botMetadata.BotUserId);
      if (!traceFlag) {
        await createTraceFlag(this.connection, botMetadata.BotUserId);
      }
    }
  }

  protected async sendMessage(message: string): Promise<AgentPreviewSendResponse> {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'Agent not started, please call .start() first' });
    }
    if (!this.historyBuffer) {
      throw SfError.create({ name: 'noHistoryBuffer', message: 'Session not initialized properly' });
    }

    const url = `${this.apiBase}/sessions/${this.sessionId}/messages`;

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

      const agentId = this.getAgentIdForStorage();

      // Ensure session directory exists
      if (!this.historyDir) {
        this.historyDir = await getHistoryDir(agentId, this.sessionId);
      }

      const userEntry = {
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: this.sessionId,
        role: 'user' as const,
        text: message,
      };
      await logTurnToHistory(userEntry, ++this.turnCounter, this.historyDir, this.historyBuffer);

      const response = await requestWithEndpointFallback<AgentPreviewSendResponse>(this.connection, {
        method: 'POST',
        url,
        body: JSON.stringify(body),
        headers: {
          'x-client-name': 'afdx',
        },
      });

      const planId = response.messages.at(0)!.planId;
      this.planIds.add(planId);

      const agentEntry = {
        timestamp: new Date().toISOString(),
        agentId,
        sessionId: this.sessionId,
        role: 'agent' as const,
        text: response.messages.at(0)?.message,
        raw: response.messages,
      };
      const agentTurn = ++this.turnCounter;
      await logTurnToHistory(agentEntry, agentTurn, this.historyDir, this.historyBuffer);

      // Fetch and write trace immediately if available
      if (planId) {
        await recordTraceForTurn(this.historyDir, agentTurn, planId, undefined, this.historyBuffer);
      }

      // Flush buffer to keep turn-index.json and metadata.json up to date
      await this.historyBuffer.flush();

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

  private async setAgentStatus(desiredState: 'Active' | 'Inactive', version?: number): Promise<BotVersionMetadata> {
    const botMetadata = await this.getBotMetadata();

    const botVersionMetadata = await this.getBotVersionMetadata(version);

    if (botMetadata.IsDeleted) {
      throw messages.createError('agentIsDeleted', [botMetadata.DeveloperName]);
    }

    if (botVersionMetadata.Status === desiredState) {
      return botVersionMetadata;
    }

    const url = `/connect/bot-versions/${botVersionMetadata.Id}/activation`;
    const maybeMock = new MaybeMock(this.connection);
    const response = await maybeMock.request<BotActivationResponse>('POST', url, { status: desiredState });
    if (response.success) {
      const versionToUpdate = this.botMetadata!.BotVersions.records.find(
        (v) => v.DeveloperName === botVersionMetadata.DeveloperName
      );
      if (versionToUpdate) {
        versionToUpdate.Status = response.isActivated ? 'Active' : 'Inactive';
      }
    } else {
      throw messages.createError('agentActivationError', [response.messages?.toString() ?? 'unknown']);
    }

    return botVersionMetadata;
  }

  private async startPreview(apexDebugging?: boolean): Promise<AgentPreviewStartResponse> {
    if (!this.id) {
      await this.getId();
    }
    const url = `${this.apiBase}/agents/${this.id!}/sessions`;
    // Use the provided apexDebugging parameter if given, otherwise keep the previously set one
    if (apexDebugging !== undefined) {
      this.apexDebugging = apexDebugging;
    }

    const body = {
      externalSessionKey: randomUUID(),
      instanceConfig: {
        endpoint: this.options.connection.instanceUrl,
      },
      streamingCapabilities: {
        chunkTypes: ['Text'],
      },
      bypassUser: true,
    };

    try {
      const response = await requestWithEndpointFallback<AgentPreviewStartResponse>(this.connection, {
        method: 'POST',
        url,
        body: JSON.stringify(body),
        headers: {
          'x-client-name': 'afdx',
        },
      });
      this.sessionId = response.sessionId;

      const agentId = this.id!;
      this.historyDir = await getHistoryDir(agentId, response.sessionId);
      const startTime = new Date().toISOString();

      // Initialize history buffer (no file I/O yet)
      this.historyBuffer = new SessionHistoryBuffer(this.historyDir, response.sessionId, agentId, startTime);
      this.turnCounter = 0;

      const initialEntry = {
        timestamp: startTime,
        agentId,
        sessionId: response.sessionId,
        role: 'agent' as const,
        text: response.messages.map((m) => m.message).join('\n'),
        raw: response.messages,
      };
      await logTurnToHistory(initialEntry, ++this.turnCounter, this.historyDir, this.historyBuffer);

      // Write turn-index.json and metadata.json immediately so they exist after session start
      await this.historyBuffer.flush();

      const agentDir = await getAgentIndexDir(agentId);
      await logSessionToIndex(agentDir, {
        sessionId: response.sessionId,
        startTime,
        simulated: false,
        agentId,
      });

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  /**
   * Ends an interactive session with the agent.
   *
   * @param sessionId A session ID provided by first calling `agentPreview.start()`.
   * @param reason A reason why the interactive session was ended.
   * @returns `AgentPreviewEndResponse`
   */
  private async endSession(reason: EndReason): Promise<AgentPreviewEndResponse> {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'please call .start() first' });
    }
    if (!this.id) {
      throw SfError.create({ name: 'noId', message: 'please call .getId() first' });
    }
    const url = `${this.apiBase}/sessions/${this.sessionId}`;
    try {
      // https://developer.salesforce.com/docs/einstein/genai/guide/agent-api-examples.html#end-session
      const response = await requestWithEndpointFallback<AgentPreviewEndResponse>(this.connection, {
        method: 'DELETE',
        url,
        headers: {
          'x-session-end-reason': reason,
        },
      });

      // Write end entry and flush buffer
      if (this.historyDir && this.historyBuffer) {
        const endTime = new Date().toISOString();
        const endEntry = {
          timestamp: endTime,
          agentId: this.id,
          sessionId: this.sessionId,
          role: 'agent' as const,
          reason,
          raw: response.messages,
        };
        await logTurnToHistory(endEntry, ++this.turnCounter, this.historyDir, this.historyBuffer);

        // Flush all buffered data to disk (turn-index.json and metadata.json)
        await this.historyBuffer.flush(endTime);
      }

      // Clear session data for next session
      this.sessionId = undefined;
      this.historyDir = undefined;
      this.historyBuffer = undefined;
      this.planIds = new Set<string>();

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }
}
