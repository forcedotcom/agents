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
import { appendTranscriptEntry } from './utils';
import { createTraceFlag, findTraceFlag } from './apexUtils';
import { AgentBase, type AgentPreviewInterface } from './agentBase';
Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

export class ProductionAgent extends AgentBase {
  public preview: AgentPreviewInterface;
  private botMetadata: BotMetadata | undefined;
  private id: string | undefined;
  private developerName: string | undefined;

  public constructor(private options: ProductionAgentOptions) {
    super(options.connection);
    if (!options.nameOrId) {
      throw messages.createError('missingAgentNameOrId');
    }

    this.preview = {
      start: (apexDebugging?: boolean): Promise<AgentPreviewStartResponse> => this.startPreview(apexDebugging),
      send: (message: string): Promise<AgentPreviewSendResponse> => this.sendMessage(message),
      getAllTraces: (): Promise<PlannerResponse[]> => this.getAllTracesFromSession(),
      end: (reason: EndReason): Promise<AgentPreviewEndResponse> => this.endSession(reason),
      saveSession: (outputDir?: string): Promise<string> => this.saveSessionToDisc(outputDir),
      setApexDebugging: (apexDebugging: boolean): void => this.setApexDebugging(apexDebugging),
    } as AgentPreviewInterface;

    if (options.nameOrId.startsWith('0Xx') && [15, 18].includes(options.nameOrId.length)) {
      this.id = options.nameOrId;
    } else {
      this.developerName = options.nameOrId;
    }
  }

  public async getBotMetadata(): Promise<BotMetadata> {
    if (!this.botMetadata) {
      const whereClause = this.id ? `Id = '${this.id}'` : `DeveloperName = '${this.developerName!}'`;
      this.botMetadata = await this.connection.singleRecordQuery<BotMetadata>(
        `SELECT FIELDS(ALL), (SELECT FIELDS(ALL) FROM BotVersions LIMIT 10) FROM BotDefinition WHERE ${whereClause} LIMIT 1`
      );
      this.id = this.botMetadata.Id;
      this.developerName = this.botMetadata.DeveloperName;
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
      });
      this.sessionId = response.sessionId;
      // Store initial agent messages (welcome, etc.) for later writing
      this.transcriptEntries.push({
        timestamp: new Date().toISOString(),
        agentId: this.id!,
        sessionId: response.sessionId,
        role: 'agent',
        text: response.messages.map((m) => m.message).join('\n'),
        raw: response.messages,
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
      const response = await this.connection.request<AgentPreviewEndResponse>({
        method: 'DELETE',
        url,
        headers: {
          'x-session-end-reason': reason,
        },
      });

      // Add end reason entry
      this.transcriptEntries.push({
        timestamp: new Date().toISOString(),
        agentId: this.id,
        sessionId: this.sessionId,
        role: 'agent',
        reason,
        raw: response.messages,
      });

      // Write all transcript entries at once (sequential to preserve order)
      for (let i = 0; i < this.transcriptEntries.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        await appendTranscriptEntry(this.transcriptEntries[i], i === 0);
      }

      // Clear transcript entries for next session
      this.transcriptEntries = [];

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }
}
