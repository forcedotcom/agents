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
  appendTranscriptToHistory,
  writeMetaFileToHistory,
  updateMetadataEndTime,
  writeTraceToHistory,
  getEndpoint,
  getHistoryDir,
  getAllHistory,
  TranscriptEntry,
  logSessionToIndex,
  getAgentIndexDir,
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

  public constructor(private options: ProductionAgentOptions) {
    super(options.connection);
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

  private get apiBase(): string {
    return `https://${getEndpoint(this.connection.instanceUrl)}api.salesforce.com/einstein/ai-agent/v1`;
  }

  public async getBotMetadata(): Promise<BotMetadata> {
    if (!this.botMetadata) {
      const whereClause = this.id ? `Id = '${this.id}'` : `DeveloperName = '${this.apiName!}'`;
      const botDefinitionFields =
        'Id, IsDeleted, DeveloperName, MasterLabel, CreatedDate, CreatedById, LastModifiedDate, LastModifiedById, SystemModstamp, BotUserId, Description, Type, AgentType, AgentTemplate';
      const botVersionFields =
        'Id, Status, IsDeleted, BotDefinitionId, DeveloperName, CreatedDate, CreatedById, LastModifiedDate, LastModifiedById, SystemModstamp, VersionNumber, CopilotPrimaryLanguage, ToneType, CopilotSecondaryLanguages';
      this.botMetadata = await this.connection.singleRecordQuery<BotMetadata>(
        `SELECT ${botDefinitionFields}, (SELECT ${botVersionFields} FROM BotVersions ORDER BY VersionNumber) FROM BotDefinition WHERE ${whereClause} LIMIT 1`
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
    return botVersions[botVersions.length - 1];
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
   * @returns void
   */
  public async activate(): Promise<void> {
    return this.setAgentStatus('Active');
  }

  /**
   * Deactivates the agent.
   *
   * @returns void
   */
  public async deactivate(): Promise<void> {
    return this.setAgentStatus('Inactive');
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

      void appendTranscriptToHistory(
        {
          timestamp: new Date().toISOString(),
          agentId,
          sessionId: this.sessionId,
          role: 'user',
          text: message,
        },
        this.historyDir
      );

      let response: AgentPreviewSendResponse;
      try {
        response = await this.connection.request<AgentPreviewSendResponse>({
          method: 'POST',
          url,
          body: JSON.stringify(body),
          headers: {
            'x-client-name': 'afdx',
          },
        });
      } catch (error) {
        const errorName = (error as { name?: string })?.name ?? '';
        if (errorName.includes('404')) {
          throw SfError.create({
            name: 'AgentApiNotFound',
            message: `Preview Send API returned 404. Endpoint is chosen from instance URL (${this.connection.instanceUrl}). Workspace (.crm.dev)→dev.api; OrgFarm (test1/sdb/pc-rnd)→test.api; else→api.`,
            cause: error,
          });
        }
        throw SfError.wrap(error);
      }

      const planId = response.messages.at(0)!.planId;
      this.planIds.add(planId);

      await appendTranscriptToHistory(
        {
          timestamp: new Date().toISOString(),
          agentId,
          sessionId: this.sessionId,
          role: 'agent',
          text: response.messages.at(0)?.message,
          raw: response.messages,
        },
        this.historyDir
      );

      // Fetch and write trace immediately if available
      if (planId) {
        try {
          const trace = await this.getTrace(planId);
          await writeTraceToHistory(planId, trace, this.historyDir);
        } catch (error) {
          throw SfError.wrap(error);
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

  private async setAgentStatus(desiredState: 'Active' | 'Inactive'): Promise<void> {
    const botMetadata = await this.getBotMetadata();
    const latestBotVersionMetadata = await this.getLatestBotVersionMetadata();

    if (botMetadata.IsDeleted) {
      throw messages.createError('agentIsDeleted', [botMetadata.DeveloperName]);
    }

    if (latestBotVersionMetadata.Status === desiredState) {
      return;
    }

    const url = `/connect/bot-versions/${latestBotVersionMetadata.Id}/activation`;
    const maybeMock = new MaybeMock(this.connection);
    const response = await maybeMock.request<BotActivationResponse>('POST', url, { status: desiredState });
    if (response.success) {
      const versionToUpdate = this.botMetadata!.BotVersions.records.find(
        (v) => v.DeveloperName === latestBotVersionMetadata.DeveloperName
      );
      if (versionToUpdate) {
        versionToUpdate.Status = response.isActivated ? 'Active' : 'Inactive';
      }
    } else {
      throw messages.createError('agentActivationError', [response.messages?.toString() ?? 'unknown']);
    }
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
      let response: AgentPreviewStartResponse;
      try {
        response = await this.connection.request<AgentPreviewStartResponse>({
          method: 'POST',
          url,
          body: JSON.stringify(body),
          headers: {
            'x-client-name': 'afdx',
          },
        });
      } catch (error) {
        const errorName = (error as { name?: string })?.name ?? '';
        if (errorName.includes('404')) {
          throw SfError.create({
            name: 'AgentApiNotFound',
            message: `Preview Start API returned 404. Endpoint is chosen from instance URL (${this.connection.instanceUrl}). Workspace (.crm.dev)→dev.api; OrgFarm (test1/sdb/pc-rnd)→test.api; else→api.`,
            cause: error,
          });
        }
        throw SfError.wrap(error);
      }
      this.sessionId = response.sessionId;

      const agentId = this.id!;
      this.historyDir = await getHistoryDir(agentId, response.sessionId);
      const startTime = new Date().toISOString();

      await appendTranscriptToHistory(
        {
          timestamp: startTime,
          agentId,
          sessionId: response.sessionId,
          role: 'agent',
          text: response.messages.map((m) => m.message).join('\n'),
          raw: response.messages,
        },
        this.historyDir
      );

      // Write initial metadata
      await writeMetaFileToHistory(this.historyDir, {
        sessionId: response.sessionId,
        agentId,
        startTime,
        apexDebugging: this.apexDebugging,
        planIds: [],
      });

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
      let response: AgentPreviewEndResponse;
      try {
        response = await this.connection.request<AgentPreviewEndResponse>({
          method: 'DELETE',
          url,
          headers: {
            'x-session-end-reason': reason,
          },
        });
      } catch (error) {
        const errorName = (error as { name?: string })?.name ?? '';
        if (errorName.includes('404')) {
          throw SfError.create({
            name: 'AgentApiNotFound',
            message: `Preview End API returned 404. Endpoint is chosen from instance URL (${this.connection.instanceUrl}). Workspace (.crm.dev)→dev.api; OrgFarm (test1/sdb/pc-rnd)→test.api; else→api.`,
            cause: error,
          });
        }
        throw SfError.wrap(error);
      }

      // Write end entry immediately
      if (this.historyDir) {
        await appendTranscriptToHistory(
          {
            timestamp: new Date().toISOString(),
            agentId: this.id,
            sessionId: this.sessionId,
            role: 'agent',
            reason,
            raw: response.messages,
          },
          this.historyDir
        );
        // Update metadata with end time
        await updateMetadataEndTime(this.historyDir, new Date().toISOString(), this.planIds);
      }

      // Clear session data for next session
      this.sessionId = undefined;
      this.historyDir = undefined;
      this.planIds = new Set<string>();

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }
}
