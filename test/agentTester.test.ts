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
import { AgentTestResultsResponse, AgentTester, convertTestResultsToFormat } from '../src/agentTester';

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

  describe('results', () => {
    it('should return results of completed test run', async () => {
      const tester = new AgentTester(connection);
      await tester.start('suiteId');
      const output = await tester.results('4KBSM000000003F4AQ');
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

describe('human format', () => {
  it('should transform test results to human readable format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_results.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestResultsResponse;
    const output = await convertTestResultsToFormat(input, 'human');
    expect(output).to.be.ok;
  });
});

describe('junit formatter', () => {
  it('should transform test results to JUnit format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_results.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestResultsResponse;
    const output = await convertTestResultsToFormat(input, 'junit');
    expect(output).to.deep.equal(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Copilot_for_Salesforce" tests="2" failures="1" time="20000">
  <property name="status" value="COMPLETED"></property>
  <property name="start-time" value="2024-11-28T12:00:00Z"></property>
  <property name="end-time" value="2024-11-28T12:00:48.56Z"></property>
  <testsuite name="CRM_Sanity_v1.1" time="10000" assertions="3"></testsuite>
  <testsuite name="CRM_Sanity_v1.2" time="10000" assertions="3">
    <failure message="Actual response does not match the expected response" name="action_sequence_match"></failure>
    <failure message="Actual response does not match the expected response" name="bot_response_rating"></failure>
  </testsuite>
</testsuites>`);
  });
});

describe('tap formatter', () => {
  it('should transform test results to TAP format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_results.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestResultsResponse;
    const output = await convertTestResultsToFormat(input, 'tap');
    expect(output).to.deep.equal(`Tap Version 14
1..6
ok 1 CRM_Sanity_v1.1
ok 2 CRM_Sanity_v1.1
ok 3 CRM_Sanity_v1.1
ok 4 CRM_Sanity_v1.2
not ok 5 CRM_Sanity_v1.2
  ---
  message: Actual response does not match the expected response
  expectation: action_sequence_match
  actual: ["IdentifyRecordByName","QueryRecords"]
  expected: ["IdentifyRecordByName","QueryRecords","GetActivitiesTimeline"]
  ...
not ok 6 CRM_Sanity_v1.2
  ---
  message: Actual response does not match the expected response
  expectation: bot_response_rating
  actual: It looks like I am unable to find the information you are looking for due to access restrictions. How else can I assist you?
  expected: Summary of open cases and activities associated with timeline
  ...`);
  });
});
