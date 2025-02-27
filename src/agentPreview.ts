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

type ApiStatus = {
  status: 'UP' | 'DOWN';
};

type Href = { href: string };

export type AgentPreviewError = {
  status: number;
  path: string;
  requestId: string;
  error: string;
  message: string;
  timestamp: number;
};

export type AgentPreviewMessageLinks = {
  self: Href | null;
  messages: Href | null;
  session: Href | null;
  end: Href | null;
};

export type MessageType =
  | 'Inform'
  | 'TextChunk'
  | 'ProgressIndicator'
  | 'Inquire'
  | 'Confirm'
  | 'Failure'
  | 'Escalate'
  | 'SessionEnded'
  | 'EndOfTurn'
  | 'Error';

export type AgentPreviewMessage = {
  type: MessageType;
  id: string;
  feedbackId: string;
  planId: string;
  isContentSafe: boolean;
  message: string;
  result: {
    type: string;
    property: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
  };
  citedReferences: {
    type: string;
    value: string;
  };
};

export type AgentPreviewStartResponse = {
  sessionId: string;
  _links: AgentPreviewMessageLinks;
  messages: AgentPreviewMessage[];
};

export type AgentPreviewSendResponse = {
  messages: AgentPreviewMessage[];
  _links: AgentPreviewMessageLinks;
};

export type AgentPreviewEndResponse = {
  messages: {
    type: string;
    id: string;
    reason: string;
    feedbackId: string;
  };
  _links: AgentPreviewMessageLinks;
};

type EndReason = 'UserRequest' | 'Transfer' | 'Expiration' | 'Error' | 'Other';

export class AgentPreview {
  private apiBase: string;
  private instanceUrl: string;
  private maybeMock: MaybeMock;

  public constructor(connection: Connection) {
    this.apiBase = 'https://api.salesforce.com/einstein/ai-agent/v1';
    this.instanceUrl = connection.instanceUrl;
    this.maybeMock = new MaybeMock(connection);
  }

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

  // Get the status of the Agent API (UP | DOWN)
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
