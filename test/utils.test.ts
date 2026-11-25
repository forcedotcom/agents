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

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError, SfProject } from '@salesforce/core';
import {
  requestWithEndpointFallback,
  useNamedUserJwt,
  detectTestRunnerFromId,
  determineTestRunner,
  type RequestInfo,
  createPreviewSessionCache,
  validatePreviewSession,
  removePreviewSessionCache,
  getCachedPreviewSessionIds,
  getCurrentPreviewSessionId,
  listCachedPreviewSessions,
  listSessionTraces,
  readSessionTrace,
  readTurnIndex,
  writeTraceToHistory,
  getHistoryDir,
  type TurnIndex,
  type TraceFileInfo,
} from '../src/utils';
import type { PlannerResponse } from '../src/types';

describe('requestWithEndpointFallback', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
    // Internal (test1) instance, so the test./dev./stage. fallback hosts are tried
    connection.instanceUrl = 'https://orgfarm-abc123.test1.my.pc-rnd.salesforce.com';
    $$.SANDBOXES.CONNECTION.restore();
  });

  it('should succeed on first try with production endpoint', async () => {
    const requestStub = $$.SANDBOX.stub(connection, 'request').resolves({ success: true });

    const result = await requestWithEndpointFallback(connection, {
      method: 'POST',
      url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
      headers: { 'x-client-name': 'test' },
      body: '{}',
    });

    expect(result).to.deep.equal({ success: true });
    expect(requestStub.calledOnce).to.be.true;
    expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(
      'https://api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should retry with test endpoint on 404', async () => {
    const error404 = new Error('Not Found') as Error & { name: string };
    error404.name = 'ERROR_HTTP_404';

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onFirstCall().rejects(error404);
    requestStub.onSecondCall().resolves({ success: true });

    const result = await requestWithEndpointFallback(connection, {
      method: 'POST',
      url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
      headers: { 'x-client-name': 'test' },
      body: '{}',
    });

    expect(result).to.deep.equal({ success: true });
    expect(requestStub.calledTwice).to.be.true;
    expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(
      'https://api.salesforce.com/einstein/ai-agent/v1/test'
    );
    expect((requestStub.secondCall.args[0] as RequestInfo).url).to.equal(
      'https://test.api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should retry with dev endpoint after test endpoint 404', async () => {
    const error404 = new Error('Not Found') as Error & { name: string };
    error404.name = 'ERROR_HTTP_404';

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onFirstCall().rejects(error404);
    requestStub.onSecondCall().rejects(error404);
    requestStub.onThirdCall().resolves({ success: true });

    const result = await requestWithEndpointFallback(connection, {
      method: 'POST',
      url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
      headers: { 'x-client-name': 'test' },
      body: '{}',
    });

    expect(result).to.deep.equal({ success: true });
    expect(requestStub.calledThrice).to.be.true;
    expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(
      'https://api.salesforce.com/einstein/ai-agent/v1/test'
    );
    expect((requestStub.secondCall.args[0] as RequestInfo).url).to.equal(
      'https://test.api.salesforce.com/einstein/ai-agent/v1/test'
    );
    expect((requestStub.thirdCall.args[0] as RequestInfo).url).to.equal(
      'https://dev.api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should retry with stage endpoint after dev endpoint 404', async () => {
    const error404 = new Error('Not Found') as Error & { name: string };
    error404.name = 'ERROR_HTTP_404';

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).rejects(error404);
    requestStub.onCall(2).rejects(error404);
    requestStub.onCall(3).resolves({ success: true });

    const result = await requestWithEndpointFallback(connection, {
      method: 'POST',
      url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
      headers: { 'x-client-name': 'test' },
      body: '{}',
    });

    expect(result).to.deep.equal({ success: true });
    expect(requestStub.callCount).to.equal(4);
    expect((requestStub.getCall(1).args[0] as RequestInfo).url).to.equal(
      'https://test.api.salesforce.com/einstein/ai-agent/v1/test'
    );
    expect((requestStub.getCall(2).args[0] as RequestInfo).url).to.equal(
      'https://dev.api.salesforce.com/einstein/ai-agent/v1/test'
    );
    expect((requestStub.getCall(3).args[0] as RequestInfo).url).to.equal(
      'https://stage.api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should throw AgentApiNotFound after all endpoints fail with 404', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';

    const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error404);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        headers: { 'x-client-name': 'test' },
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('AgentApiNotFound');
      expect((error as SfError).message).to.include('Unable to access the Salesforce Agent API');
    }

    expect(requestStub.callCount).to.equal(4);
  });

  it('should throw immediately on non-404 errors', async () => {
    const error500 = new Error('Internal Server Error') as Error & { name: string };
    error500.name = 'ERROR_HTTP_500';

    const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error500);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        headers: { 'x-client-name': 'test' },
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.equal(error500);
    }

    expect(requestStub.calledOnce).to.be.true;
  });

  it('should handle URLs that already have test prefix', async () => {
    const requestStub = $$.SANDBOX.stub(connection, 'request').resolves({ success: true });

    const result = await requestWithEndpointFallback(connection, {
      method: 'POST',
      url: 'https://test.api.salesforce.com/einstein/ai-agent/v1/test',
      headers: { 'x-client-name': 'test' },
      body: '{}',
    });

    expect(result).to.deep.equal({ success: true });
    expect(requestStub.calledOnce).to.be.true;
    // Should try production first (replace test. with '')
    expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(
      'https://api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should continue to next endpoint after logging 404 error', async () => {
    const error404 = new Error('Not Found') as Error & { name: string };
    error404.name = 'ERROR_HTTP_404';

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onFirstCall().rejects(error404);
    requestStub.onSecondCall().resolves({ success: true });

    // This test verifies that the function continues to try the next endpoint after a 404
    // The logging happens internally, but the important behavior is the retry logic
    const result = await requestWithEndpointFallback(connection, {
      method: 'POST',
      url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
      headers: { 'x-client-name': 'test' },
      body: '{}',
    });

    expect(result).to.deep.equal({ success: true });
    expect(requestStub.calledTwice).to.be.true;
  });

  it('should log error and throw immediately on non-404 errors', async () => {
    const error500 = new Error('Internal Server Error') as Error & { name: string };
    error500.name = 'ERROR_HTTP_500';

    const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error500);

    // This test verifies that non-404 errors are thrown immediately
    // The logging happens internally before throwing
    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        headers: { 'x-client-name': 'test' },
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.equal(error500);
      // Should only be called once since non-404 errors throw immediately
      expect(requestStub.calledOnce).to.be.true;
    }
  });
  it('should skip an unreachable fallback host and keep trying', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';
    const fetchFailed = new TypeError('fetch failed');

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).rejects(fetchFailed);
    requestStub.onCall(2).resolves({ success: true });

    const result = await requestWithEndpointFallback(connection, {
      method: 'POST',
      url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
      body: '{}',
    });

    expect(result).to.deep.equal({ success: true });
    expect(requestStub.callCount).to.equal(3);
    expect((requestStub.getCall(2).args[0] as RequestInfo).url).to.equal(
      'https://dev.api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should not let an unreachable fallback host mask the 404 from api.salesforce.com', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';
    const fetchFailed = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).rejects(fetchFailed);
    requestStub.onCall(2).rejects(fetchFailed);
    requestStub.onCall(3).rejects(error404);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1.1/authoring/agents',
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.name).to.equal('AgentApiNotFound');
      expect(sfError.cause).to.equal(error404);
      expect(sfError.message).to.include(
        'POST /einstein/ai-agent/v1.1/authoring/agents returned 404 (Not Found) from api.salesforce.com, stage.api.salesforce.com.'
      );
      expect(sfError.message).to.include("Couldn't connect to test.api.salesforce.com, dev.api.salesforce.com.");
      expect(sfError.data).to.deep.equal({
        attemptedEndpoints: [
          'api.salesforce.com',
          'test.api.salesforce.com',
          'dev.api.salesforce.com',
          'stage.api.salesforce.com',
        ],
        unreachableEndpoints: ['test.api.salesforce.com', 'dev.api.salesforce.com'],
      });
    }

    expect(requestStub.callCount).to.equal(4);
  });

  it('should throw immediately when api.salesforce.com itself is unreachable', async () => {
    const fetchFailed = new TypeError('fetch failed');

    const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(fetchFailed);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.equal(fetchFailed);
    }

    expect(requestStub.calledOnce).to.be.true;
  });

  it('should rethrow an HTTP error from a fallback host that has no statusCode', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';
    // jsforce names JSON-body errors by errorCode and sets no statusCode
    const invalidSession = new Error('Session expired or invalid');
    invalidSession.name = 'INVALID_SESSION_ID';

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).rejects(invalidSession);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.equal(invalidSession);
    }
    expect(requestStub.calledTwice).to.be.true;
  });

  it('should rethrow a non-404 HTTP error from a fallback host', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';
    const error503 = Object.assign(new Error('Unavailable'), { statusCode: 503 });

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).rejects(error503);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.equal(error503);
    }
  });

  it('should report every fallback host as unreachable and keep the 404 message', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });

    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).rejects(refused);
    requestStub.onCall(2).rejects(refused);
    requestStub.onCall(3).rejects(refused);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test?a=b',
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.message).to.equal(
        "Unable to access the Salesforce Agent APIs: POST /einstein/ai-agent/v1/test returned 404 (Not Found) from api.salesforce.com. Couldn't connect to test.api.salesforce.com, dev.api.salesforce.com, stage.api.salesforce.com."
      );
      expect(sfError.actions?.join('\n')).to.include('GatewayHawkingInfo');
    }
  });

  it('should not treat non-connection undici errors as network errors', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';
    const invalidArg = Object.assign(new Error('bad arg'), { code: 'UND_ERR_INVALID_ARG' });
    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).rejects(invalidArg);

    try {
      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        body: '{}',
      });
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.equal(invalidArg);
    }
  });

  it('should give fallback hosts no retries', async () => {
    const error404 = new Error('Not Found');
    error404.name = 'ERROR_HTTP_404';
    const requestStub = $$.SANDBOX.stub(connection, 'request');
    requestStub.onCall(0).rejects(error404);
    requestStub.onCall(1).resolves({ success: true });

    await requestWithEndpointFallback(
      connection,
      { method: 'POST', url: 'https://api.salesforce.com/einstein/ai-agent/v1/test', body: '{}' },
      { retry: { maxRetries: 3 } }
    );

    expect(requestStub.getCall(0).args[1]).to.deep.equal({ retry: { maxRetries: 3 } });
    expect(requestStub.getCall(1).args[1]).to.deep.equal({ retry: { maxRetries: 0 } });
  });

  for (const instanceUrl of ['https://myorg.my.salesforce.com.stm.salesforce.com', 'https://abc.crm.dev']) {
    it(`should use the fallback chain for internal instance ${instanceUrl}`, async () => {
      connection.instanceUrl = instanceUrl;
      const error404 = new Error('Not Found');
      error404.name = 'ERROR_HTTP_404';
      const requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub.onCall(0).rejects(error404);
      requestStub.onCall(1).resolves({ success: true });

      await requestWithEndpointFallback(connection, {
        method: 'POST',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
        body: '{}',
      });
      expect(requestStub.calledTwice).to.be.true;
    });
  }

  describe('SF_AGENT_API_ENDPOINTS', () => {
    afterEach(() => {
      delete process.env.SF_AGENT_API_ENDPOINTS;
    });

    it('should try only the listed gateways, even for a customer-domain org', async () => {
      process.env.SF_AGENT_API_ENDPOINTS = 'stage.api.salesforce.com, test';
      connection.instanceUrl = 'https://orgfarm-abc123.develop.my.salesforce.com';
      const error404 = new Error('Not Found');
      error404.name = 'ERROR_HTTP_404';
      const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error404);

      try {
        await requestWithEndpointFallback(connection, {
          method: 'POST',
          url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
          body: '{}',
        });
        expect.fail('Expected error was not thrown');
      } catch (error) {
        expect((error as SfError).data).to.deep.include({
          attemptedEndpoints: ['api.salesforce.com', 'stage.api.salesforce.com', 'test.api.salesforce.com'],
        });
      }
      expect(requestStub.callCount).to.equal(3);
    });

    it('should disable the fallback when set to "none"', async () => {
      process.env.SF_AGENT_API_ENDPOINTS = 'none';
      const error404 = new Error('Not Found');
      error404.name = 'ERROR_HTTP_404';
      const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error404);

      try {
        await requestWithEndpointFallback(connection, {
          method: 'POST',
          url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
          body: '{}',
        });
        expect.fail('Expected error was not thrown');
      } catch (error) {
        expect((error as SfError).name).to.equal('AgentApiNotFound');
      }
      expect(requestStub.calledOnce).to.be.true;
    });
  });

  describe('production orgs', () => {
    beforeEach(() => {
      connection.instanceUrl = 'https://orgfarm-abc123.develop.my.salesforce.com';
    });

    it('should not fall back to internal hosts on 404', async () => {
      const error404 = new Error('Not Found');
      error404.name = 'ERROR_HTTP_404';

      const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error404);

      try {
        await requestWithEndpointFallback(connection, {
          method: 'POST',
          url: 'https://api.salesforce.com/einstein/ai-agent/v1.1/authoring/agents',
          body: '{}',
        });
        expect.fail('Expected error was not thrown');
      } catch (error) {
        const sfError = error as SfError;
        expect(sfError.name).to.equal('AgentApiNotFound');
        expect(sfError.cause).to.equal(error404);
        expect(sfError.message).to.equal(
          'Unable to access the Salesforce Agent APIs: POST /einstein/ai-agent/v1.1/authoring/agents returned 404 (Not Found) from api.salesforce.com.'
        );
        expect(sfError.actions?.join('\n')).to.include('Einstein1AIPlatform');
        expect(sfError.actions?.join('\n')).to.include('SF_AGENT_API_ENDPOINTS');
        expect(sfError.actions?.join('\n')).to.include("'sf agent validate authoring-bundle' can pass");
      }

      expect(requestStub.calledOnce).to.be.true;
      expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(
        'https://api.salesforce.com/einstein/ai-agent/v1.1/authoring/agents'
      );
    });

    it('should only add the publish hint for /authoring/agents', async () => {
      const error404 = new Error('Not Found');
      error404.name = 'ERROR_HTTP_404';
      $$.SANDBOX.stub(connection, 'request').rejects(error404);

      try {
        await requestWithEndpointFallback(connection, {
          method: 'POST',
          url: 'https://api.salesforce.com/einstein/ai-agent/v1.1/authoring/scripts',
          body: '{}',
        });
        expect.fail('Expected error was not thrown');
      } catch (error) {
        const sfError = error as SfError;
        expect(sfError.name).to.equal('AgentApiNotFound');
        expect(sfError.actions?.join('\n')).to.not.include('sf agent validate');
      }
    });

    it('should use api.salesforce.com even when the URL has an internal prefix', async () => {
      const requestStub = $$.SANDBOX.stub(connection, 'request').resolves({ success: true });

      await requestWithEndpointFallback(connection, {
        method: 'DELETE',
        url: 'https://test.api.salesforce.com/einstein/ai-agent/v1/test',
      });

      expect(requestStub.calledOnce).to.be.true;
      expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(
        'https://api.salesforce.com/einstein/ai-agent/v1/test'
      );
    });

    it('should treat an org without an instance URL as a production org', async () => {
      connection.instanceUrl = '';
      const error404 = new Error('Not Found');
      error404.name = 'ERROR_HTTP_404';
      const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error404);

      try {
        await requestWithEndpointFallback(connection, {
          method: 'POST',
          url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
          body: '{}',
        });
        expect.fail('Expected error was not thrown');
      } catch (error) {
        expect((error as SfError).name).to.equal('AgentApiNotFound');
      }

      expect(requestStub.calledOnce).to.be.true;
    });
  });

  describe('GovCloud orgs', () => {
    const request: RequestInfo = {
      method: 'POST',
      url: 'https://api.salesforce.com/einstein/ai-agent/v1/test',
      headers: { 'x-client-name': 'test' },
      body: '{}',
    };
    const path = '/einstein/ai-agent/v1/test';
    const govHeaders = { 'x-salesforce-region': 'us-gov-east-1', 'x-client-name': 'test' };
    const jwtWithRoutingHints = (routingHints: string): string => {
      const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
      // eslint-disable-next-line camelcase
      return `${b64({ alg: 'RS256' })}.${b64({ sub: 'user', sfap_rh: routingHints })}.signature`;
    };
    let error404: Error;

    beforeEach(() => {
      error404 = new Error('Not Found');
      error404.name = 'ERROR_HTTP_404';
    });

    it('sends stage GovCloud orgs to stage.api.gov.salesforce.mil with the region header', async () => {
      connection.accessToken = jwtWithRoutingHints(
        'bot-svc-llm:aws-giastage1-usgoveast1/einstein2,bot-svc-api:aws-giastage1-usgoveast1/uengage1,dx-workspaces-proxy/dx-workspaces:aws-stage1-useast2/gid'
      );
      const requestStub = $$.SANDBOX.stub(connection, 'request').resolves({ success: true });

      const result = await requestWithEndpointFallback(connection, request);

      expect(result).to.deep.equal({ success: true });
      expect(requestStub.calledOnce).to.be.true;
      const sent = requestStub.firstCall.args[0] as RequestInfo;
      expect(sent.url).to.equal(`https://stage.api.gov.salesforce.mil${path}`);
      expect(sent.headers).to.deep.equal(govHeaders);
    });

    it('falls back to the .com host of the same environment on 404', async () => {
      connection.accessToken = jwtWithRoutingHints('bot-svc-api:aws-giastage1-usgoveast1/uengage1');
      const requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub.onFirstCall().rejects(error404);
      requestStub.onSecondCall().resolves({ success: true });

      const result = await requestWithEndpointFallback(connection, request);

      expect(result).to.deep.equal({ success: true });
      expect(requestStub.getCalls().map((call) => (call.args[0] as RequestInfo).url)).to.deep.equal([
        `https://stage.api.gov.salesforce.mil${path}`,
        `https://stage.api.gov.salesforce.com${path}`,
      ]);
      expect((requestStub.secondCall.args[0] as RequestInfo).headers).to.deep.equal(govHeaders);
    });

    it('only tries the prod GovCloud hosts for prod GovCloud orgs', async () => {
      connection.accessToken = jwtWithRoutingHints('bot-svc-api:aws-giaprod1-usgoveast1/uengage1');
      const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error404);

      try {
        await requestWithEndpointFallback(connection, request);
        expect.fail('Expected error was not thrown');
      } catch (error) {
        const sfError = error as SfError;
        expect(sfError.name).to.equal('AgentApiNotFound');
        expect(sfError.message).to.include('api.gov.salesforce.mil, api.gov.salesforce.com');
        expect(sfError.actions?.join('\n')).to.not.include('SF_AGENT_API_ENDPOINTS');
      }

      expect(requestStub.getCalls().map((call) => (call.args[0] as RequestInfo).url)).to.deep.equal([
        `https://api.gov.salesforce.mil${path}`,
        `https://api.gov.salesforce.com${path}`,
      ]);
    });

    it('sends dev GovCloud orgs to dev.api.gov.salesforce.com', async () => {
      connection.accessToken = jwtWithRoutingHints('bot-svc-api:aws-giadev1-usgoveast1/core1');
      const requestStub = $$.SANDBOX.stub(connection, 'request').resolves({ success: true });

      await requestWithEndpointFallback(connection, request);

      expect(requestStub.calledOnce).to.be.true;
      expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(`https://dev.api.gov.salesforce.com${path}`);
    });

    it('ignores SF_AGENT_API_ENDPOINTS for GovCloud orgs', async () => {
      process.env.SF_AGENT_API_ENDPOINTS = 'stage.';
      connection.accessToken = jwtWithRoutingHints('bot-svc-api:aws-giastage1-usgoveast1/uengage1');
      const requestStub = $$.SANDBOX.stub(connection, 'request').resolves({ success: true });

      try {
        await requestWithEndpointFallback(connection, request);
      } finally {
        delete process.env.SF_AGENT_API_ENDPOINTS;
      }

      expect((requestStub.firstCall.args[0] as RequestInfo).url).to.equal(
        `https://stage.api.gov.salesforce.mil${path}`
      );
    });

    it('keeps the commercial hosts and headers for orgs outside GovCloud', async () => {
      connection.accessToken = jwtWithRoutingHints('bot-svc-api:aws-prod5-uswest2/core1');
      const requestStub = $$.SANDBOX.stub(connection, 'request').rejects(error404);

      try {
        await requestWithEndpointFallback(connection, request);
        expect.fail('Expected error was not thrown');
      } catch (error) {
        expect((error as SfError).name).to.equal('AgentApiNotFound');
      }

      expect(requestStub.getCalls().map((call) => (call.args[0] as RequestInfo).url)).to.deep.equal([
        `https://api.salesforce.com${path}`,
        `https://test.api.salesforce.com${path}`,
        `https://dev.api.salesforce.com${path}`,
        `https://stage.api.salesforce.com${path}`,
      ]);
      expect((requestStub.firstCall.args[0] as RequestInfo).headers).to.deep.equal({ 'x-client-name': 'test' });
    });
  });
});

