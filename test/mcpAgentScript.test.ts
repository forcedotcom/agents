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

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { McpAgentScript } from '../src/mcpAgentScript';

describe('McpAgentScript client', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let requests: Array<{ method?: string; url?: string; body?: string; headers?: Record<string, string> }>;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    await $$.stubAuths(testOrg);
    connection = await testOrg.getConnection();
    requests = [];
  });

  afterEach(() => {
    $$.restore();
  });

  function mockRequest(response: any): void {
    $$.fakeConnectionRequest = (req: any) => {
      requests.push(req);
      return Promise.resolve(response);
    };
  }

  describe('generateActions', () => {
    it('POSTs {toolIds} to the connect agent-script path, not /api-catalog, at v68.0 or later', async () => {
      mockRequest({ actions: [] });
      await McpAgentScript.generateActions(connection, ['1XO1', '1XO2']);
      expect(requests[0].method).to.equal('POST');
      expect(requests[0].url).to.match(/\/services\/data\/v\d+\.0\/connect\/genai-mcp\/agent-script\/actions$/);
      expect(requests[0].url).to.not.include('api-catalog');
      expect(Number(/\/v(\d+)\./.exec(requests[0].url as string)?.[1])).to.be.at.least(68);
      expect(JSON.parse(requests[0].body as string)).to.deep.equal({ toolIds: ['1XO1', '1XO2'] });
    });

    it('asks Connect not to HTML-encode the returned blocks', async () => {
      mockRequest({ actions: [] });
      await McpAgentScript.generateActions(connection, ['1XO1']);
      expect(requests[0].headers).to.deep.include({ 'X-Chatter-Entity-Encoding': 'false' });
      expect(requests[0].headers?.['Content-Type']).to.match(/json/i);
    });

    it('uses 68.0 when the connection version is lower', async () => {
      mockRequest({ actions: [] });
      connection.setApiVersion('60.0');
      await McpAgentScript.generateActions(connection, ['1XO1']);
      expect(requests[0].url).to.include('/services/data/v68.0/connect/genai-mcp/agent-script/actions');
    });

    it('keeps a higher connection version', async () => {
      mockRequest({ actions: [] });
      connection.setApiVersion('70.0');
      await McpAgentScript.generateActions(connection, ['1XO1']);
      expect(requests[0].url).to.include('/services/data/v70.0/connect/');
    });

    it('rethrows a failed request as an SfError', async () => {
      $$.fakeConnectionRequest = () => Promise.reject(new Error('boom'));
      try {
        await McpAgentScript.generateActions(connection, ['1XO1']);
        expect.fail('expected generateActions to throw');
      } catch (e) {
        expect((e as Error).message).to.equal('boom');
      }
    });
  });
});
