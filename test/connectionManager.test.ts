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
import { AuthInfo, Connection, SfError } from '@salesforce/core';
import { ConnectionManager, managerFor, setManagerForTesting } from '../src/connectionManager';
import * as utils from '../src/utils';

// Build a minimally valid JWT (header.payload.signature) for tests.
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

const validPayload = {
  sub: 'user@example.com',
  iss: 'https://login.salesforce.com',
  // eslint-disable-next-line camelcase
  sfdc_app_id: 'app-123',
  scope: 'chatbot_api sfap_api web',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
};

describe('ConnectionManager', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let callerConnection: Connection;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    callerConnection = await testOrg.getConnection();
    callerConnection.instanceUrl = 'https://test.my.salesforce.com';
    callerConnection.accessToken = 'caller-original-token';
    $$.SANDBOXES.CONNECTION.restore();
  });

  describe('create', () => {
    it('throws when the supplied connection has no username', async () => {
      $$.SANDBOX.stub(callerConnection, 'getUsername').returns(undefined);

      try {
        await ConnectionManager.create(callerConnection);
        expect.fail('expected create to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('MissingUsername');
      }
    });

    it('does not mutate the caller-supplied connection', async () => {
      // Stub useNamedUserJwt so it operates only on the seed Connection that ConnectionManager creates.
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(validPayload);
        return conn;
      });
      // Stub AuthInfo.create / Connection.create so the manager can build fresh connections from the username.
      const seedConn = await testOrg.getConnection();
      seedConn.accessToken = 'seed-token';
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      $$.SANDBOX.stub(Connection, 'create').resolves(seedConn);

      await ConnectionManager.create(callerConnection);

      expect(callerConnection.accessToken).to.equal('caller-original-token');
    });

    it('returns a manager whose JWT and standard connections are distinct objects', async () => {
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(validPayload);
        return conn;
      });
      const standardConn = await testOrg.getConnection();
      const jwtConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      const createStub = $$.SANDBOX.stub(Connection, 'create');
      createStub.onFirstCall().resolves(standardConn);
      createStub.onSecondCall().resolves(jwtConn);

      const manager = await ConnectionManager.create(callerConnection);

      expect(manager.getStandardConnection()).to.equal(standardConn);
      expect(manager.getJwtConnection()).to.equal(jwtConn);
      expect(manager.getStandardConnection()).to.not.equal(manager.getJwtConnection());
      expect(manager.getJwtConnection().accessToken).to.equal(makeJwt(validPayload));
    });

    it('throws InvalidJwtToken when the upgraded token is malformed', async () => {
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = 'not-a-jwt';
        return conn;
      });
      const seedConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      $$.SANDBOX.stub(Connection, 'create').resolves(seedConn);

      try {
        await ConnectionManager.create(callerConnection);
        expect.fail('expected create to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('InvalidJwtToken');
      }
    });

    it('throws InvalidJwtToken when the upgraded token is expired', async () => {
      const expiredPayload = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 60 };
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(expiredPayload);
        return conn;
      });
      const seedConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      $$.SANDBOX.stub(Connection, 'create').resolves(seedConn);

      try {
        await ConnectionManager.create(callerConnection);
        expect.fail('expected create to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('InvalidJwtToken');
        const actions = (err as SfError).actions ?? [];
        expect(actions.some((a) => a.includes('expired'))).to.be.true;
      }
    });
  });

  describe('inspectJwt', () => {
    it('reports a valid JWT with parsed claims', async () => {
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(validPayload);
        return conn;
      });
      const seedConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      $$.SANDBOX.stub(Connection, 'create').resolves(seedConn);

      const manager = await ConnectionManager.create(callerConnection);
      const result = manager.inspectJwt();

      expect(result.isValid).to.be.true;
      expect(result.hasRequiredFields).to.be.true;
      expect(result.isExpired).to.be.false;
      expect(result.subject).to.equal(validPayload.sub);
      expect(result.issuer).to.equal(validPayload.iss);
      expect(result.appId).to.equal(validPayload.sfdc_app_id);
      expect(result.scopes).to.deep.equal(['chatbot_api', 'sfap_api', 'web']);
    });

    it('reports an invalid result when the connection has no access token', async () => {
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(validPayload);
        return conn;
      });
      const seedConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      $$.SANDBOX.stub(Connection, 'create').resolves(seedConn);

      const manager = await ConnectionManager.create(callerConnection);
      // Simulate a token getting cleared somehow.
      manager.getJwtConnection().accessToken = undefined;
      const result = manager.inspectJwt();

      expect(result.isValid).to.be.false;
      expect(result.missingFields).to.include('token');
    });
  });

  describe('refreshStandardConnection', () => {
    it('clears and refreshes only the standard connection', async () => {
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(validPayload);
        return conn;
      });
      const standardConn = await testOrg.getConnection();
      standardConn.accessToken = 'standard-token';
      const jwtConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      const createStub = $$.SANDBOX.stub(Connection, 'create');
      createStub.onFirstCall().resolves(standardConn);
      createStub.onSecondCall().resolves(jwtConn);

      const refreshAuthStub = $$.SANDBOX.stub(standardConn, 'refreshAuth').resolves();
      const jwtRefreshStub = $$.SANDBOX.stub(jwtConn, 'refreshAuth').resolves();

      const manager = await ConnectionManager.create(callerConnection);
      await manager.refreshStandardConnection();

      expect(refreshAuthStub.calledOnce).to.be.true;
      expect(jwtRefreshStub.called).to.be.false;
      expect(standardConn.accessToken).to.be.undefined;
    });
  });

  describe('managerFor', () => {
    it('returns the same manager for repeat calls with the same Connection', async () => {
      const fake = {} as ConnectionManager;
      setManagerForTesting(callerConnection, fake);

      const a = await managerFor(callerConnection);
      const b = await managerFor(callerConnection);

      expect(a).to.equal(fake);
      expect(b).to.equal(fake);
    });

    it('returns distinct managers for different Connection objects', async () => {
      const otherConn = await testOrg.getConnection();
      const m1 = {} as ConnectionManager;
      const m2 = {} as ConnectionManager;
      setManagerForTesting(callerConnection, m1);
      setManagerForTesting(otherConn, m2);

      expect(await managerFor(callerConnection)).to.equal(m1);
      expect(await managerFor(otherConn)).to.equal(m2);
    });

    it('deduplicates concurrent first-time callers to a single bootstrap', async () => {
      const otherConn = await testOrg.getConnection();
      // No seeded manager — let the real ConnectionManager.create run, but stub its
      // dependencies so we can count bootstraps.
      const stub = $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(validPayload);
        return conn;
      });
      const seedConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      $$.SANDBOX.stub(Connection, 'create').resolves(seedConn);

      const [a, b] = await Promise.all([managerFor(otherConn), managerFor(otherConn)]);

      expect(a).to.equal(b);
      expect(stub.callCount).to.equal(1);
    });

    it('evicts the cache entry when bootstrap fails so a retry can succeed', async () => {
      const otherConn = await testOrg.getConnection();
      $$.SANDBOX.stub(otherConn, 'getUsername')
        .onFirstCall()
        .returns(undefined)
        .onSecondCall()
        .returns('u@example.com');
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').callsFake(async (conn: Connection) => {
        conn.accessToken = makeJwt(validPayload);
        return conn;
      });
      const seedConn = await testOrg.getConnection();
      $$.SANDBOX.stub(AuthInfo, 'create').resolves({} as AuthInfo);
      $$.SANDBOX.stub(Connection, 'create').resolves(seedConn);

      // First call fails with MissingUsername.
      try {
        await managerFor(otherConn);
        expect.fail('expected first managerFor call to throw');
      } catch (err) {
        expect((err as SfError).name).to.equal('MissingUsername');
      }

      // Second call should retry and succeed because the failed entry was evicted.
      const manager = await managerFor(otherConn);
      expect(manager).to.be.instanceOf(ConnectionManager);
    });
  });
});
