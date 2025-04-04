/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { randomUUID } from 'node:crypto';
import { SfError } from '@salesforce/core';
import { Connection } from '@salesforce/core';
import { MaybeMock } from './maybe-mock';
import {
  type AgentPreviewEndResponse,
  type AgentPreviewStartResponse,
  type AgentPreviewSendResponse,
  type ApiStatus,
  type EndReason,
} from './types.js';

/**
 * A service to interact with an agent. Start an interactive session,
 * send messages to the agent, and end the session.
 *
 * **Examples**
 *
 * Create an instance of the service:
 *
 * `const agentPreview = new AgentPreview(connection);`
 *
 * Start an interactive session:
 *
 * `const { sessionId } = await agentPreview.start(botId);`
 *
 * Send a message to the agent using the session ID from the startResponse:
 *
 * `const sendResponse = await agentPreview.send(sessionId, message);`
 *
 * End an interactive session:
 *
 * `await agentPreview.end(sessionId, 'UserRequest');`
 */
export class AgentPreview {
  private apiBase: string;
  private instanceUrl: string;
  private maybeMock: MaybeMock;

  public constructor(connection: Connection) {
    this.apiBase = 'https://api.salesforce.com/einstein/ai-agent/v1';
    this.instanceUrl = connection.instanceUrl;
    this.maybeMock = new MaybeMock(connection);
  }

  /**
   * Start an interactive session with the provided agent.
   *
   * @param botId The ID of the agent (`Bot` ID).
   * @returns `AgentPreviewStartResponse`, which includes a session ID needed for other actions.
   */
  public async start(botId: string): Promise<AgentPreviewStartResponse> {
    const url = `${this.apiBase}/agents/${botId}/sessions`;

    const body = {
      externalSessionKey: randomUUID(),
      instanceConfig: {
        endpoint: this.instanceUrl,
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

    try {
      return await this.maybeMock.request<AgentPreviewSendResponse>('POST', url, body);
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

    try {
      // https://developer.salesforce.com/docs/einstein/genai/guide/agent-api-examples.html#end-session
      return await this.maybeMock.request<AgentPreviewEndResponse>('DELETE', url, undefined, {
        'x-session-end-reason': reason,
      });
    } catch (err) {
      throw SfError.wrap(err);
    }
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
}
