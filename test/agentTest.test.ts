/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import fs from 'node:fs/promises';
import sinon from 'sinon';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { AgentTest } from '../src/agentTest';
import type { TestSpec } from '../src/types';

describe('AgentTest', () => {
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
      const agentTest = new AgentTest({ specPath: 'path/to/spec' });
      const testSpecContent: TestSpec = {
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
      };
      sinon.stub(agentTest, 'getTestSpec').resolves(testSpecContent);

      await agentTest.writeTestSpec('test-spec.yaml');

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
      const agentTest = new AgentTest({ specPath: 'path/to/spec' });
      const testSpecContent: TestSpec = {
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
      };
      sinon.stub(agentTest, 'getTestSpec').resolves(testSpecContent);

      await agentTest.writeTestSpec('test-spec.yaml');
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
      const agentTest = new AgentTest({ specPath: 'path/to/spec' });
      const testSpecContent: TestSpec = {
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
      };
      sinon.stub(agentTest, 'getTestSpec').resolves(testSpecContent);

      await agentTest.writeTestSpec('test-spec.yaml');

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

  describe('getTestSpec', () => {
    let readFileStub: sinon.SinonStub;

    beforeEach(() => {
      readFileStub = sinon.stub(fs, 'readFile');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should parse AiEvaluationDefinition XML into TestSpec', async () => {
      const agentTest = new AgentTest({ mdPath: 'path/to/metadataFile' });

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

      const result = await agentTest.getTestSpec();

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
      const agentTest = new AgentTest({ mdPath: 'path/to/metadataFile' });

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

      const result = await agentTest.getTestSpec();

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
      const agentTest = new AgentTest({ mdPath: 'path/to/metadataFile' });

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

      const result = await agentTest.getTestSpec();

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
      const agentTest = new AgentTest({ mdPath: 'path/to/metadataFile' });

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

      const result = await agentTest.getTestSpec();

      expect(result.testCases).to.have.length(2);
      expect(result.testCases[0].expectedActions).to.deep.equal(['GetWeather']);
      expect(result.testCases[1].expectedActions).to.deep.equal(['GetForecast']);
    });

    it('should handle malformed action sequence JSON', async () => {
      const agentTest = new AgentTest({ mdPath: 'path/to/metadataFile' });

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

      const result = await agentTest.getTestSpec();

      expect(result.testCases[0].expectedActions).to.deep.equal([]);
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
      sinon.stub(fs, 'readFile').resolves(yml);
      sinon.stub(AgentTest, 'list').resolves([]);
      const { contents } = await AgentTest.create(connection, 'MyTest', 'test.yaml', {
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
