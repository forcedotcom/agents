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

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Connection, Lifecycle, SfError } from '@salesforce/core';
import { env } from '@salesforce/kit';
import { Agent } from './agent';
import { AgentPreviewBase } from './agentPreviewBase';
import {
  type AgentJson,
  type AgentPreviewEndResponse,
  type AgentPreviewSendResponse,
  type AgentPreviewStartResponse,
  PlannerResponse,
} from './types.js';
import { createTraceFlag, findTraceFlag, getDebugLog } from './apexUtils';
import { appendTranscriptEntry } from './utils';

/**
 * A service to simulate interactions with an agent using a local .agent file.
 * The file will be compiled using Agent.compileAgent before being used
 * with the simulation endpoints.
 *
 * **Examples**
 *
 * Create an instance of the service:
 *
 * `const agentSimulate = new AgentSimulate(connection, './path/to/agent.agent');`
 *
 * Start an interactive session:
 *
 * `const { sessionId } = await agentSimulate.start();`
 *
 * Send a message to the agent using the session ID from the startResponse:
 *
 * `const sendResponse = await agentSimulate.send(sessionId, message);`
 *
 * End an interactive session:
 *
 * `await agentSimulate.end(sessionId, 'UserRequest');`
 *
 * Enable Apex Debug Mode:
 *
 * `agentSimulate.toggleApexDebugMode(true);`
 */
export class AgentSimulate extends AgentPreviewBase {
  /**
   * The client can specify whether the actions will run in a simulated mode ("mock actions", no side effects, mockActions=true) or a non-simulated mode ("real actions", actions with side effects, mockActions=false)
   */
  public mockActions: boolean;
  protected readonly apiBase = `https://${
    env.getBoolean('SF_TEST_API') ? 'test.' : ''
  }api.salesforce.com/einstein/ai-agent`;
  private readonly agentFilePath: string;
  private compiledAgent?: AgentJson;

  /**
   * Create an instance of the service.
   *
   * @param connection The connection to use to make requests.
   * @param agentFilePath Path to the .agent file to simulate.
   * @param mockActions whether or not to mock the actions of the simulated agent
   */
  public constructor(connection: Connection, agentFilePath: string, mockActions: boolean) {
    super({ connection });
    this.agentFilePath = agentFilePath;
    this.mockActions = mockActions;
  }

  /**
   * Start an interactive simulation session with the agent.
   * This will first compile the agent script if it hasn't been compiled yet.
   *
   * @returns `AgentPreviewStartResponse`, which includes a session ID needed for other actions.
   */
  public async start(): Promise<AgentPreviewStartResponse> {
    if (!this.compiledAgent) {
      void Lifecycle.getInstance().emit('agents:compiling', {});
      this.logger.debug(`Compiling agent script from ${this.agentFilePath}`);
      const agentString = await readFile(this.agentFilePath, 'utf-8');
      const compiledAgent = await Agent.compileAgentScript(this.connection, agentString);
      if (compiledAgent.status === 'success' && compiledAgent.compiledArtifact) {
        this.compiledAgent = compiledAgent.compiledArtifact;
      } else {
        const formattedError = compiledAgent.errors
          .map((e) => `- ${e.errorType} ${e.description}: ${e.lineStart}:${e.colStart} / ${e.lineEnd}:${e.colEnd}`)
          .join('\n');
        throw new SfError('Failed to compile agent script', formattedError);
      }
    }

    this.logger.debug('Starting agent simulation session');

    const body = {
      agentDefinition: this.compiledAgent,
      enableSimulationMode: this.mockActions,
      externalSessionKey: randomUUID(),
      instanceConfig: {
        endpoint: this.connection.instanceUrl,
      },
      variables: [],
      parameters: {},
      streamingCapabilities: {
        chunkTypes: ['Text', 'LightningChunk'],
      },
      richContentCapabilities: {},
      bypassUser: true,
      executionHistory: [],
      conversationContext: [],
    };

    try {
      void Lifecycle.getInstance().emit('agents:simulation-starting', {});
      const response = await this.maybeMock.request<AgentPreviewStartResponse>(
        'POST',
        `${this.apiBase}/v1.1/preview/sessions`,
        body
      );
      const agentIdForStorage = basename(this.agentFilePath);

      await appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        agentId: agentIdForStorage,
        sessionId: response.sessionId,
        role: 'agent',
        text: response.messages.map((m) => m.message).join('\n'),
        raw: response.messages,
        event: 'start',
      });
      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  /**
   * Send a message to the agent using the session ID obtained by calling `start()`.
   *
   * @param sessionId A session ID provided by first calling `agentSimulate.start()`.
   * @param message A message to send to the agent.
   * @returns `AgentPreviewSendResponse`
   */
  public async send(sessionId: string, message: string): Promise<AgentPreviewSendResponse> {
    if (!this.compiledAgent) {
      throw new SfError('Agent not compiled, please call .start() first');
    }
    const url = `${this.apiBase}/v1.1/preview/sessions/${sessionId}/messages`;
    const body = {
      message: {
        sequenceId: Date.now(),
        type: 'Text',
        text: message,
      },
      variables: [],
    };
    this.logger.debug(`Sending message with apexDebugMode ${this.apexDebugMode ? 'enabled' : 'disabled'}`);
    const agentIdForStorage = basename(this.agentFilePath);

    try {
      const start = Date.now();
      if (this.apexDebugMode && !this.mockActions) {
        await this.ensureTraceFlag();
      }
      await appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        agentId: agentIdForStorage,
        sessionId,
        role: 'user',
        text: message,
      });
      const response = await this.maybeMock.request<AgentPreviewSendResponse>('POST', url, body);

      await appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        agentId: agentIdForStorage,
        sessionId,
        role: 'agent',
        text: response.messages.map((m) => m.message).join('\n'),
        raw: response.messages,
      });
      if (this.apexDebugMode && !this.mockActions) {
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
   * Ending is not required, or supported, for AgentSimulation
   * this is a noop method to support easier consumer typings
   *
   * @returns `AgentPreviewEndResponse`
   */
  // eslint-disable-next-line class-methods-use-this
  public async end(): Promise<AgentPreviewEndResponse> {
    return Promise.resolve({ messages: [], _links: [] } as unknown as AgentPreviewEndResponse);
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

  public async trace(sessionId: string, messageId: string): Promise<PlannerResponse> {
    return this.maybeMock.request<PlannerResponse>(
      'GET',
      `${this.apiBase}/v1.1/preview/sessions/${sessionId}/plans/${messageId}`
    );
  }

  // once we're previewing agents in the org, with mockActions = false, we'll have to figure out how to get the correct user that was simulated for apex invocattion
  private async ensureTraceFlag(): Promise<void> {
    if (this.apexTraceFlag) {
      const expDate = this.apexTraceFlag.ExpirationDate;
      if (expDate && new Date(expDate) > new Date()) {
        this.logger.debug(`Using cached apexTraceFlag with ExpirationDate of ${expDate}`);
        return;
      } else {
        this.logger.debug('Cached apex trace flag is expired');
      }
    }

    const user = this.compiledAgent?.globalConfiguration.defaultAgentUser ?? this.connection.getUsername()!;

    const userId = (
      await this.connection.singleRecordQuery<{ Id: string }>(`SELECT Id FROM Users WHERE Name = '${user}'`)
    ).Id;

    this.apexTraceFlag = await findTraceFlag(this.connection, userId);
    if (!this.apexTraceFlag) {
      await createTraceFlag(this.connection, userId);
    }
  }
}
