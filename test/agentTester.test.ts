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
  AgentTester,
  convertTestResultsToFormat,
  writeTestSpec,
  generateTestSpecFromAiEvalDefinition,
  normalizeResults,
  humanFriendlyName,
} from '../src/agentTester';
import { type AgentTestResultsResponse } from '../src/types';

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

  describe('humanFriendlyName', () => {
    it('handles current api responses', () => {
      expect(humanFriendlyName('bot_response_rating')).to.equal('Outcome');
      expect(humanFriendlyName('action_sequence_match')).to.equal('Action');
      expect(humanFriendlyName('topic_sequence_match')).to.equal('Topic');
      // an unknown value will return itself
      expect(humanFriendlyName('unknown_sequence_match')).to.equal('unknown_sequence_match');

      // it will handle the upcoming api changes
      expect(humanFriendlyName('output_validation')).to.equal('Outcome');
      expect(humanFriendlyName('actions_assertion')).to.equal('Action');
      expect(humanFriendlyName('topic_assertion')).to.equal('Topic');
      // it will handle new metrics
      expect(humanFriendlyName('output_latency_milliseconds')).to.equal('Output Latency');
      expect(humanFriendlyName('instruction_following')).to.equal('Instruction Following');
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
      const { contents } = await tester.create('MyTest', 'test.yaml', {
        outputDir: 'tmp',
        preview: true,
      });

      expect(contents).to.equal(`<?xml version="1.0" encoding="UTF-8"?>
<AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Test</description>
    <name>Test</name>
    <subjectName>MyAgent</subjectName>
    <subjectType>AGENT</subjectType>
    <testCase>
        <expectation>
            <expectedValue>GeneralCRM</expectedValue>
            <name>topic_sequence_match</name>
        </expectation>
        <expectation>
            <expectedValue>[&quot;IdentifyRecordByName&quot;,&quot;QueryRecords&quot;]</expectedValue>
            <name>action_sequence_match</name>
        </expectation>
        <expectation>
            <expectedValue>contacts available name available with Acme are listed</expectedValue>
            <name>bot_response_rating</name>
        </expectation>
        <inputs>
            <utterance>List contact names associated with Acme account</utterance>
        </inputs>
        <number>1</number>
    </testCase>
    <testCase>
        <expectation>
            <expectedValue>GeneralCRM</expectedValue>
            <name>topic_sequence_match</name>
        </expectation>
        <expectation>
            <expectedValue>[&quot;IdentifyRecordByName&quot;,&quot;QueryRecords&quot;]</expectedValue>
            <name>action_sequence_match</name>
        </expectation>
        <expectation>
            <expectedValue>contacts available emails available with Acme are listed</expectedValue>
            <name>bot_response_rating</name>
        </expectation>
        <inputs>
            <utterance>List contact emails associated with Acme account</utterance>
        </inputs>
        <number>2</number>
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

describe('writeTestSpec', () => {
  let writeFileStub: sinon.SinonStub;
  beforeEach(() => {
    writeFileStub = sinon.stub(fs, 'writeFile');
    sinon.stub(fs, 'mkdir').resolves();
  });
  afterEach(() => {
    sinon.restore();
  });

  it('should generate a yaml file', async () => {
    await writeTestSpec(
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
    await writeTestSpec(
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
    await writeTestSpec(
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

describe('generateTestSpecFromAiEvalDefinition', () => {
  let readFileStub: sinon.SinonStub;

  beforeEach(() => {
    readFileStub = sinon.stub(fs, 'readFile');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should parse AiEvaluationDefinition XML into TestSpec', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
      <description>Test Description</description>
      <name>TestSpec</name>
      <subjectType>AGENT</subjectType>
      <subjectName>WeatherBot</subjectName>
      <subjectVersion>1</subjectVersion>
      <testCase>
        <inputs>
          <utterance>What's the weather like?</utterance>
        </inputs>
        <expectation>
          <name>topic_sequence_match</name>
          <expectedValue>Weather</expectedValue>
        </expectation>
        <expectation>
          <name>action_sequence_match</name>
          <expectedValue>["GetLocation","GetWeather"]</expectedValue>
        </expectation>
        <expectation>
          <name>bot_response_rating</name>
          <expectedValue>Sunny with a high of 75F</expectedValue>
        </expectation>
      </testCase>
    </AiEvaluationDefinition>`;

    readFileStub.resolves(xml);

    const result = await generateTestSpecFromAiEvalDefinition('test.xml');

    expect(result).to.deep.equal({
      name: 'TestSpec',
      description: 'Test Description',
      subjectType: 'AGENT',
      subjectName: 'WeatherBot',
      subjectVersion: 1,
      testCases: [
        {
          utterance: "What's the weather like?",
          expectedTopic: 'Weather',
          expectedActions: ['GetLocation', 'GetWeather'],
          expectedOutcome: 'Sunny with a high of 75F',
        },
      ],
    });
  });
  it('should parse 258 AiEvaluationDefinition XML into TestSpec', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
      <description>Test Description</description>
      <name>TestSpec</name>
      <subjectType>AGENT</subjectType>
      <subjectName>WeatherBot</subjectName>
      <subjectVersion>1</subjectVersion>
      <testCase>
        <inputs>
          <utterance>What's the weather like?</utterance>
        </inputs>
        <expectation>
          <name>topic_assertion</name>
          <expectedValue>Weather</expectedValue>
        </expectation>
        <expectation>
          <name>actions_assertion</name>
          <expectedValue>["GetLocation","GetWeather"]</expectedValue>
        </expectation>
        <expectation>
          <name>output_validation</name>
          <expectedValue>Sunny with a high of 75F</expectedValue>
        </expectation>
      </testCase>
    </AiEvaluationDefinition>`;

    readFileStub.resolves(xml);

    const result = await generateTestSpecFromAiEvalDefinition('test.xml');

    expect(result).to.deep.equal({
      name: 'TestSpec',
      description: 'Test Description',
      subjectType: 'AGENT',
      subjectName: 'WeatherBot',
      subjectVersion: 1,
      testCases: [
        {
          utterance: "What's the weather like?",
          expectedTopic: 'Weather',
          expectedActions: ['GetLocation', 'GetWeather'],
          expectedOutcome: 'Sunny with a high of 75F',
        },
      ],
    });
  });

  it('should handle missing optional fields', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
      <name>TestSpec</name>
      <subjectType>AGENT</subjectType>
      <subjectName>WeatherBot</subjectName>
      <testCase>
        <inputs>
          <utterance>What's the weather like?</utterance>
        </inputs>
        <expectation>
          <name>topic_sequence_match</name>
          <expectedValue>Weather</expectedValue>
        </expectation>
      </testCase>
    </AiEvaluationDefinition>`;

    readFileStub.resolves(xml);

    const result = await generateTestSpecFromAiEvalDefinition('test.xml');

    expect(result).to.deep.equal({
      description: undefined,
      name: 'TestSpec',
      subjectType: 'AGENT',
      subjectName: 'WeatherBot',
      subjectVersion: undefined,
      testCases: [
        {
          utterance: "What's the weather like?",
          expectedTopic: 'Weather',
          expectedActions: [],
          expectedOutcome: undefined,
        },
      ],
    });
  });

  it('should handle multiple test cases', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
      <name>TestSpec</name>
      <subjectType>AGENT</subjectType>
      <subjectName>WeatherBot</subjectName>
      <testCase>
        <inputs>
          <utterance>What's the weather like?</utterance>
        </inputs>
        <expectation>
          <name>action_sequence_match</name>
          <expectedValue>["GetWeather"]</expectedValue>
        </expectation>
      </testCase>
      <testCase>
        <inputs>
          <utterance>Will it rain tomorrow?</utterance>
        </inputs>
        <expectation>
          <name>action_sequence_match</name>
          <expectedValue>["GetForecast"]</expectedValue>
        </expectation>
      </testCase>
    </AiEvaluationDefinition>`;

    readFileStub.resolves(xml);

    const result = await generateTestSpecFromAiEvalDefinition('test.xml');

    expect(result.testCases).to.have.length(2);
    expect(result.testCases[0].expectedActions).to.deep.equal(['GetWeather']);
    expect(result.testCases[1].expectedActions).to.deep.equal(['GetForecast']);
  });

  it('should handle malformed action sequence JSON', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
      <name>TestSpec</name>
      <subjectType>AGENT</subjectType>
      <subjectName>WeatherBot</subjectName>
      <testCase>
        <inputs>
          <utterance>Test</utterance>
        </inputs>
        <expectation>
          <name>action_sequence_match</name>
          <expectedValue>invalid json</expectedValue>
        </expectation>
      </testCase>
    </AiEvaluationDefinition>`;

    readFileStub.resolves(xml);

    const result = await generateTestSpecFromAiEvalDefinition('test.xml');

    expect(result.testCases[0].expectedActions).to.deep.equal([]);
  });
});

