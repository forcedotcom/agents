/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { readFile } from 'node:fs/promises';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { AgentTestDetailsResponse, AgentTester, junitFormat, tapFormat } from '../src/agentTester';

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
    it('should poll until test run is complete', async () => {
      const tester = new AgentTester(connection);
      await tester.start('suiteId');
      const response = await tester.poll('4KBSM000000003F4AQ');
      expect(response).to.be.ok;
      // TODO: make these assertions more meaningful
      expect(response.testSet.testCases[0].status).to.equal('COMPLETED');
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

describe('junitFormatter', () => {
  it('should transform test results to JUnit format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_details.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestDetailsResponse;
    const output = await junitFormat(input);
    expect(output).to.deep.equal(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Copilot_for_Salesforce" tests="2" failures="1" time="20000">
  <property name="status" value="COMPLETED"></property>
  <property name="start-time" value="2024-11-28T12:00:00Z"></property>
  <property name="end-time" value="2024-11-28T12:05:00Z"></property>
  <testsuite name="CRM_Sanity_v1.1" time="10000" assertions="2"></testsuite>
  <testsuite name="CRM_Sanity_v1.2" time="10000" assertions="2">
    <failure message="Expected &quot;Result D&quot; but got &quot;Result C&quot;."></failure>
    <failure message="Expected &quot;Result D&quot; but got &quot;Result C&quot;."></failure>
  </testsuite>
</testsuites>`);
  });
});

describe('tapFormatter', () => {
  it('should transform test results to TAP format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_details.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestDetailsResponse;
    const output = await tapFormat(input);
    expect(output).to.deep.equal(`Tap Version 14
1..4
ok 1 CRM_Sanity_v1.1
ok 2 CRM_Sanity_v1.1
not ok 3 CRM_Sanity_v1.2
  ---
  message: Expected "Result D" but got "Result C".
  expectation: topic_sequence_match
  actual: Result C
  expected: Result D
  ...
not ok 4 CRM_Sanity_v1.2
  ---
  message: Expected "Result D" but got "Result C".
  expectation: topic_sequence_match
  actual: Result C
  expected: Result D
  ...`);
  });
});
