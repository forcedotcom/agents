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
import { AuthInfo, Connection } from '@salesforce/core';
import { TestContext } from '@salesforce/core/testSetup';
import sinon from 'sinon';
import * as utils from '../src/utils';
import { ConnectionManager } from '../src/connectionManager';

const buildJwt = (payload: Record<string, unknown>): string => {
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
};

describe('ConnectionManager', () => {
  const $$ = new TestContext();

  afterEach(() => {
    sinon.restore();
  });

  it('create should isolate JWT upgrade and keep caller connection untouched', async () => {
    const callerConnection = {
      accessToken: 'caller-standard-token',
      getUsername: () => 'test@example.com',
    } as unknown as Connection;

    const standardConnection = { accessToken: 'standard-token' } as Connection;
    const jwtCandidateConnection = { accessToken: 'jwt-candidate-token' } as Connection;
    const jwtToken = buildJwt({
      sub: '005xx0000012345',
      iss: 'https://login.salesforce.com',
      exp: Math.floor(Date.now() / 1000) + 60 * 10,
    });

    $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
    $$.SANDBOX.stub(Connection, 'create').onFirstCall().resolves(standardConnection).onSecondCall().resolves(jwtCandidateConnection);

    const useNamedUserJwtStub = $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (connection) => {
      connection.accessToken = jwtToken;
      return connection;
    });

    const manager = await ConnectionManager.create(callerConnection);

    expect(useNamedUserJwtStub.calledOnceWithExactly(jwtCandidateConnection)).to.equal(true);
    expect(manager.getStandardConnection()).to.equal(standardConnection);
    expect(manager.getJwtConnection()).to.equal(jwtCandidateConnection);
    expect(manager.getJwtConnection()).to.not.equal(manager.getStandardConnection());
    expect(callerConnection.accessToken).to.equal('caller-standard-token');
  });

  it('create should build both standard and jwt connections from the same username', async () => {
    const callerConnection = {
      getUsername: () => 'another@example.com',
    } as unknown as Connection;

    const standardConnection = { accessToken: 'std' } as Connection;
    const jwtCandidateConnection = { accessToken: 'candidate' } as Connection;
    const jwtToken = buildJwt({
      sub: '005xx0000099999',
      iss: 'https://login.salesforce.com',
      exp: Math.floor(Date.now() / 1000) + 60 * 10,
    });

    const authInfoCreateStub = $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
    const connectionCreateStub = $$.SANDBOX
      .stub(Connection, 'create')
      .onFirstCall()
      .resolves(standardConnection)
      .onSecondCall()
      .resolves(jwtCandidateConnection);

    $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (connection) => {
      connection.accessToken = jwtToken;
      return connection;
    });

    await ConnectionManager.create(callerConnection);

    expect(authInfoCreateStub.calledTwice).to.equal(true);
    expect(connectionCreateStub.calledTwice).to.equal(true);
    expect(authInfoCreateStub.firstCall.args[0]).to.deep.equal({ username: 'another@example.com' });
    expect(authInfoCreateStub.secondCall.args[0]).to.deep.equal({ username: 'another@example.com' });
  });
});