describe('useNamedUserJwt', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://test.my.salesforce.com';
    // restore the connection sandbox so we can stub methods directly
    $$.SANDBOXES.CONNECTION.restore();
  });

  it('should call refreshAuth when connection has a refresh token', async () => {
    // Stub getAuthInfoFields to return a refresh token
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({
      refreshToken: 'some-refresh-token',
    });

    const refreshStub = $$.SANDBOX.stub(connection, 'refreshAuth').resolves();

    // Stub getConnectionOptions to return valid access token and instance URL
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Stub the nameduser endpoint request with valid JWT token
    const validJwtToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: validJwtToken,
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
    });

    await useNamedUserJwt(connection);

    expect(refreshStub.calledOnce).to.be.true;
  });

  it('should skip refreshAuth when connection has no refresh token', async () => {
    // Stub getAuthInfoFields to return NO refresh token (ECA auth scenario)
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    const refreshStub = $$.SANDBOX.stub(connection, 'refreshAuth').resolves();

    // Stub getConnectionOptions to return valid access token and instance URL
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Stub the nameduser endpoint request with valid JWT token
    const validJwtToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: validJwtToken,
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
    });

    await useNamedUserJwt(connection);

    expect(refreshStub.called).to.be.false;
  });

  it('should throw ApiAccessError when refreshAuth fails and refresh token exists', async () => {
    // Stub getAuthInfoFields to return a refresh token
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({
      refreshToken: 'some-refresh-token',
    });

    // Make refreshAuth fail
    $$.SANDBOX.stub(connection, 'refreshAuth').rejects(new Error('refresh failed'));

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal('Error refreshing connection');
    }
  });

  it('should still succeed with valid access token when no refresh token exists', async () => {
    // ECA auth scenario: no refresh token, but valid access token
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'eca-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Stub the nameduser endpoint request with valid JWT token
    const validJwtToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: validJwtToken,
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
    });

    const result = await useNamedUserJwt(connection);

    expect(result.accessToken).to.equal(validJwtToken);
  });

  it('should succeed with valid JWT token response', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Valid JWT token with three parts (header.payload.signature)
    const validJwtToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: validJwtToken,
      // eslint-disable-next-line camelcase
      token_format: 'jwt',
      scope: 'full',
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
      // eslint-disable-next-line camelcase
      issued_at: Date.now(),
      // eslint-disable-next-line camelcase
      api_instance_url: 'https://test.my.salesforce.com',
    });

    const result = await useNamedUserJwt(connection);

    expect(result.accessToken).to.equal(validJwtToken);
  });

  it('should throw ApiAccessError when response is empty', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Return null/undefined response
    $$.SANDBOX.stub(connection, 'request').resolves(null);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal('Error obtaining API token: empty response.');
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions).to.deep.equal([
        'Authorize the org again with "sf org login web --alias <alias>" and retry.',
      ]);
    }
  });

  it('should throw ApiAccessError when access_token is missing', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Response without access_token
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
      scope: 'full',
    });

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal(
        'Error obtaining API token: invalid or missing access token (response fields: token_type, scope).'
      );
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions?.join('\n')).to.include('session settings');
    }
  });

  it('should throw ApiAccessError when access_token is empty string', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: '   ',
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
    });

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal(
        'Error obtaining API token: invalid or missing access token (response fields: access_token, token_type).'
      );
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions?.join('\n')).to.include('session settings');
    }
  });

  it('should throw ApiAccessError when access_token is not a string', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: 12_345,
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
    });

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal(
        'Error obtaining API token: invalid or missing access token (response fields: access_token, token_type).'
      );
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions?.join('\n')).to.include('session settings');
    }
  });

  it('should throw ApiAccessError when access_token does not have valid JWT format', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Token with only 2 parts instead of 3
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: 'invalid.token',
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
    });

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal(
        'Error obtaining API token: access token does not have valid JWT format.'
      );
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions).to.deep.equal([
        'Authorize the org again with "sf org login web --alias <alias>" and retry.',
      ]);
    }
  });

  it('should throw ApiAccessError when access_token has too many parts', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // Token with 4 parts instead of 3
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: 'part1.part2.part3.part4',
      // eslint-disable-next-line camelcase
      token_type: 'Bearer',
    });

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal(
        'Error obtaining API token: access token does not have valid JWT format.'
      );
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions).to.deep.equal([
        'Authorize the org again with "sf org login web --alias <alias>" and retry.',
      ]);
    }
  });

  it('should throw wrapped ApiAccessError for network errors', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});

    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    const networkError = new Error('Network error');
    $$.SANDBOX.stub(connection, 'request').rejects(networkError);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal('Error obtaining API token: Network error');
      expect((error as SfError).cause).to.equal(networkError);
      expect((error as SfError).actions?.join('\n')).to.include('Agentforce is enabled');
    }
  });

  it('should explain a login page returned with 200 instead of a token', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    // When the sid isn't accepted as a browser session, the login-protected endpoint returns 200 with an
    // HTML redirect to the login page, which jsforce returns as a string.
    const loginPage =
      '<html><head><script>window.location.href="/?ec=302&startURL=%2Fagentforce%2Fbootstrap%2Fnameduser";</script></head></html>';
    $$.SANDBOX.stub(connection, 'request').resolves(loginPage);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      const sfError = error as SfError;
      expect(sfError.name).to.equal('ApiAccessError');
      expect(sfError.message).to.include('the org returned a login page instead of a token');
      expect(sfError.message).to.include('https://test.my.salesforce.com/agentforce/bootstrap/nameduser');
      expect(sfError.message).to.not.include('<script>');
      expect(sfError.message).to.not.include('valid-access-token');
      expect(sfError.actions?.join('\n')).to.include('session settings');
      expect(sfError.actions?.join('\n')).to.include('sf org login web');
    }
  });

  it('should include error fields but not token values when access_token is missing', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    $$.SANDBOX.stub(connection, 'request').resolves({
      error: 'invalid_session',
      // eslint-disable-next-line camelcase
      error_description: 'Session is not a named user session',
      // eslint-disable-next-line camelcase
      refresh_token: 'secret-refresh-value',
    });

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.name).to.equal('ApiAccessError');
      expect(sfError.message).to.equal(
        'Error obtaining API token: invalid or missing access token (error: invalid_session; error_description: Session is not a named user session; response fields: error, error_description, refresh_token).'
      );
      expect(sfError.message).to.not.include('secret-refresh-value');
    }
  });

  it('should name the custom connected app in the actions', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({ clientId: 'MyCustomEcaClientId' });
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });
    $$.SANDBOX.stub(connection, 'request').resolves('<html>login</html>');

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const actions = (error as SfError).actions ?? [];
      expect(actions[0]).to.include('your own connected app or external client app (client ID MyCustomEcaClientId)');
      expect(actions).to.include('   * Manage user data via Web browsers (web)');
    }
  });

  it('should lead with session settings for the default CLI connected app', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({ clientId: 'PlatformCLI' });
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });
    $$.SANDBOX.stub(connection, 'request').resolves('<html>login</html>');

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const actions = (error as SfError).actions ?? [];
      expect(actions[0]).to.include("Check that the org's session settings");
      expect(actions[0]).to.include("authorizing again with the same connected app doesn't change them");
      expect(actions.join('\n')).to.not.include('your own connected app');
    }
  });

  it('should keep the server message when the endpoint returns an HTTP error', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    const httpError = new SfError('User does not have access to Agentforce', 'ERROR_HTTP_403');
    $$.SANDBOX.stub(connection, 'request').rejects(httpError);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.name).to.equal('ApiAccessError');
      expect(sfError.message).to.equal('Error obtaining API token: User does not have access to Agentforce');
      expect(sfError.cause).to.equal(httpError);
      expect(sfError.actions?.join('\n')).to.include('Agentforce is enabled');
      expect(sfError.actions?.join('\n')).to.not.include('(web)');
    }
  });

  it('should cap and flatten a long multi-line HTTP error message, keeping the full text on the cause', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    const httpError = new SfError(`Bad gateway\n\n   upstream:\n${'y'.repeat(500)}`, 'ERROR_HTTP_502');
    $$.SANDBOX.stub(connection, 'request').rejects(httpError);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.message).to.equal(
        `Error obtaining API token: Bad gateway upstream: ${'y'.repeat(200 - 'Bad gateway upstream: '.length)}...`
      );
      expect(sfError.message).to.not.include('\n');
      expect(sfError.cause).to.equal(httpError);
    }
  });

  it('should keep the actions of a lower-layer ApiAccessError', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });

    const lowerError = new SfError('Lower layer failed', 'ApiAccessError', ['Lower layer action']);
    $$.SANDBOX.stub(connection, 'request').rejects(lowerError);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.message).to.equal('Error obtaining API token: Lower layer failed');
      expect(sfError.cause).to.equal(lowerError);
      expect(sfError.actions).to.deep.equal(['Lower layer action']);
    }
  });

  it('should treat a whitespace-only body as an empty response', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });
    $$.SANDBOX.stub(connection, 'request').resolves('  \n ');

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect((error as SfError).message).to.equal('Error obtaining API token: empty response.');
    }
  });

  it('should not call a non-HTML text body a login page', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });
    $$.SANDBOX.stub(connection, 'request').resolves('Upstream proxy error');

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.message).to.equal(
        'Error obtaining API token: unexpected non-JSON response from https://test.my.salesforce.com/agentforce/bootstrap/nameduser.'
      );
      expect(sfError.actions?.join('\n')).to.not.include('(web)');
    }
  });

  it('should reject an array response', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });
    // eslint-disable-next-line camelcase
    $$.SANDBOX.stub(connection, 'request').resolves([{ access_token: 'a.b.c' }]);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect((error as SfError).message).to.equal(
        'Error obtaining API token: unexpected response from https://test.my.salesforce.com/agentforce/bootstrap/nameduser.'
      );
    }
  });

  it('should truncate long error values and never echo the token value', async () => {
    $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({});
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'valid-access-token',
      instanceUrl: 'https://test.my.salesforce.com',
    });
    $$.SANDBOX.stub(connection, 'request').resolves({
      // eslint-disable-next-line camelcase
      access_token: '   ',
      error: 'invalid_session',
      // eslint-disable-next-line camelcase
      error_description: 'x'.repeat(500),
      // eslint-disable-next-line camelcase
      id_token: 'secret-id-token-value',
    });

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      const sfError = error as SfError;
      expect(sfError.message).to.include(`error_description: ${'x'.repeat(200)}...;`);
      expect(sfError.message).to.not.include('x'.repeat(201));
      expect(sfError.message).to.include('response fields: access_token, error, error_description, id_token');
      expect(sfError.message).to.not.include('secret-id-token-value');
      expect(sfError.message).to.not.include('valid-access-token');
    }
  });
});

