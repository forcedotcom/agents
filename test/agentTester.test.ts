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
        status: 'NEW',
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
      expect(response.testCases[0].status).to.equal('COMPLETED');
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

      expect(contents).to.equal(`<?xml version="1.0" encoding="UTF-8"?>
<AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
  <description>Test</description>
  <name>Test</name>
  <subjectType>AGENT</subjectType>
  <subjectName>MyAgent</subjectName>
  <testCase>
    <number>1</number>
    <inputs>
      <utterance>List contact names associated with Acme account</utterance>
    </inputs>
    <expectation>
      <name>topic_sequence_match</name>
      <expectedValue>GeneralCRM</expectedValue>
    </expectation>
    <expectation>
      <name>action_sequence_match</name>
      <expectedValue>[&quot;IdentifyRecordByName&quot;,&quot;QueryRecords&quot;]</expectedValue>
    </expectation>
    <expectation>
      <name>bot_response_rating</name>
      <expectedValue>contacts available name available with Acme are listed</expectedValue>
    </expectation>
  </testCase>
  <testCase>
    <number>2</number>
    <inputs>
      <utterance>List contact emails associated with Acme account</utterance>
    </inputs>
    <expectation>
      <name>topic_sequence_match</name>
      <expectedValue>GeneralCRM</expectedValue>
    </expectation>
    <expectation>
      <name>action_sequence_match</name>
      <expectedValue>[&quot;IdentifyRecordByName&quot;,&quot;QueryRecords&quot;]</expectedValue>
    </expectation>
    <expectation>
      <name>bot_response_rating</name>
      <expectedValue>contacts available emails available with Acme are listed</expectedValue>
    </expectation>
  </testCase>
</AiEvaluationDefinition>
`);
    });
  });
});

describe('junit formatter', () => {
  it('should transform test results to JUnit format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_results/4.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestResultsResponse;
    const output = await convertTestResultsToFormat(input, 'junit');
    expect(output).to.equal(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Guest_Experience_Agent" tests="3" failures="1" time="30000">
  <property name="status" value="COMPLETED"></property>
  <property name="start-time" value="2025-01-07T12:00:00Z"></property>
  <property name="end-time" value="2025-01-07T12:00:10.35Z"></property>
  <testsuite name="1" time="10000" assertions="3"></testsuite>
  <testsuite name="2" time="10000" assertions="3"></testsuite>
  <testsuite name="3" time="10000" assertions="3">
    <failure message="An Apex error occurred: System.CalloutException: Bad Response: System.HttpResponse[Status=Not Found, StatusCode=404]" name="bot_response_rating"></failure>
  </testsuite>
</testsuites>`);
  });
});

describe('tap formatter', () => {
  it('should transform test results to TAP format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_results/4.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestResultsResponse;
    const output = await convertTestResultsToFormat(input, 'tap');
    expect(output).to.equal(`Tap Version 14
1..9
ok 1 1.topic_sequence_match
ok 2 1.action_sequence_match
ok 3 1.bot_response_rating
ok 4 2.topic_sequence_match
ok 5 2.action_sequence_match
ok 6 2.bot_response_rating
ok 7 3.topic_sequence_match
ok 8 3.action_sequence_match
not ok 9 3.bot_response_rating
  ---
  message: An Apex error occurred: System.CalloutException: Bad Response: System.HttpResponse[Status=Not Found, StatusCode=404]
  expectation: bot_response_rating
  actual: It looks like I am unable to check the weather. There's something wrong with the Weather Service. How else can I assist you?
  expected: The answer should start by describing expected conditions, for example "clear skies" or "50% chance of rain" and conclude with a range of high and low temperatures in degrees fahrenheit.
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
