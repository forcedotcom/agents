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
import { randomUUID } from 'node:crypto';
import { Messages, SfError } from '@salesforce/core';
import { env } from '@salesforce/kit';
import {
  type AgentPreviewEndResponse,
  type AgentPreviewSendResponse,
  type AgentPreviewStartResponse,
  type BotActivationResponse,
  type BotMetadata,
  type BotVersionMetadata,
  type EndReason,
  PlannerResponse,
  ProductionAgentOptions,
} from './types';
import { MaybeMock } from './maybe-mock';
import { getSessionDir, appendTranscriptEntryToSession, writeMetadataToSession, updateMetadataEndTime } from './utils';
import { createTraceFlag, findTraceFlag } from './apexUtils';
import { AgentInteractionBase, type AgentPreviewInterface } from './agentInteractionBase';
Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

export class ProductionAgent extends AgentInteractionBase {
  public preview: AgentPreviewInterface;
  private botMetadata: BotMetadata | undefined;
  private id: string | undefined;
  private apiName: string | undefined;
  private apiBase = `https://${env.getBoolean('SF_TEST_API') ? 'test.' : ''}api.salesforce.com/einstein/ai-agent/v1`;

  public constructor(private options: ProductionAgentOptions) {
    super(options.connection);
    if (!options.apiNameOrId) {
      throw messages.createError('missingAgentNameOrId');
    }

    this.preview = {
      start: (apexDebugging?: boolean): Promise<AgentPreviewStartResponse> => this.startPreview(apexDebugging),
      send: (message: string): Promise<AgentPreviewSendResponse> => this.sendMessage(message),
      getAllTraces: (): Promise<PlannerResponse[]> => this.getAllTracesFromSession(),
      end: (reason: EndReason): Promise<AgentPreviewEndResponse> => this.endSession(reason),
      saveSession: (outputDir: string): Promise<string> => this.saveSessionToDisc(outputDir),
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
      this.botMetadata = await this.connection.singleRecordQuery<BotMetadata>(
        `SELECT FIELDS(ALL), (SELECT FIELDS(ALL) FROM BotVersions LIMIT 10) FROM BotDefinition WHERE ${whereClause} LIMIT 1`
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

  protected getAgentIdForStorage(): string {
    if (!this.id) {
      throw SfError.create({ name: 'noId', message: 'Agent ID not found. Call .getBotMetadata() first.' });
    }
    return this.id;
  }

  protected getTraceUrl(traceId: string): string {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'Session not started' });
    }
    return `${this.connection.baseUrl()}:9443/proxy/worker/internal/sessions/${this.sessionId}/plans/${traceId}`;
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

  protected getSendMessageUrl(): string {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'Session not started' });
    }
    return `${this.apiBase}/sessions/${this.sessionId}/messages`;
  }

  private async setAgentStatus(desiredState: 'Active' | 'Inactive'): Promise<void> {
    const botMetadata = await this.getBotMetadata();
    const botVersionMetadata = await this.getLatestBotVersionMetadata();

    if (botMetadata.IsDeleted) {
      throw messages.createError('agentIsDeleted', [botMetadata.DeveloperName]);
    }

    if (botVersionMetadata.Status === desiredState) {
      return;
    }

    const url = `/connect/bot-versions/${botVersionMetadata.Id}/activation`;
    const maybeMock = new MaybeMock(this.connection);
    const response = await maybeMock.request<BotActivationResponse>('POST', url, { status: desiredState });
    if (response.success) {
      this.botMetadata!.BotVersions.records[0].Status = response.isActivated ? 'Active' : 'Inactive';
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
      const response = await this.connection.request<AgentPreviewStartResponse>({
        method: 'POST',
        url,
        body: JSON.stringify(body),
        headers: {
          'x-client-name': 'afdx',
        },
      });
      this.sessionId = response.sessionId;

      // Initialize session directory and write initial data
      // Session directory structure:
      // .sfdx/agents/<agentId>/sessions/<sessionId>/
      // ├── transcript.jsonl    # All transcript entries (one per line)
      // ├── traces/             # Individual trace files
      // │   ├── <planId1>.json
      // │   └── <planId2>.json
      // └── metadata.json       # Session metadata (start time, end time, planIds, etc.)
      const agentId = this.id!;
      this.sessionDir = await getSessionDir(agentId, response.sessionId);

      await appendTranscriptEntryToSession(
        {
          timestamp: new Date().toISOString(),
          agentId,
          sessionId: response.sessionId,
          role: 'agent',
          text: response.messages.map((m) => m.message).join('\n'),
          raw: response.messages,
        },
        this.sessionDir
      );

      // Write initial metadata
      await writeMetadataToSession(this.sessionDir, {
        sessionId: response.sessionId,
        agentId,
        startTime: new Date().toISOString(),
        apexDebugging: this.apexDebugging,
        planIds: [],
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
    const url = `${this.apiBase}/v1.1/sessions/${this.sessionId}`;
    try {
      // https://developer.salesforce.com/docs/einstein/genai/guide/agent-api-examples.html#end-session
      const response = await this.connection.request<AgentPreviewEndResponse>({
        method: 'DELETE',
        url,
        headers: {
          'x-session-end-reason': reason,
        },
      });

      // Write end entry immediately
      if (this.sessionDir) {
        await appendTranscriptEntryToSession(
          {
            timestamp: new Date().toISOString(),
            agentId: this.id,
            sessionId: this.sessionId,
            role: 'agent',
            reason,
            raw: response.messages,
          },
          this.sessionDir
        );
        // Update metadata with end time
        await updateMetadataEndTime(this.sessionDir, new Date().toISOString(), this.planIds);
      }

      // Clear session data for next session
      this.sessionId = undefined;
      this.sessionDir = undefined;
      this.planIds = new Set<string>();

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }
}
