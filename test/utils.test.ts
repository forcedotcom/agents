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

import { expect } from 'chai';
import { requestWithEndpointFallback } from '../src/utils';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError } from '@salesforce/core';
import { useNamedUserJwt } from '../src/utils';

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
    expect((requestStub.firstCall.args[0] as any).url).to.equal('https://api.salesforce.com/einstein/ai-agent/v1/test');
  });

  it('should retry with test endpoint on 404', async () => {
    const error404 = new Error('Not Found');
    (error404 as any).name = 'ERROR_HTTP_404';

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
    expect((requestStub.firstCall.args[0] as any).url).to.equal('https://api.salesforce.com/einstein/ai-agent/v1/test');
    expect((requestStub.secondCall.args[0] as any).url).to.equal(
      'https://test.api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should retry with dev endpoint after test endpoint 404', async () => {
    const error404 = new Error('Not Found');
    (error404 as any).name = 'ERROR_HTTP_404';

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
    expect((requestStub.firstCall.args[0] as any).url).to.equal('https://api.salesforce.com/einstein/ai-agent/v1/test');
    expect((requestStub.secondCall.args[0] as any).url).to.equal(
      'https://test.api.salesforce.com/einstein/ai-agent/v1/test'
    );
    expect((requestStub.thirdCall.args[0] as any).url).to.equal(
      'https://dev.api.salesforce.com/einstein/ai-agent/v1/test'
    );
  });

  it('should throw AgentApiNotFound after all endpoints fail with 404', async () => {
    const error404 = new Error('Not Found');
    (error404 as any).name = 'ERROR_HTTP_404';

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
      expect((error as SfError).message).to.include('production api.salesforce.com');
      expect((error as SfError).message).to.include('test.api.salesforce.com');
      expect((error as SfError).message).to.include('dev.api.salesforce.com');
    }

    expect(requestStub.calledThrice).to.be.true;
  });

  it('should throw immediately on non-404 errors', async () => {
    const error500 = new Error('Internal Server Error');
    (error500 as any).name = 'ERROR_HTTP_500';

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
    expect((requestStub.firstCall.args[0] as any).url).to.equal('https://api.salesforce.com/einstein/ai-agent/v1/test');
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

    // Stub the nameduser endpoint request
    // eslint-disable-next-line camelcase
    $$.SANDBOX.stub(connection, 'request').resolves({ access_token: 'new-jwt-token' });

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

    // Stub the nameduser endpoint request
    // eslint-disable-next-line camelcase
    $$.SANDBOX.stub(connection, 'request').resolves({ access_token: 'new-jwt-token' });

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

    // Stub the nameduser endpoint request
    // eslint-disable-next-line camelcase
    $$.SANDBOX.stub(connection, 'request').resolves({ access_token: 'new-jwt-token' });

    const result = await useNamedUserJwt(connection);

    expect(result.accessToken).to.equal('new-jwt-token');
  });
});
