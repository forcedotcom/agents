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
} from '../src/utils';

describe('requestWithEndpointFallback', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://test.my.salesforce.com';
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

    expect(requestStub.calledThrice).to.be.true;
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
    $$.SANDBOX.stub(connection, 'request').resolves(null as never);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal('Error obtaining API token: empty response.');
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions).to.have.lengthOf(4);
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
    } as never);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal('Error obtaining API token: invalid or missing access token.');
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions).to.have.lengthOf(4);
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
    } as never);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal('Error obtaining API token: invalid or missing access token.');
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions).to.have.lengthOf(4);
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
    } as never);

    try {
      await useNamedUserJwt(connection);
      expect.fail('Expected error was not thrown');
    } catch (error) {
      expect(error).to.be.instanceOf(SfError);
      expect((error as SfError).name).to.equal('ApiAccessError');
      expect((error as SfError).message).to.equal('Error obtaining API token: invalid or missing access token.');
      expect((error as SfError).actions).to.exist;
      expect((error as SfError).actions).to.have.lengthOf(4);
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
    } as never);

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
      expect((error as SfError).actions).to.have.lengthOf(4);
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
    } as never);

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
      expect((error as SfError).actions).to.have.lengthOf(4);
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
      expect((error as SfError).message).to.equal('Error obtaining API token');
      expect((error as SfError).cause).to.equal(networkError);
    }
  });
});

describe('detectTestRunnerFromId', () => {
  it('detects NGT from 3A2 prefix', () => {
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

  it('returns ngt when only AiTestingDefinition exists', async () => {
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

  it('returns ngt when only AiTestingDefinition exists (no testDefinitionName)', async () => {
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
