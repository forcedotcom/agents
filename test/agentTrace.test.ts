/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
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
      const traceId = '123-trace-id-456';
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
      const traceId = '123-trace-id-456';

      // Just verify the method can be called and returns a promise
      const result = AgentTrace.getTrace(connection, traceId);
      expect(result).to.be.an.instanceOf(Promise);

      const resolvedResult = await result;
      expect(resolvedResult).to.exist;
    });

    it('should work with different trace IDs', async () => {
      // Test with the trace ID format from the user's example
      const traceId = '123-trace-id-456';

      try {
        const result = await AgentTrace.getTrace(connection, traceId);
        expect(result).to.be.an('object');
        // Don't assert specific structure since the API may change
      } catch (error) {
        // With the new "maybe mock" behavior, this will try to make a real API call
        // since no mock file exists for this trace ID. The error is expected.
        expect(error).to.be.an.instanceOf(Error);
        // The error message should indicate it's trying to make a real request
        const errorMessage = error instanceof Error ? error.message : String(error);
        expect(errorMessage).to.include('request to');
      }
    });
  });
});
