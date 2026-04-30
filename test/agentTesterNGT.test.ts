/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { AgentforceStudioTester, normalizeAgentforceStudioResults } from '../src/agentforceStudioTester';
import type { AgentforceStudioTestResultsResponse } from '../src/types';

describe('AgentforceStudioTester', () => {
  const $$ = new TestContext();
  let connection: Connection;

  beforeEach(async () => {
    $$.inProject(true);
    const testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = 'test/mocks';
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://mydomain.salesforce.com';
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(() => {
    delete process.env.SF_MOCK_DIR;
  });

  describe('start', () => {
    it('should start a test run and return a runId', async () => {
      const tester = new AgentforceStudioTester(connection);
      const output = await tester.start('MySuite');
      expect(output).to.be.ok;
      expect(output.runId).to.equal('3A2SM000000003F4AQ');
    });
  });

  describe('status', () => {
    it('should return status of a test run', async () => {
      const tester = new AgentforceStudioTester(connection);
      await tester.start('MySuite');
      const output = await tester.status('3A2SM000000003F4AQ');
      expect(output).to.be.ok;
      expect(output.status).to.equal('NEW');
      expect(output.startTime).to.equal('2025-01-07T12:00:00.000Z');
    });
  });

  describe('results', () => {
    it('should return results of a completed test run', async () => {
      const tester = new AgentforceStudioTester(connection);
      await tester.start('MySuite');
      const output = await tester.results('3A2SM000000003F4AQ');
      expect(output).to.be.ok;
      expect(output.status).to.equal('SUCCESS');
      expect(output.testCases).to.have.length(2);
      expect(output.testCases[0].testNumber).to.equal(1);
    });
  });
});

describe('normalizeAgentforceStudioResults', () => {
  it('should decode HTML entities in subject responses and scorer responses', () => {
    const results: AgentforceStudioTestResultsResponse = {
      status: 'SUCCESS',
      testCases: [
        {
          subjectResponse:
            '{&quot;schema&quot;:{&quot;type&quot;:&quot;object&quot;},&quot;content&quot;:{&quot;userInput&quot;:&quot;What&apos;s the weather?&quot;}}',
          testNumber: 1,
          testScorerResults: [
            {
              scorerName: 'Response Evaluation',
              scorerResponse:
                '{&quot;actualValue&quot;:&quot;The temperature is &gt; 75&deg;F&quot;,&quot;expectedValue&quot;:&quot;Expect &lt; 80&deg;F&quot;}',
            },
            {
              scorerName: 'Action Evaluation',
              scorerResponse:
                '{&quot;actualValue&quot;:&quot;[GetWeather]&quot;,&quot;expectedValue&quot;:&quot;[GetWeather]&quot;}',
            },
          ],
        },
      ],
    };

    const normalized = normalizeAgentforceStudioResults(results);

    expect(normalized.testCases[0].subjectResponse).to.include('"schema":{"type":"object"}');
    expect(normalized.testCases[0].subjectResponse).to.include('"userInput":"What\'s the weather?"');
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.include(
      '"actualValue":"The temperature is > 75°F"'
    );
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.include('"expectedValue":"Expect < 80°F"');
    expect(normalized.testCases[0].testScorerResults[1].scorerResponse).to.equal(
      '{"actualValue":"[GetWeather]","expectedValue":"[GetWeather]"}'
    );
  });

  it('should handle empty or undefined values', () => {
    const results: AgentforceStudioTestResultsResponse = {
      status: 'SUCCESS',
      testCases: [
        {
          subjectResponse: '',
          testNumber: 1,
          testScorerResults: [
            {
              scorerName: 'Test Scorer',
              scorerResponse: '',
            },
          ],
        },
      ],
    };

    const normalized = normalizeAgentforceStudioResults(results);

    expect(normalized.testCases[0].subjectResponse).to.equal('');
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.equal('');
  });

  it('should preserve non-encoded strings', () => {
    const results: AgentforceStudioTestResultsResponse = {
      status: 'SUCCESS',
      testCases: [
        {
          subjectResponse: '{"userInput":"Plain text with no HTML entities"}',
          testNumber: 1,
          testScorerResults: [
            {
              scorerName: 'Response Evaluation',
              scorerResponse: '{"actualValue":"Plain response","expectedValue":"Expected response"}',
            },
          ],
        },
      ],
    };

    const normalized = normalizeAgentforceStudioResults(results);

    expect(normalized.testCases[0].subjectResponse).to.equal('{"userInput":"Plain text with no HTML entities"}');
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.equal(
      '{"actualValue":"Plain response","expectedValue":"Expected response"}'
    );
  });

  it('should handle multiple test cases', () => {
    const results: AgentforceStudioTestResultsResponse = {
      status: 'SUCCESS',
      testCases: [
        {
          subjectResponse: '{&quot;test&quot;:&quot;one&quot;}',
          testNumber: 1,
          testScorerResults: [
            {
              scorerName: 'Scorer 1',
              scorerResponse: '{&quot;result&quot;:&quot;pass&quot;}',
            },
          ],
        },
        {
          subjectResponse: '{&quot;test&quot;:&quot;two&quot;}',
          testNumber: 2,
          testScorerResults: [
            {
              scorerName: 'Scorer 2',
              scorerResponse: '{&quot;result&quot;:&quot;fail&quot;}',
            },
          ],
        },
      ],
    };

    const normalized = normalizeAgentforceStudioResults(results);

    expect(normalized.testCases).to.have.length(2);
    expect(normalized.testCases[0].subjectResponse).to.equal('{"test":"one"}');
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.equal('{"result":"pass"}');
    expect(normalized.testCases[1].subjectResponse).to.equal('{"test":"two"}');
    expect(normalized.testCases[1].testScorerResults[0].scorerResponse).to.equal('{"result":"fail"}');
  });
});
