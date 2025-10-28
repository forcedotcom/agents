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

import { Connection, Logger, SfError } from '@salesforce/core';
import { MaybeMock } from './maybe-mock';
import {
  type AgentPreviewEndResponse,
  type AgentPreviewStartResponse,
  type AgentPreviewSendResponse,
  type EndReason,
  type BaseAgentConfig,
  type AgentInteractionBase,
} from './types.js';

/**
 * Abstract base class for agent runners that provides common functionality
 * for interacting with agents through the Einstein AI Agent API.
 */
export abstract class AgentPreviewBase implements AgentInteractionBase {
  protected connection: Connection;
  protected readonly logger: Logger;
  protected readonly maybeMock: MaybeMock;
  protected apexDebugMode?: boolean;

  protected constructor(config: BaseAgentConfig) {
    if (!config.connection) {
      throw new Error('Connection is required');
    }

    // Protected properties
    const connection = config.connection;
    const logger = config.logger ?? Logger.childFromRoot(this.constructor.name);

    // Initialize protected properties
    this.connection = connection;
    this.logger = logger;
    this.maybeMock = new MaybeMock(connection);
  }

  /**
   * Get the base API URL for the agent service.
   * This is overridden by child classes to provide their specific API base.
   */
  protected abstract get apiBase(): string;

  /**
   * Ends an interactive session with the agent.
   * This is the base implementation that child classes can use.
   *
   * @param sessionId A session ID provided by first calling `start()`.
   * @param reason A reason why the interactive session was ended.
   * @returns `AgentPreviewEndResponse`
   */
  protected async endSession(sessionId: string, reason: EndReason): Promise<AgentPreviewEndResponse> {
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
   * This is the base implementation that child classes can use.
   *
   * @param enable Whether to enable or disable Apex Debug Mode.
   */
  protected setApexDebugMode(enable: boolean): void {
    this.apexDebugMode = enable;
    this.logger.debug(`Apex Debug Mode is now ${enable ? 'enabled' : 'disabled'}`);
  }

  /**
   * Start an interactive session with the agent.
   * This is implemented by child classes to provide their specific start logic.
   */
  public abstract start(): Promise<AgentPreviewStartResponse>;

  /**
   * Send a message to the agent using the session ID obtained by calling `start()`.
   *
   * @param sessionId A session ID provided by first calling `start()`.
   * @param message A message to send to the agent.
   * @returns `AgentPreviewSendResponse`
   */
  public abstract send(sessionId: string, message: string): Promise<AgentPreviewSendResponse>;

  /**
   * Ends an interactive session with the agent.
   *
   * @param sessionId A session ID provided by first calling `start()`.
   * @param reason A reason why the interactive session was ended.
   * @returns `AgentPreviewEndResponse`
   */
  public abstract end(sessionId: string, reason: EndReason): Promise<AgentPreviewEndResponse>;

  /**
   * Enable or disable Apex Debug Mode, which will enable trace flags for the Bot user
   * and create apex debug logs for use within VS Code's Apex Replay Debugger.
   *
   * @param enable Whether to enable or disable Apex Debug Mode.
   */
  public abstract toggleApexDebugMode(enable: boolean): void;
}
