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
import { AgentTesterNGT, normalizeNGTResults } from '../src/agentTesterNGT';
import type { AgentTestNGTResultsResponse } from '../src/types';

describe('AgentTesterNGT', () => {
  describe('class structure', () => {
    it('should have expected methods', () => {
      // Just verify the class has the expected structure - connection will be mocked in integration tests
      expect(AgentTesterNGT).to.exist;
      expect(AgentTesterNGT.prototype).to.have.property('start');
      expect(AgentTesterNGT.prototype).to.have.property('status');
      expect(AgentTesterNGT.prototype).to.have.property('poll');
      expect(AgentTesterNGT.prototype).to.have.property('results');
    });
  });
});

describe('normalizeNGTResults', () => {
  it('should decode HTML entities in subject responses and scorer responses', () => {
    const results: AgentTestNGTResultsResponse = {
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

    const normalized = normalizeNGTResults(results);

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
    const results: AgentTestNGTResultsResponse = {
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

    const normalized = normalizeNGTResults(results);

    expect(normalized.testCases[0].subjectResponse).to.equal('');
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.equal('');
  });

  it('should preserve non-encoded strings', () => {
    const results: AgentTestNGTResultsResponse = {
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

    const normalized = normalizeNGTResults(results);

    expect(normalized.testCases[0].subjectResponse).to.equal('{"userInput":"Plain text with no HTML entities"}');
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.equal(
      '{"actualValue":"Plain response","expectedValue":"Expected response"}'
    );
  });

  it('should handle multiple test cases', () => {
    const results: AgentTestNGTResultsResponse = {
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

    const normalized = normalizeNGTResults(results);

    expect(normalized.testCases).to.have.length(2);
    expect(normalized.testCases[0].subjectResponse).to.equal('{"test":"one"}');
    expect(normalized.testCases[0].testScorerResults[0].scorerResponse).to.equal('{"result":"pass"}');
    expect(normalized.testCases[1].subjectResponse).to.equal('{"test":"two"}');
    expect(normalized.testCases[1].testScorerResults[0].scorerResponse).to.equal('{"result":"fail"}');
  });
});
