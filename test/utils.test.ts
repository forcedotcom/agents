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
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError } from '@salesforce/core';
import { useNamedUserJwt } from '../src/utils';

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