describe('detectTestRunnerFromId', () => {
  it('detects agentforce-studio from 3A2 prefix', () => {
    expect(detectTestRunnerFromId('3A2abc123')).to.equal('agentforce-studio');
  });

  it('detects testing-center from 4KB prefix', () => {
    expect(detectTestRunnerFromId('4KBabc123')).to.equal('testing-center');
  });

  it('returns undefined for unrecognized prefix', () => {
    expect(detectTestRunnerFromId('0HOunknown')).to.be.undefined;
  });

  it('returns undefined for empty string', () => {
    expect(detectTestRunnerFromId('')).to.be.undefined;
  });
});

describe('determineTestRunner', () => {
  const $$ = new TestContext();
  let connection: Connection;

  beforeEach(async () => {
    const testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
  });

  afterEach(() => {
    $$.restore();
  });

  it('returns agentforce-studio when only AiTestingDefinition exists', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
      if ((query as { type: string }).type === 'AiTestingDefinition')
        return Promise.resolve([{ fullName: 'MySuite' }] as never);
      return Promise.resolve([] as never);
    });

    const result = await determineTestRunner(connection, 'MySuite');
    expect(result).to.equal('agentforce-studio');
  });

  it('returns testing-center when only AiEvaluationDefinition exists', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
      if ((query as { type: string }).type === 'AiEvaluationDefinition')
        return Promise.resolve([{ fullName: 'MySuite' }] as never);
      return Promise.resolve([] as never);
    });

    const result = await determineTestRunner(connection, 'MySuite');
    expect(result).to.equal('testing-center');
  });

  it('returns testing-center when only AiEvaluationDefinition exists (no testDefinitionName)', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
      if ((query as { type: string }).type === 'AiEvaluationDefinition')
        return Promise.resolve([{ fullName: 'SomeSuite' }] as never);
      return Promise.resolve([] as never);
    });

    const result = await determineTestRunner(connection);
    expect(result).to.equal('testing-center');
  });

  it('returns agentforce-studio when only AiTestingDefinition exists (no testDefinitionName)', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
      if ((query as { type: string }).type === 'AiTestingDefinition')
        return Promise.resolve([{ fullName: 'SomeSuite' }] as never);
      return Promise.resolve([] as never);
    });

    const result = await determineTestRunner(connection);
    expect(result).to.equal('agentforce-studio');
  });

  it('throws AmbiguousTestDefinition when same name exists in both metadata types', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').callsFake(() => Promise.resolve([{ fullName: 'MySuite' }] as never));

    try {
      await determineTestRunner(connection, 'MySuite');
      expect.fail('Expected error was not thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(SfError);
      expect((err as SfError).name).to.equal('AmbiguousTestDefinition');
    }
  });

  it('prefers testing-center when name only exists in testing-center (both types have entries)', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
      if ((query as { type: string }).type === 'AiEvaluationDefinition')
        return Promise.resolve([{ fullName: 'TCSuite' }] as never);
      return Promise.resolve([{ fullName: 'ASSuite' }] as never);
    });

    const result = await determineTestRunner(connection, 'TCSuite');
    expect(result).to.equal('testing-center');
  });

  it('prefers agentforce-studio when name only exists in agentforce-studio (both types have entries)', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
      if ((query as { type: string }).type === 'AiEvaluationDefinition')
        return Promise.resolve([{ fullName: 'TCSuite' }] as never);
      return Promise.resolve([{ fullName: 'ASSuite' }] as never);
    });

    const result = await determineTestRunner(connection, 'ASSuite');
    expect(result).to.equal('agentforce-studio');
  });

  it('throws NoTestDefinitionsFound when no metadata types exist', async () => {
    $$.SANDBOX.stub(connection.metadata, 'list').resolves([] as never);

    try {
      await determineTestRunner(connection);
      expect.fail('Expected error was not thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(SfError);
      expect((err as SfError).name).to.equal('NoTestDefinitionsFound');
    }
  });
});