describe('normalizeResults', () => {
  it('should decode HTML entities in utterances and test results', () => {
    const results: AgentTestResultsResponse = {
      status: 'COMPLETED',
      startTime: '2024-01-01T00:00:00Z',
      subjectName: 'TestBot',
      testCases: [
        {
          status: 'COMPLETED',
          startTime: '2024-01-01T00:00:00Z',
          testNumber: 1,
          inputs: {
            utterance: 'What&apos;s the weather like in &quot;San Francisco&quot;?',
          },
          generatedData: {
            actionsSequence: [],
            outcome: '',
            topic: '',
          },
          testResults: [
            {
              name: 'test1',
              actualValue: 'The temperature is &gt; 75&deg;F',
              expectedValue: 'Expect &lt; 80&deg;F',
              score: 1,
              result: 'PASS',
              metricLabel: 'Accuracy',
              metricExplainability: '',
              status: 'COMPLETED',
              startTime: '2024-01-01T00:00:00Z',
            },
          ],
        },
      ],
    };

    const normalized = normalizeResults(results);

    expect(normalized.testCases[0].inputs.utterance).to.equal('What\'s the weather like in "San Francisco"?');
    expect(normalized.testCases[0].testResults[0].actualValue).to.equal('The temperature is > 75°F');
    expect(normalized.testCases[0].testResults[0].expectedValue).to.equal('Expect < 80°F');
  });

  it('should handle undefined or empty values', () => {
    const results: AgentTestResultsResponse = {
      status: 'COMPLETED',
      startTime: '2024-01-01T00:00:00Z',
      subjectName: 'TestBot',
      testCases: [
        {
          status: 'COMPLETED',
          startTime: '2024-01-01T00:00:00Z',
          testNumber: 1,
          // @ts-expect-error because we want to test undefined values
          inputs: {},
          generatedData: {
            actionsSequence: [],
            outcome: '',
            topic: '',
          },
          testResults: [
            {
              name: 'test1',
              actualValue: '',
              // @ts-expect-error because we want to test undefined values
              expectedValue: undefined,
              score: 1,
              result: 'PASS',
              metricLabel: 'Accuracy',
              metricExplainability: '',
              status: 'COMPLETED',
              startTime: '2024-01-01T00:00:00Z',
            },
          ],
        },
      ],
    };

    const normalized = normalizeResults(results);

    expect(normalized.testCases[0].inputs.utterance).to.equal('');
    expect(normalized.testCases[0].testResults[0].actualValue).to.equal('');
    expect(normalized.testCases[0].testResults[0].expectedValue).to.equal('');
  });

  it('should preserve non-encoded strings', () => {
    const results: AgentTestResultsResponse = {
      status: 'COMPLETED',
      startTime: '2024-01-01T00:00:00Z',
      subjectName: 'TestBot',
      testCases: [
        {
          status: 'COMPLETED',
          startTime: '2024-01-01T00:00:00Z',
          testNumber: 1,
          inputs: {
            utterance: 'Regular string with no HTML entities',
          },
          generatedData: {
            actionsSequence: [],
            outcome: '',
            topic: '',
          },
          testResults: [
            {
              name: 'test1',
              actualValue: 'Plain text response',
              expectedValue: 'Expected plain text',
              score: 1,
              result: 'PASS',
              metricLabel: 'Accuracy',
              metricExplainability: '',
              status: 'COMPLETED',
              startTime: '2024-01-01T00:00:00Z',
            },
          ],
        },
      ],
    };

    const normalized = normalizeResults(results);

    expect(normalized.testCases[0].inputs.utterance).to.equal('Regular string with no HTML entities');
    expect(normalized.testCases[0].testResults[0].actualValue).to.equal('Plain text response');
    expect(normalized.testCases[0].testResults[0].expectedValue).to.equal('Expected plain text');
  });
});
