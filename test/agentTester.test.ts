/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { AgentTester, normalizeResults } from '../src/agentTester';
import type { AgentTestResultsResponse } from '../src/types';

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
            {
              endTime: '2025-05-15T20:06:04Z',
              metricExplainability: 'The answer does not provide any weather information, which is the main request. It only provides a general response without addressing the user&#39;s query.',
              metricLabel: 'Precision',
              name: 'completeness',
              result: 'FAILURE',
              score: 0.2,
              startTime: '2025-05-15T20:05:48Z',
              status: 'COMPLETED',
              actualValue: '',
              expectedValue: ''
            }
          ],
        },
      ],
    };

    const normalized = normalizeResults(results);

    expect(normalized.testCases[0].inputs.utterance).to.equal('What\'s the weather like in "San Francisco"?');
    expect(normalized.testCases[0].testResults[0].actualValue).to.equal('The temperature is > 75°F');
    expect(normalized.testCases[0].testResults[0].expectedValue).to.equal('Expect < 80°F');
    expect(normalized.testCases[0].testResults[1].metricExplainability).to.equal("The answer does not provide any weather information, which is the main request. It only provides a general response without addressing the user's query.");
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
    expect(normalized.testCases[0].testResults[0].metricExplainability).to.equal('');
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
              metricExplainability: 'Regular string with no HTML entities for metric explainability',
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
    expect(normalized.testCases[0].testResults[0].metricExplainability).to.equal('Regular string with no HTML entities for metric explainability');
  });
});