// ====================================================
//           Preview Session Store Tests
// ====================================================

function makeMockProject(getPath: () => string): SfProject {
  return { getPath } as SfProject;
}

function makeMockAgent(
  projectDir: string,
  agentId: string
): {
  setSessionId: (id: string) => void;
  getAgentIdForStorage: () => string;
  getHistoryDir: () => Promise<string>;
} {
  let sessionId: string | undefined;
  return {
    setSessionId(id: string) {
      sessionId = id;
    },
    getAgentIdForStorage(): string {
      return agentId;
    },
    async getHistoryDir(): Promise<string> {
      if (!sessionId) throw new Error('sessionId not set');
      const dir = join(projectDir, '.sfdx', 'agents', agentId, 'sessions', sessionId);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

describe('Preview Session Store', () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'preview-session-store-'));
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  describe('createPreviewSessionCache', () => {
    it('saves session and validates with same agent', async () => {
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('sess-1');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-1');
      await validatePreviewSession(agent);
    });

    it('allows multiple sessions for same agent', async () => {
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('sess-a');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-b');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-a');
      await validatePreviewSession(agent);
      agent.setSessionId('sess-b');
      await validatePreviewSession(agent);
    });
  });

  describe('validatePreviewSession', () => {
    it('throws PreviewSessionNotFound when session file does not exist', async () => {
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('unknown-sess');
      try {
        await validatePreviewSession(agent);
        expect.fail('Expected validatePreviewSession to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(SfError);
        expect((e as SfError).name).to.equal('PreviewSessionNotFound');
        expect((e as SfError).message).to.include('No preview session found');
      }
    });

    it('throws PreviewSessionNotFound when session id is for different agent', async () => {
      const agentA = makeMockAgent(projectPath, 'agent-a');
      const agentB = makeMockAgent(projectPath, 'agent-b');
      agentA.setSessionId('sess-1');
      await createPreviewSessionCache(agentA);
      agentB.setSessionId('sess-1');
      try {
        await validatePreviewSession(agentB);
        expect.fail('Expected validatePreviewSession to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(SfError);
        expect((e as SfError).name).to.equal('PreviewSessionNotFound');
      }
    });
  });

  describe('getCachedPreviewSessionIds', () => {
    it('returns empty when no sessions', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'agent-1');
      const ids = await getCachedPreviewSessionIds(project, agent);
      expect(ids).to.deep.equal([]);
    });

    it('returns session ids that have session-meta.json', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('sess-1');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-2');
      await createPreviewSessionCache(agent);
      const ids = await getCachedPreviewSessionIds(project, agent);
      expect(ids).to.have.members(['sess-1', 'sess-2']);
    });
  });

  describe('removePreviewSessionCache', () => {
    it('removes session from cache', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('sess-1');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-2');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-1');
      await removePreviewSessionCache(agent);
      const ids = await getCachedPreviewSessionIds(project, agent);
      expect(ids).to.deep.equal(['sess-2']);
    });

    it('after removing one session getCurrentPreviewSessionId returns the remaining one', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('sess-a');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-b');
      await createPreviewSessionCache(agent);
      expect(await getCurrentPreviewSessionId(project, agent)).to.be.undefined;
      agent.setSessionId('sess-a');
      await removePreviewSessionCache(agent);
      expect(await getCurrentPreviewSessionId(project, agent)).to.equal('sess-b');
    });
  });

  describe('listCachedPreviewSessions', () => {
    it('returns empty when no cached sessions', async () => {
      const project = makeMockProject(() => projectPath);
      const list = await listCachedPreviewSessions(project);
      expect(list).to.deep.equal([]);
    });

    it('returns agent ids and session ids for all cached sessions', async () => {
      const project = makeMockProject(() => projectPath);
      const agent1 = makeMockAgent(projectPath, 'bundle-a');
      agent1.setSessionId('s1');
      await createPreviewSessionCache(agent1);
      agent1.setSessionId('s2');
      await createPreviewSessionCache(agent1);
      const agent2 = makeMockAgent(projectPath, 'bundle-b');
      agent2.setSessionId('s3');
      await createPreviewSessionCache(agent2);
      const list = await listCachedPreviewSessions(project);
      expect(list).to.have.lengthOf(2);
      const byAgent = Object.fromEntries(list.map((e) => [e.agentId, e.sessions.map((s) => s.sessionId)]));
      expect(byAgent['bundle-a']).to.have.members(['s1', 's2']);
      expect(byAgent['bundle-b']).to.deep.equal(['s3']);
    });

    it('returns displayName and sessionType from session-meta', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'some-id');
      agent.setSessionId('s1');
      await createPreviewSessionCache(agent, { displayName: 'My_Production_Agent', sessionType: 'published' });
      const list = await listCachedPreviewSessions(project);
      expect(list[0].displayName).to.equal('My_Production_Agent');
      expect(list[0].sessions[0].sessionType).to.equal('published');
    });

    it('returns timestamp for each session', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'some-id');
      agent.setSessionId('s1');
      await createPreviewSessionCache(agent, { sessionType: 'simulated' });
      const list = await listCachedPreviewSessions(project);
      expect(list[0].sessions[0].timestamp)
        .to.be.a('string')
        .and.match(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns sessions in creation order from index', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'bundle-a');
      agent.setSessionId('s1');
      await createPreviewSessionCache(agent);
      agent.setSessionId('s2');
      await createPreviewSessionCache(agent);
      agent.setSessionId('s3');
      await createPreviewSessionCache(agent);
      const list = await listCachedPreviewSessions(project);
      expect(list[0].sessions.map((s) => s.sessionId)).to.deep.equal(['s1', 's2', 's3']);
    });

    it('index file is written to the sessions directory', async () => {
      const agent = makeMockAgent(projectPath, 'bundle-a');
      agent.setSessionId('s1');
      await createPreviewSessionCache(agent, { displayName: 'MyAgent', sessionType: 'live' });
      const indexPath = join(projectPath, '.sfdx', 'agents', 'bundle-a', 'sessions', 'index.json');
      const raw = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw) as Array<{ sessionId: string; sessionType: string }>;
      expect(index).to.have.lengthOf(1);
      expect(index[0].sessionId).to.equal('s1');
      expect(index[0].sessionType).to.equal('live');
    });

    it('removes entry from index when session is ended', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'bundle-a');
      agent.setSessionId('s1');
      await createPreviewSessionCache(agent);
      agent.setSessionId('s2');
      await createPreviewSessionCache(agent);
      agent.setSessionId('s1');
      await removePreviewSessionCache(agent);
      const list = await listCachedPreviewSessions(project);
      expect(list[0].sessions.map((s) => s.sessionId)).to.deep.equal(['s2']);
    });

    it('falls back to directory scan when no index exists', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'bundle-a');
      agent.setSessionId('s1');
      await createPreviewSessionCache(agent);
      // Remove the index to simulate pre-index sessions
      const { unlink: unlinkFn } = await import('node:fs/promises');
      await unlinkFn(join(projectPath, '.sfdx', 'agents', 'bundle-a', 'sessions', 'index.json'));
      const list = await listCachedPreviewSessions(project);
      expect(list[0].sessions.map((s) => s.sessionId)).to.deep.equal(['s1']);
    });
  });

  describe('getCurrentPreviewSessionId', () => {
    it('returns undefined when no sessions', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'agent-1');
      const id = await getCurrentPreviewSessionId(project, agent);
      expect(id).to.be.undefined;
    });

    it('returns session id when exactly one session', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('sess-1');
      await createPreviewSessionCache(agent);
      const id = await getCurrentPreviewSessionId(project, agent);
      expect(id).to.equal('sess-1');
    });

    it('returns undefined when multiple sessions', async () => {
      const project = makeMockProject(() => projectPath);
      const agent = makeMockAgent(projectPath, 'agent-1');
      agent.setSessionId('sess-a');
      await createPreviewSessionCache(agent);
      agent.setSessionId('sess-b');
      await createPreviewSessionCache(agent);
      const id = await getCurrentPreviewSessionId(project, agent);
      expect(id).to.be.undefined;
    });
  });
});

