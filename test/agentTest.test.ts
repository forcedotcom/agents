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
import { AgentTest } from '../src';
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
            customEvaluations: [
              {
                name: 'has_the_rhythm',
                label: 'has the real rhythm',
                parameters: [
                  { name: 'operator', value: 'equals', isReference: false },
                  { name: 'expected', value: 'Jerry', isReference: false },
                  {
                    name: 'actual',
                    isReference: true,
                    value:
                      "$.generatedData.invokedActions[*][?(@.function.name == 'SvcCopilotTmpl__SendEmailVerificationCode')].function.input.customerToVerify",
                  },
                ],
              },
            ],
            expectedActions: ['IdentifyRecordByName', 'QueryRecords'],
            expectedOutcome: 'contacts available name available with Acme are listed',
            expectedTopic: 'GeneralCRM',
            metrics: ['coherence', 'output_latency_milliseconds'],
            contextVariables: [
              {
                name: 'myVariable',
                value: 'myValue',
              },
              {
                name: 'myVariable2',
                value: 'myValue2',
              },
            ],
          },
          {
            utterance: 'List contact emails associated with Acme account',
            expectedActions: ['IdentifyRecordByName', 'QueryRecords'],
            expectedOutcome: 'contacts available emails available with Acme are listed',
            expectedTopic: 'GeneralCRM',
            metrics: ['coherence', 'factuality', 'instruction_following'],
          },
        ],
      };
      sinon.stub(agentTest, 'getTestSpec').resolves(testSpecContent);

      await agentTest.writeTestSpec('test-spec.yaml');

      expect(writeFileStub.firstCall.args[0]).to.equal('test-spec.yaml');
      expect(writeFileStub.firstCall.args[1]).to.equal(
        `name: Test
description: Test
subjectType: AGENT
subjectName: MyAgent
testCases:
  - utterance: List contact names associated with Acme account
    customEvaluations:
      - name: has_the_rhythm
        label: has the real rhythm
        parameters:
          - name: operator
            value: equals
            isReference: false
          - name: expected
            value: Jerry
            isReference: false
          - name: actual
            isReference: true
            value: $.generatedData.invokedActions[*][?(@.function.name == 'SvcCopilotTmpl__SendEmailVerificationCode')].function.input.customerToVerify
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available name available with Acme are listed
    expectedTopic: GeneralCRM
    metrics:
      - coherence
      - output_latency_milliseconds
    contextVariables:
      - name: myVariable
        value: myValue
      - name: myVariable2
        value: myValue2
  - utterance: List contact emails associated with Acme account
    expectedActions:
      - IdentifyRecordByName
      - QueryRecords
    expectedOutcome: contacts available emails available with Acme are listed
    expectedTopic: GeneralCRM
    metrics:
      - coherence
      - factuality
      - instruction_following
`
      );
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
            contextVariables: [],
            metrics: [],
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
    contextVariables: []
    metrics: []
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
            metrics: undefined,
            contextVariables: undefined,
            customEvaluations: undefined,
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
    metrics:
      - completeness
      - coherence
      - conciseness
      - output_latency_milliseconds
      - instruction_following
      - factuality
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
            <contextVariable>
                <name>myVariable</name>
                <value>myValue</value>
            </contextVariable>
          </inputs>
          <expectation>
            <name>string_comparisson</name>
            <label>my Custom Comparison</label>
            <parameter>
                <name>operator</name>
                <value>equals</value>
                <isReference>false</isReference>
            </parameter>
            <parameter>
                <name>actual</name>
                <value>$.generatedData.invokedActions[*][?(@.function.name == 'SvcCopilotTmpl__SendEmailVerificationCode')].function.input.customerToVerify</value>
                <isReference>true</isReference>
            </parameter>
            <parameter>
                <name>expected</name>
                <value>Jerry</value>
                <isReference>false</isReference>
            </parameter>
        </expectation>
          <expectation>
            <name>topic_sequence_match</name>
            <expectedValue>Weather</expectedValue>
          </expectation>
          <expectation>
            <name>action_sequence_match</name>
            <expectedValue>["GetLocation","GetWeather"]</expectedValue>
          </expectation>
          <expectation>
            <name>completeness</name>
          </expectation>
          <expectation>
            <name>coherence</name>
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
            contextVariable: {
              name: 'myVariable',
              value: 'myValue',
            },
            utterance: "What's the weather like?",
            expectedTopic: 'Weather',
            customEvaluations: [
              {
                label: 'my Custom Comparison',
                name: 'string_comparisson',
                parameters: [
                  {
                    isReference: false,
                    name: 'operator',
                    value: 'equals',
                  },
                  {
                    isReference: true,
                    name: 'actual',
                    value:
                      "$.generatedData.invokedActions[*][?(@.function.name == 'SvcCopilotTmpl__SendEmailVerificationCode')].function.input.customerToVerify",
                  },
                  {
                    isReference: false,
                    name: 'expected',
                    value: 'Jerry',
                  },
                ],
              },
            ],
            expectedActions: ['GetLocation', 'GetWeather'],
            expectedOutcome: 'Sunny with a high of 75F',
            metrics: ['completeness', 'coherence'],
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
             <contextVariable>
                <name>myVariable</name>
                <value>myValue</value>
            </contextVariable>
            <contextVariable>
                <name>myVariable2</name>
                <value>myValue2</value>
            </contextVariable>
          </inputs>
          <expectation>
            <name>topic_assertion</name>
            <expectedValue>Weather</expectedValue>
          </expectation>
          <expectation>
            <name>string_comparisson</name>
            <label>my Custom Comparison</label>
            <parameter>
                <name>operator</name>
                <value>equals</value>
                <isReference>false</isReference>
            </parameter>
            <parameter>
                <name>actual</name>
                <value>$.generatedData.invokedActions[*][?(@.function.name == 'SvcCopilotTmpl__SendEmailVerificationCode')].function.input.customerToVerify</value>
                <isReference>true</isReference>
            </parameter>
            <parameter>
                <name>expected</name>
                <value>Jerry</value>
                <isReference>false</isReference>
            </parameter>
          </expectation>
          <expectation>
            <name>actions_assertion</name>
            <expectedValue>["GetLocation","GetWeather"]</expectedValue>
          </expectation>
          <expectation>
            <name>completeness</name>
          </expectation>
        <expectation>
            <name>conciseness</name>
        </expectation>
        <expectation>
            <name>output_latency_milliseconds</name>
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
            contextVariable: [
              {
                name: 'myVariable',
                value: 'myValue',
              },
              {
                name: 'myVariable2',
                value: 'myValue2',
              },
            ],
            expectedTopic: 'Weather',
            expectedActions: ['GetLocation', 'GetWeather'],
            customEvaluations: [
              {
                label: 'my Custom Comparison',
                name: 'string_comparisson',
                parameters: [
                  {
                    isReference: false,
                    name: 'operator',
                    value: 'equals',
                  },
                  {
                    isReference: true,
                    name: 'actual',
                    value:
                      "$.generatedData.invokedActions[*][?(@.function.name == 'SvcCopilotTmpl__SendEmailVerificationCode')].function.input.customerToVerify",
                  },
                  {
                    isReference: false,
                    name: 'expected',
                    value: 'Jerry',
                  },
                ],
              },
            ],
            expectedOutcome: 'Sunny with a high of 75F',
            metrics: ['completeness', 'conciseness', 'output_latency_milliseconds'],
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
            contextVariable: undefined,
            customEvaluations: [],
            expectedTopic: 'Weather',
            expectedActions: [],
            metrics: [],
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
            <contextVariable>
              <name>myVariable</name>
              <value>myValue</value>
            </contextVariable>
          </inputs>
          <expectation>
            <name>action_sequence_match</name>
            <expectedValue>["GetWeather"]</expectedValue>
          </expectation>
        </testCase>
        <testCase>
          <inputs>
             <contextVariable>
                <name>myVariable</name>
                <value>myValue</value>
            </contextVariable>
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
    metrics:
      - completeness
      - coherence
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
        <expectation>
            <name>completeness</name>
        </expectation>
        <expectation>
            <name>coherence</name>
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
