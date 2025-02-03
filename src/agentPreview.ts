/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { Connection } from '@salesforce/core';
import { RequestPreview } from './request-preview';

type ApiStatus = {
  status: 'UP' | 'DOWN';
};

type Href = { href: string };

export type AgentPreviewMessageLinks = {
  self: Href | null;
  messages: Href | null;
  session: Href | null;
  end: Href | null;
};

export type AgentPreviewMessage = {
  type: string;
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
  private got: RequestPreview;
  private headers;
  private instanceUrl: string;
  private tempApiBase = process.env.AFDX_TEMP_AGENT_API_BASE as string;

  public constructor(connection: Connection) {
    this.got = new RequestPreview();
    const auth = process.env.AFDX_TEMP_AGENT_API_KEY as string;
    const env = process.env.AFDX_TEMP_AGENT_ENV as string;

    this.instanceUrl = connection.instanceUrl;

    this.headers = {
      'x-sfdc-tenant-id': `core/${env}/${connection.getAuthInfoFields().orgId as string}`,
      'x-salesforce-region': process.env.AFDX_TEMP_AGENT_REGION as string,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `API_KEY ${auth}`,
    };
  }

  public async start(botId: string): Promise<AgentPreviewStartResponse> {
    const url = `${this.tempApiBase}/einstein/ai-agent/v1/agents/${botId}/sessions`;

    const body = {
      // TODO: this needs to generate a unique guid
      externalSessionKey: '44736288-030b-4080-b477-975a60f00a12',
      instanceConfig: {
        endpoint: `${this.instanceUrl}/`,
      },
      streamingCapabilities: {
        chunkTypes: ['Text'],
      },
      variables: [],
    };

    return this.got.request<AgentPreviewStartResponse>('POST', url, body, this.headers);
  }

  public async send(sessionId: string, message: string): Promise<AgentPreviewSendResponse> {
    const url = `${this.tempApiBase}/einstein/ai-agent/v1/sessions/${sessionId}/messages`;

    const body = {
      message: {
        sequenceId: Date.now(),
        type: 'Text',
        text: message,
      },
      variables: [],
    };

    return this.got.request<AgentPreviewSendResponse>('POST', url, body, this.headers);
  }

  public async end(sessionId: string, reason: EndReason): Promise<AgentPreviewEndResponse> {
    const url = `${this.tempApiBase}/einstein/ai-agent/v1/sessions/${sessionId}`;

    return this.got.request<AgentPreviewEndResponse>('DELETE', url, undefined, {
      ...this.headers,
      'x-session-end-reason': reason,
    });
  }

  // Get the status of the Agent API (UP | DOWN)
  public async status(): Promise<ApiStatus> {
    const base = 'https://test.api.salesforce.com';
    const url = `${base}/einstein/ai-agent/v1/status`;

    return this.got.request<ApiStatus>('GET', url, undefined, this.headers);
  }
}
