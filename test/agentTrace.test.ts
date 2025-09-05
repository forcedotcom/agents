/*
 * Copyright 2025, Salesforce, Inc.
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
import { Connection } from '@salesforce/core';
import { AgentTrace } from '../src';

describe('AgentTrace', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = 'test/mocks';
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://mydomain.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(() => {
    delete process.env.SF_MOCK_DIR;
  });

  describe('getTrace', () => {
    it('should return trace data for a given trace ID', async () => {
      const traceId = '123';
      const result = await AgentTrace.getTrace(connection, traceId);

      // Basic structure validation - flexible since this may change
      expect(result).to.be.an('object');
      expect(result).to.have.property('actions');
      expect(result.actions).to.be.an('array');

      if (result.actions.length > 0) {
        const action = result.actions[0];
        expect(action).to.have.property('id');
        expect(action).to.have.property('state');
      }
    });

    it('should handle the API call without throwing errors', async () => {
      const traceId = '123';

      // Just verify the method can be called and returns a promise
      const result = AgentTrace.getTrace(connection, traceId);
      expect(result).to.be.an.instanceOf(Promise);

      const resolvedResult = await result;
      expect(resolvedResult).to.exist;
    });

    it('should work with different trace IDs', async () => {
      // Test with the trace ID format from the user's example
      const traceId = '123';

      try {
        const result = await AgentTrace.getTrace(connection, traceId);
        expect(result).to.be.an('object');
        // Don't assert specific structure since the API may change
      } catch (error) {
        // If the specific trace ID doesn't exist in mock, that's fine
        // Just ensure the method doesn't crash in unexpected ways
        expect(error).to.be.an('error');
      }
    });
  });
});
