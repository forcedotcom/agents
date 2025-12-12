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
import { appendTranscriptEntry } from './utils';
import { getDebugLog } from './apexUtils';
Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

export default class ProductionAgent {
  private botMetadata: BotMetadata | undefined;
  private id: string | undefined;
  private name: string | undefined;
  private readonly apiBase = `https://${
    env.getBoolean('SF_TEST_API') ? 'test.' : ''
  }api.salesforce.com/einstein/ai-agent`;
  private planIds = new Set<string>();
  private preview: {
    start: (apexDebugging: boolean) => Promise<AgentPreviewStartResponse>;
    send: (message: string) => Promise<AgentPreviewSendResponse>;
    getAllTraces: () => Promise<PlannerResponse[]>;
    end: (reason: EndReason) => Promise<AgentPreviewEndResponse>;
  };
  private sessionId: string | undefined;
  private apexDebugging: boolean | undefined;
  public constructor(private options: ProductionAgentOptions) {
    if (!options.nameOrId) {
      throw messages.createError('missingAgentNameOrId');
    }

    this.preview = {
      start: (apexDebugging: boolean): Promise<AgentPreviewStartResponse> => this.startPreview(apexDebugging),
      send: (message: string): Promise<AgentPreviewSendResponse> => this.sendMessage(message),
      getAllTraces: (): Promise<PlannerResponse[]> => this.getAllTracesFromSession(),
      end: (reason: EndReason): Promise<AgentPreviewEndResponse> => this.endSession(reason),
    };

    if (options.nameOrId.startsWith('0Xx') && [15, 18].includes(options.nameOrId.length)) {
      this.id = options.nameOrId;
    } else {
      this.name = options.nameOrId;
    }
  }
  /**
   * Queries BotDefinition and BotVersions (limited to 10) for the bot metadata and assigns:
   * 1. this.id
   * 2. this.name
   * 3. this.botMetadata
   * 4. this.botVersionMetadata
   */
  public async getBotMetadata(): Promise<BotMetadata> {
    if (!this.botMetadata) {
      const whereClause = this.id ? `Id = '${this.id}'` : `DeveloperName = '${this.name}'`;
      const query = `SELECT FIELDS(ALL), (SELECT FIELDS(ALL) FROM BotVersions LIMIT 10) FROM BotDefinition WHERE ${whereClause} LIMIT 1`;
      this.botMetadata = await this.options.connection.singleRecordQuery<BotMetadata>(query);
      this.id = this.botMetadata.Id;
      this.name = this.botMetadata.DeveloperName;
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
    const maybeMock = new MaybeMock(this.options.connection);
    const response = await maybeMock.request<BotActivationResponse>('POST', url, { status: desiredState });
    if (response.success) {
      this.botMetadata!.BotVersions.records[0].Status = response.isActivated ? 'Active' : 'Inactive';
    } else {
      throw messages.createError('agentActivationError', [response.messages?.toString() ?? 'unknown']);
    }
  }

  private async startPreview(apexDebugging: boolean): Promise<AgentPreviewStartResponse> {
    if (!this.id) {
      throw SfError.create({ name: 'no Id found', message: 'please call .getId() first' });
    }
    const url = `${this.apiBase}/agents/${this.id}/sessions`;
    this.apexDebugging = apexDebugging;

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
      const response = await this.options.connection.request<AgentPreviewStartResponse>({
        method: 'POST',
        url,
        body: JSON.stringify(body),
      });
      // Persist any initial agent messages (welcome, etc.)

      await appendTranscriptEntry(
        {
          timestamp: new Date().toISOString(),
          agentId: this.id,
          sessionId: response.sessionId,
          role: 'agent',
          text: response.messages.map((m) => m.message).join('\n'),
          raw: response.messages,
        },
        true
      );

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  private async sendMessage(message: string) {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'no sessionId, call .start() first' });
    }
    if (!this.id) {
      throw SfError.create({ name: 'noId', message: 'please call .getId() first' });
    }
    const url = `${this.apiBase}/sessions/${this.sessionId}/messages`;
    const body = {
      message: {
        // https://developer.salesforce.com/docs/einstein/genai/guide/agent-api-examples.html#send-synchronous-messages
        // > A number that you provide to represent the sequence ID. Increase this number for each subsequent message in this session.
        sequenceId: Date.now(),
        type: 'Text',
        text: message,
      },
      variables: [],
    };

    try {
      // If apex debug mode is enabled, ensure we have a trace flag for the bot user and
      // if there isn't one, create one.
      const start = Date.now();
      if (this.apexDebugging) {
        await this.ensureTraceFlag();
      }
      const response = await this.options.connection.request<AgentPreviewSendResponse>({
        method: 'POST',
        url,
        body: JSON.stringify(body),
      });
      this.planIds.add(response.messages.at(0)!.planId);
      // Save user entry
      await appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        agentId: this.id,
        sessionId: this.sessionId,
        role: 'user',
        text: message,
      });
      // Save agent response entry
      const agentText = (response.messages ?? [])
        .map((m) => m.message)
        .filter(Boolean)
        .join('\n');
      await appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        agentId: this.id,
        sessionId: this.sessionId,
        role: 'agent',
        text: agentText || undefined,
        raw: response.messages,
      });
      if (this.apexDebugging) {
        // get apex debug logs and look for a log within the start and end time
        const apexLog = await getDebugLog(this.options.connection, start, Date.now());
        if (apexLog) {
          response.apexDebugLog = apexLog;
        }
      }

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  private async getAllTracesFromSession(): Promise<PlannerResponse[]> {
    if (!this.sessionId) {
      throw SfError.create({ message: 'Session never created' });
    }
    const promises: Array<Promise<PlannerResponse>> = [];
    for (const id of this.planIds) {
      promises.push(
        this.options.connection.request<PlannerResponse>({
          method: 'GET',
          url: `${this.options.connection.baseUrl()}:9443/proxy/worker/internal/sessions/${this.sessionId}/plans/${id}`,
          headers: {
            'x-client-name': 'afdx',
          },
        })
      );
    }

    return Promise.all(promises);
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
      const response = await this.options.connection.request<AgentPreviewEndResponse>({
        method: 'DELETE',
        url,
        headers: {
          'x-session-end-reason': reason,
        },
      });
      await appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        agentId: this.id,
        sessionId: this.sessionId,
        role: 'agent',
        reason,
        raw: response.messages,
      });
      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }
}