describe('JWT Token Protection', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://test.my.salesforce.com';
    $$.SANDBOXES.CONNECTION.restore();
  });

  describe('useNamedUserJwt', () => {
    it('should upgrade connection with JWT token', async () => {
      $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
        accessToken: 'original-token',
        instanceUrl: connection.instanceUrl,
      });

      const requestStub = $$.SANDBOX.stub(connection, 'request').resolves({
        // eslint-disable-next-line camelcase
        access_token: 'jwt.token.here',
      });

      const upgradedConn = await useNamedUserJwt(connection);

      expect(upgradedConn.accessToken).to.equal('jwt.token.here');
      expect(requestStub.calledOnce).to.be.true;
    });

    it('should throw error if JWT response is missing access_token', async () => {
      $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
        accessToken: 'original-token',
        instanceUrl: connection.instanceUrl,
      });

      $$.SANDBOX.stub(connection, 'request').resolves({
        // Missing access_token
      });

      try {
        await useNamedUserJwt(connection);
        expect.fail('Expected useNamedUserJwt to throw an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('ApiAccessError');
        expect((error as SfError).message).to.include('access token');
      }
    });

    it('should throw error if JWT response has invalid token format', async () => {
      $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
        accessToken: 'original-token',
        instanceUrl: connection.instanceUrl,
      });

      $$.SANDBOX.stub(connection, 'request').resolves({
        // eslint-disable-next-line camelcase
        access_token: 'invalid-token-format', // Not a JWT (should have 3 parts separated by dots)
      });

      try {
        await useNamedUserJwt(connection);
        expect.fail('Expected useNamedUserJwt to throw an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('ApiAccessError');
        expect((error as SfError).message).to.include('JWT format');
      }
    });

    it('should refresh connection before upgrading if refresh token exists', async () => {
      const refreshStub = $$.SANDBOX.stub(connection, 'refreshAuth').resolves();
      $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({
        refreshToken: 'some-refresh-token',
      });
      $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
        accessToken: 'refreshed-token',
        instanceUrl: connection.instanceUrl,
      });

      $$.SANDBOX.stub(connection, 'request').resolves({
        // eslint-disable-next-line camelcase
        access_token: 'jwt.token.here',
      });

      await useNamedUserJwt(connection);

      expect(refreshStub.calledOnce).to.be.true;
    });

    it('should not refresh connection if no refresh token exists', async () => {
      const refreshStub = $$.SANDBOX.stub(connection, 'refreshAuth').resolves();
      $$.SANDBOX.stub(connection, 'getAuthInfoFields').returns({
        // No refreshToken
      });
      $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
        accessToken: 'original-token',
        instanceUrl: connection.instanceUrl,
      });

      $$.SANDBOX.stub(connection, 'request').resolves({
        // eslint-disable-next-line camelcase
        access_token: 'jwt.token.here',
      });

      await useNamedUserJwt(connection);

      expect(refreshStub.called).to.be.false;
    });
  });
});
// ====================================================
//        listSessionTraces / readSessionTrace / readTurnIndex
// ====================================================

