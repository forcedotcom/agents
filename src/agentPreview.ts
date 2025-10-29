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
import { Connection, Messages, SfError } from '@salesforce/core';
import { Agent } from './agent';
import { AgentPreviewBase } from './agentPreviewBase';
import {
  type AgentPreviewStartResponse,
  type AgentPreviewSendResponse,
  type AgentPreviewEndResponse,
  type ApiStatus,
  type EndReason,
} from './types.js';
import { createTraceFlag, findTraceFlag, getDebugLog } from './apexUtils';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agentPreview');

/**
 * A service to interact with an agent. Start an interactive session,
 * send messages to the agent, and end the session.
 *
 * **Examples**
 *
 * Create an instance of the service:
 *
 * `const agentPreview = new AgentPreview(connection, botId);`
 *
 * Start an interactive session:
 *
 * `const { sessionId } = await agentPreview.start();`
 *
 * Send a message to the agent using the session ID from the startResponse:
 *
 * `const sendResponse = await agentPreview.send(sessionId, message);`
 *
 * End an interactive session:
 *
 * `await agentPreview.end(sessionId, 'UserRequest');`
 *
 * Enable Apex Debug Mode:
 *
 * `agentPreview.toggleApexDebugMode(true);`
 */
export class AgentPreview extends AgentPreviewBase {
  protected readonly apiBase = 'https://api.salesforce.com/einstein/ai-agent/v1';
  private readonly botId: string;

  /**
   * Create an instance of the service.
   *
   * @param connection The connection to use to make requests.
   * @param botId The ID of the agent (`Bot` ID).
   */
  public constructor(connection: Connection, botId: string) {
    super({ connection });
    if (!botId.startsWith('0Xx') || ![15, 18].includes(botId.length)) {
      throw messages.createError('invalidBotId', [botId]);
    }
    this.botId = botId;
  }

  /**
   * Start an interactive session with the agent.
   *
   * @returns `AgentPreviewStartResponse`, which includes a session ID needed for other actions.
   */
  public async start(): Promise<AgentPreviewStartResponse> {
    const url = `${this.apiBase}/agents/${this.botId}/sessions`;
    this.logger.debug(`Starting agent preview session for botId: ${this.botId}`);

    const body = {
      externalSessionKey: randomUUID(),
      instanceConfig: {
        endpoint: this.connection.instanceUrl,
      },
      streamingCapabilities: {
        chunkTypes: ['Text'],
      },
      bypassUser: true,
    };

    try {
      return await this.maybeMock.request<AgentPreviewStartResponse>('POST', url, body);
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  /**
   * Send a message to the agent using the session ID obtained by calling `start()`.
   *
   * @param sessionId A session ID provided by first calling `agentPreview.start()`.
   * @param message A message to send to the agent.
   * @returns `AgentPreviewSendResponse`
   */
  public async send(sessionId: string, message: string): Promise<AgentPreviewSendResponse> {
    const url = `${this.apiBase}/sessions/${sessionId}/messages`;
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
    this.logger.debug(
      `Sending message to botId: ${this.botId} with apexDebugMode ${this.apexDebugMode ? 'enabled' : 'disabled'}`
    );

    try {
      // If apex debug mode is enabled, ensure we have a trace flag for the bot user and
      // if there isn't one, create one.
      const start = Date.now();
      if (this.apexDebugMode) {
        await this.ensureTraceFlag();
      }
      const response = await this.maybeMock.request<AgentPreviewSendResponse>('POST', url, body);
      if (this.apexDebugMode) {
        // get apex debug logs and look for a log within the start and end time
        const apexLog = await getDebugLog(this.connection, start, Date.now());
        if (apexLog) {
          if (apexLog.Id) this.logger.debug(`Apex debug log ID for message is ${apexLog.Id}`);
          response.apexDebugLog = apexLog;
        } else {
          this.logger.debug('No apex debug log found for this message');
        }
      }

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
  public async end(sessionId: string, reason: EndReason): Promise<AgentPreviewEndResponse> {
    const url = `${this.apiBase}/sessions/${sessionId}`;
    this.logger.debug(`Ending agent session with sessionId: ${sessionId}`);
    try {
      return await this.maybeMock.request<AgentPreviewEndResponse>('DELETE', url, undefined, {
        'x-session-end-reason': reason,
      });
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  /**
   * Enable or disable Apex Debug Mode, which will enable trace flags for the Bot user
   * and create apex debug logs for use within VS Code's Apex Replay Debugger.
   *
   * @param enable Whether to enable or disable Apex Debug Mode.
   */
  public toggleApexDebugMode(enable: boolean): void {
    this.setApexDebugMode(enable);
  }

  /**
   * Get the status of the Agent API (UP | DOWN).
   *
   * @returns `ApiStatus`
   */
  public async status(): Promise<ApiStatus> {
    const base = 'https://test.api.salesforce.com';
    const url = `${base}/einstein/ai-agent/v1/status`;

    try {
      return await this.maybeMock.request<ApiStatus>('GET', url);
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  private async getBotUserId(): Promise<string | null> {
    const agent = new Agent({ connection: this.connection, nameOrId: this.botId });
    const botMetadata = await agent.getBotMetadata();
    return botMetadata?.BotUserId ?? null;
  }

  private async ensureTraceFlag(): Promise<void> {
    if (this.apexTraceFlag?.ExpirationDate) {
      const expDate = new Date(this.apexTraceFlag.ExpirationDate).getTime();
      if (expDate > Date.now()) {
        this.logger.debug(`Using cached apexTraceFlag with ExpirationDate of ${this.apexTraceFlag.ExpirationDate}`);
        return;
      } else {
        this.logger.debug('Cached apex trace flag is expired');
        this.apexTraceFlag = undefined;
      }
    }

    const userId = await this.getBotUserId();
    if (!userId) {
      throw messages.createError('agentApexDebuggingError');
    }
    this.apexTraceFlag = await findTraceFlag(this.connection, userId);
    if (!this.apexTraceFlag) {
      await createTraceFlag(this.connection, userId);
    }
  }
}
