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

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */

import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { ApiCatalog } from '../src/apiCatalog';

describe('ApiCatalog client', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let requests: Array<{ method?: string; url?: string; body?: string }>;

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

  describe('listMcpServers', () => {
    it('GETs /mcp-servers and forwards filters', async () => {
      mockRequest({ mcpServers: [] });
      await ApiCatalog.listMcpServers(connection, { label: 'foo', type: 'EXTERNAL', status: 'ACTIVE' });
      expect(requests[0].method).to.equal('GET');
      expect(requests[0].url).to.include('label=foo');
      expect(requests[0].url).to.include('type=EXTERNAL');
      expect(requests[0].url).to.include('status=ACTIVE');
    });

    it('GETs /mcp-servers without a query string when no filters', async () => {
      mockRequest({ mcpServers: [] });
      await ApiCatalog.listMcpServers(connection);
      expect(requests[0].url).to.match(/\/mcp-servers$/);
    });

    it('percent-encodes filter values', async () => {
      mockRequest({ mcpServers: [] });
      await ApiCatalog.listMcpServers(connection, { label: 'a b&c' });
      expect(requests[0].url).to.include('label=a+b%26c');
    });
  });

  describe('getMcpServer', () => {
    it('GETs /mcp-servers/{id}', async () => {
      mockRequest({ id: '1', name: 'n', type: 'EXTERNAL', status: 'ACTIVE' });
      await ApiCatalog.getMcpServer(connection, '1');
      expect(requests[0].method).to.equal('GET');
      expect(requests[0].url).to.match(/\/mcp-servers\/1$/);
    });
  });

  describe('listMcpServerAssets', () => {
    it('GETs /mcp-servers/{id}/assets', async () => {
      mockRequest({ assets: [] });
      await ApiCatalog.listMcpServerAssets(connection, '1');
      expect(requests[0].method).to.equal('GET');
      expect(requests[0].url).to.match(/\/mcp-servers\/1\/assets$/);
    });
  });

  describe('createMcpServer', () => {
    it('POSTs the body with JSON content-type', async () => {
      mockRequest({ server: { id: '1', name: 'n', type: 'EXTERNAL', status: 'ACTIVE' }, assets: [] });
      const result = await ApiCatalog.createMcpServer(connection, {
        name: 'my-server',
        type: 'EXTERNAL',
        serverUrl: 'https://example.com/mcp',
      });
      expect(requests[0].method).to.equal('POST');
      expect(requests[0].url).to.include('/api-catalog/mcp-servers');
      expect(JSON.parse(requests[0].body as string)).to.deep.include({ name: 'my-server', type: 'EXTERNAL' });
      expect(result.server.id).to.equal('1');
    });
  });

  describe('updateMcpServer', () => {
    it('PUTs to /mcp-servers/{id}', async () => {
      mockRequest({ id: '1', name: 'n', type: 'EXTERNAL', status: 'ACTIVE' });
      await ApiCatalog.updateMcpServer(connection, '1', { label: 'New label' });
      expect(requests[0].method).to.equal('PUT');
      expect(requests[0].url).to.match(/\/mcp-servers\/1$/);
    });
  });

  describe('deleteMcpServer', () => {
    it('DELETEs /mcp-servers/{id}', async () => {
      mockRequest(undefined);
      await ApiCatalog.deleteMcpServer(connection, '1');
      expect(requests[0].method).to.equal('DELETE');
      expect(requests[0].url).to.match(/\/mcp-servers\/1$/);
    });
  });

  describe('fetchMcpServer', () => {
    it('POSTs to /mcp-servers/{id}/fetch with an explicit body', async () => {
      mockRequest({ assets: [] });
      await ApiCatalog.fetchMcpServer(connection, '1');
      expect(requests[0].method).to.equal('POST');
      expect(requests[0].url).to.match(/\/mcp-servers\/1\/fetch$/);
      // A body must be sent: a bodyless POST over HTTP/2 leaves the stream half-open and the
      // request hangs until the 300s headers timeout (jsforce/undici never sees the response).
      expect(requests[0].body).to.equal('{}');
    });
  });

  describe('replaceMcpServerAssets', () => {
    it('PUTs the asset allowlist', async () => {
      mockRequest({ assets: [] });
      await ApiCatalog.replaceMcpServerAssets(connection, '1', { assets: [{ name: 'tool-a', active: true }] });
      expect(requests[0].method).to.equal('PUT');
      expect(requests[0].url).to.match(/\/mcp-servers\/1\/assets$/);
      expect(JSON.parse(requests[0].body as string).assets[0].name).to.equal('tool-a');
    });
  });

  describe('error handling', () => {
    it('wraps connection errors as SfError', async () => {
      $$.fakeConnectionRequest = () => Promise.reject(new Error('boom'));
      try {
        await ApiCatalog.getMcpServer(connection, '1');
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.include('boom');
      }
    });
  });
});