const sampleTrace: PlannerResponse = {
  type: 'PlanSuccessResponse',
  planId: 'plan-1',
  sessionId: 'sess-1',
  intent: 'test intent',
  topic: 'test topic',
  plan: [],
};

const sampleTurnIndex: TurnIndex = {
  version: '1',
  sessionId: 'sess-1',
  agentId: 'agent-1',
  created: new Date().toISOString(),
  turns: [],
};

// Shared setup for the three trace-utility suites.
// Stubs SfProject.resolve so getHistoryDir routes into a temp directory
// without ever calling process.chdir (which holds a directory handle on
// Windows and causes EBUSY when afterEach tries to rmSync it).
function makeTraceTestContext(): { projectPath: () => string } {
  const $$ = new TestContext();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trace-test-'));
    $$.SANDBOX.stub(SfProject, 'resolve').resolves({ getPath: () => tempDir } as SfProject);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  return { projectPath: () => tempDir };
}

describe('listSessionTraces', () => {
  const ctx = makeTraceTestContext();

  it('returns empty array when traces directory does not exist', async () => {
    const result: TraceFileInfo[] = await listSessionTraces('agent-1', 'sess-1');
    expect(result).to.deep.equal([]);
  });

  it('returns one entry per trace file', async () => {
    const historyDir = await getHistoryDir('agent-1', 'sess-1');
    await writeTraceToHistory('plan-1', sampleTrace, historyDir);
    await writeTraceToHistory('plan-2', sampleTrace, historyDir);

    const result: TraceFileInfo[] = await listSessionTraces('agent-1', 'sess-1');
    expect(result).to.have.lengthOf(2);
    const planIds = result.map((r) => r.planId).sort();
    expect(planIds).to.deep.equal(['plan-1', 'plan-2']);
  });

  it('each entry has planId, path, size, and mtime', async () => {
    const historyDir = await getHistoryDir('agent-1', 'sess-1');
    await writeTraceToHistory('plan-1', sampleTrace, historyDir);

    const result: TraceFileInfo[] = await listSessionTraces('agent-1', 'sess-1');
    expect(result).to.have.lengthOf(1);
    expect(result[0].planId).to.equal('plan-1');
    expect(result[0].path).to.be.a('string').and.include('plan-1.json');
    expect(result[0].size).to.be.greaterThan(0);
    expect(result[0].mtime).to.be.instanceOf(Date);
  });

  it('ignores non-json files in traces directory', async () => {
    const historyDir = await getHistoryDir('agent-1', 'sess-1');
    await writeTraceToHistory('plan-1', sampleTrace, historyDir);
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(historyDir, 'traces', 'README.txt'), 'ignore me', 'utf-8');

    const result: TraceFileInfo[] = await listSessionTraces('agent-1', 'sess-1');
    expect(result).to.have.lengthOf(1);
    expect(result[0].planId).to.equal('plan-1');
  });

  // ctx is referenced to keep the linter happy; the fixture is set up by
  // makeTraceTestContext's beforeEach/afterEach above.
  after(() => void ctx);
});

