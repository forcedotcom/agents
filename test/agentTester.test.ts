/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import fs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import sinon from 'sinon';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import {
  AgentTestResultsResponse,
  AgentTester,
  convertTestResultsToFormat,
  generateTestSpec,
} from '../src/agentTester';

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

  describe('create', () => {
    const yml = `name: Test
description: Test
subjectType: AGENT
subjectName: MyAgent
testCases:
  - utterance: List contact names associated with Acme account
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available name available with Acme are listed
    expectedTopic: GeneralCRM
  - utterance: List contact emails associated with Acme account
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available emails available with Acme are listed
    expectedTopic: GeneralCRM
`;
    beforeEach(() => {
      sinon.stub(fs, 'writeFile').resolves();
      sinon.stub(fs, 'mkdir').resolves();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should generate preview of AiEvaluationDefinition', async () => {
      const tester = new AgentTester(connection);
      sinon.stub(fs, 'readFile').resolves(yml);
      sinon.stub(tester, 'list').resolves([]);
      const { contents } = await tester.create('test.yaml', {
        outputDir: 'tmp',
        preview: true,
      });

      expect(contents).to.equal(`<AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
  <description>Test</description>
  <name>Test</name>
  <subjectType>AGENT</subjectType>
  <subjectName>MyAgent</subjectName>
  <testSetName>CliTestSet</testSetName>
</AiEvaluationDefinition>
`);
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
    <failure message="Actual response does not match the expected response" name="expectedActions"></failure>
    <failure message="Actual response does not match the expected response" name="expectedOutcome"></failure>
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
  expectation: expectedActions
  actual: ["IdentifyRecordByName","QueryRecords"]
  expected: ["IdentifyRecordByName","QueryRecords","GetActivitiesTimeline"]
  ...
not ok 6 CRM_Sanity_v1.2
  ---
  message: Actual response does not match the expected response
  expectation: expectedOutcome
  actual: It looks like I am unable to find the information you are looking for due to access restrictions. How else can I assist you?
  expected: Summary of open cases and activities associated with timeline
  ...`);
  });
});

describe('generateTestSpec', () => {
  let writeFileStub: sinon.SinonStub;
  beforeEach(() => {
    writeFileStub = sinon.stub(fs, 'writeFile');
    sinon.stub(fs, 'mkdir').resolves();
  });
  afterEach(() => {
    sinon.restore();
  });

  it('should generate a yaml file', async () => {
    await generateTestSpec(
      {
        name: 'Test',
        description: 'Test',
        subjectType: 'AGENT',
        subjectName: 'MyAgent',
        testCases: [
          {
            utterance: 'List contact names associated with Acme account',
            expectedActions: ['IdentifyRecordByName', 'QueryRecords'],
            expectedOutcome: 'contacts available name available with Acme are listed',
            expectedTopic: 'GeneralCRM',
          },
          {
            utterance: 'List contact emails associated with Acme account',
            expectedActions: ['IdentifyRecordByName', 'QueryRecords'],
            expectedOutcome: 'contacts available emails available with Acme are listed',
            expectedTopic: 'GeneralCRM',
          },
        ],
      },
      'test-spec.yaml'
    );
    expect(writeFileStub.firstCall.args).to.deep.equal([
      'test-spec.yaml',
      `name: Test
description: Test
subjectType: AGENT
subjectName: MyAgent
testCases:
  - utterance: List contact names associated with Acme account
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available name available with Acme are listed
    expectedTopic: GeneralCRM
  - utterance: List contact emails associated with Acme account
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available emails available with Acme are listed
    expectedTopic: GeneralCRM
`,
    ]);
  });

  it('should remove empty strings', async () => {
    await generateTestSpec(
      {
        name: 'Test',
        description: '',
        subjectType: 'AGENT',
        subjectName: 'MyAgent',
        testCases: [
          {
            utterance: 'List contact names associated with Acme account',
            expectedActions: ['IdentifyRecordByName', 'QueryRecords'],
            expectedOutcome: 'contacts available name available with Acme are listed',
            expectedTopic: 'GeneralCRM',
          },
        ],
      },
      'test-spec.yaml'
    );
    expect(writeFileStub.firstCall.args).to.deep.equal([
      'test-spec.yaml',
      `name: Test
subjectType: AGENT
subjectName: MyAgent
testCases:
  - utterance: List contact names associated with Acme account
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available name available with Acme are listed
    expectedTopic: GeneralCRM
`,
    ]);
  });

  it('should remove undefined values', async () => {
    await generateTestSpec(
      {
        name: 'Test',
        description: undefined,
        subjectType: 'AGENT',
        subjectName: 'MyAgent',
        testCases: [
          {
            utterance: 'List contact names associated with Acme account',
            expectedActions: ['IdentifyRecordByName', 'QueryRecords'],
            expectedOutcome: 'contacts available name available with Acme are listed',
            expectedTopic: 'GeneralCRM',
          },
        ],
      },
      'test-spec.yaml'
    );
    expect(writeFileStub.firstCall.args).to.deep.equal([
      'test-spec.yaml',
      `name: Test
subjectType: AGENT
subjectName: MyAgent
testCases:
  - utterance: List contact names associated with Acme account
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available name available with Acme are listed
    expectedTopic: GeneralCRM
`,
    ]);
  });
});
