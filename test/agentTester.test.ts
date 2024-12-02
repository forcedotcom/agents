/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { AgentTester } from '../src/agentTester';

describe('AgentTester', () => {
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

  describe('start', () => {
    it('should start test run', async () => {
      const tester = new AgentTester(connection);
      const output = await tester.start('suiteId');
      // TODO: make this assertion more meaningful
      expect(output).to.be.ok;
    });
  });

  describe('status', () => {
    it('should return status of test run', async () => {
      const tester = new AgentTester(connection);
      await tester.start('suiteId');
      const output = await tester.status('4KBSM000000003F4AQ');
      expect(output).to.be.ok;
      expect(output).to.deep.equal({
        status: 'IN_PROGRESS',
        startTime: '2024-11-13T15:00:00.000Z',
      });
    });
  });

  describe('poll', () => {
    it('should poll until test run is complete (human format)', async () => {
      const tester = new AgentTester(connection);
      await tester.start('suiteId');
      const output = await tester.poll('4KBSM000000003F4AQ');
      expect(output).to.be.ok;
      // TODO: make these assertions more meaningful
      expect(output.formatted).to.include('Test Case #1');
      expect(output.formatted).to.include('Test Case #2');
      expect(output.response.testCases[0].status).to.equal('COMPLETED');
    });

    it('should poll until test run is complete (json format)', async () => {
      const tester = new AgentTester(connection);
      await tester.start('suiteId');
      const output = await tester.poll('4KBSM000000003F4AQ', { format: 'json' });
      expect(output).to.be.ok;
      // TODO: make these assertions more meaningful
      expect(JSON.parse(output.formatted)).to.deep.equal(output.response);
      expect(output.response.testCases[0].status).to.equal('COMPLETED');
    });
  });

  describe('details', () => {
    it('should return details of completed test run', async () => {
      const tester = new AgentTester(connection);
      await tester.start('suiteId');
      const output = await tester.details('4KBSM000000003F4AQ');
      // TODO: make this assertion more meaningful
      expect(output).to.be.ok;
    });
  });

  describe('cancel', () => {
    it('should cancel test run', async () => {
      const tester = new AgentTester(connection);
      await tester.start('suiteId');
      const output = await tester.cancel('4KBSM000000003F4AQ');
      expect(output.success).to.be.true;
    });
  });
});