describe('readSessionTrace', () => {
  const ctx = makeTraceTestContext();

  it('returns null when trace file does not exist', async () => {
    const result: PlannerResponse | null = await readSessionTrace('agent-1', 'sess-1', 'missing-plan');
    expect(result).to.be.null;
  });

  it('returns parsed PlannerResponse for an existing trace', async () => {
    const historyDir = await getHistoryDir('agent-1', 'sess-1');
    await writeTraceToHistory('plan-1', sampleTrace, historyDir);

    const result: PlannerResponse | null = await readSessionTrace('agent-1', 'sess-1', 'plan-1');
    expect(result).to.deep.equal(sampleTrace);
  });

  it('returns null when trace file contains invalid JSON', async () => {
    const historyDir = await getHistoryDir('agent-1', 'sess-1');
    const { mkdir: mkd, writeFile: wf } = await import('node:fs/promises');
    await mkd(join(historyDir, 'traces'), { recursive: true });
    await wf(join(historyDir, 'traces', 'bad-plan.json'), 'not json', 'utf-8');

    const result: PlannerResponse | null = await readSessionTrace('agent-1', 'sess-1', 'bad-plan');
    expect(result).to.be.null;
  });

  after(() => void ctx);
});

describe('readTurnIndex', () => {
  const ctx = makeTraceTestContext();

  it('returns null when turn-index.json does not exist', async () => {
    const result: TurnIndex | null = await readTurnIndex('agent-1', 'sess-1');
    expect(result).to.be.null;
  });

  it('returns parsed TurnIndex when file exists', async () => {
    const historyDir = await getHistoryDir('agent-1', 'sess-1');
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(historyDir, 'turn-index.json'), JSON.stringify(sampleTurnIndex), 'utf-8');

    const result: TurnIndex | null = await readTurnIndex('agent-1', 'sess-1');
    expect(result).to.deep.equal(sampleTurnIndex);
  });

  it('returns null when turn-index.json contains invalid JSON', async () => {
    const historyDir = await getHistoryDir('agent-1', 'sess-1');
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(historyDir, 'turn-index.json'), 'not json', 'utf-8');

    const result: TurnIndex | null = await readTurnIndex('agent-1', 'sess-1');
    expect(result).to.be.null;
  });

  after(() => void ctx);
});
