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
import { Connection, SfError } from '@salesforce/core';
import {
  ConversationTester,
  normalizeConversationTestResults,
  parseConversationScorerResponse,
} from '../src/conversationTester';
import type { CreateAndRunConversationTestSuiteInput, EphemeralConversationTestInput } from '../src/types';

const MOCKS = 'test/mocks/conversationTester';

const ephemeralInput: EphemeralConversationTestInput = {
  agentId: '0XxRZ0000000001',
  agentVersionId: '0X9RZ0000000001',
  maxTurns: 5,
  testCases: [{ number: 1, conversationGoal: 'Check the status of my order' }],
};

const createAndRunInput: CreateAndRunConversationTestSuiteInput = {
  ...ephemeralInput,
  name: 'Order status',
  testCases: [{ number: 1, maxTurns: 5, conversationGoal: 'Check the status of my order' }],
};

describe('ConversationTester', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://mydomain.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(() => {
    delete process.env.SF_MOCK_DIR;
  });

  const useMocks = (scenario: string): void => {
    process.env.SF_MOCK_DIR = `${MOCKS}/${scenario}`;
  };

  const expectError = async (promise: Promise<unknown>): Promise<SfError> => {
    try {
      await promise;
    } catch (e) {
      return e as SfError;
    }
    expect.fail('expected the call to throw');
  };

  describe('runEphemeral', () => {
    it('returns completed results with the JSON-string fields decoded', async () => {
      useMocks('completed');
      const results = await new ConversationTester(connection).runEphemeral(ephemeralInput);

      expect(results.status).to.equal('Completed');
      expect(results.summary).to.deep.equal({ totalNumberOfTestCases: 2, taskResolutionPassPercent: 50 });
      expect(results.testCases.map((tc) => tc.testNumber)).to.deep.equal([1, 2]);
      expect(JSON.parse(results.testCases[0].subjectResponse!)).to.deep.equal({
        status: 'COMPLETED',
        completionReason: 'GOAL_ACHIEVED',
      });
      expect(JSON.parse(results.testCases[0].testScorerResults![0].scorerResponse!)).to.include({ status: 'PASS' });
    });

    it('returns a Failed run that has test cases, so each case can be reported', async () => {
      useMocks('agentFailed');
      const results = await new ConversationTester(connection).runEphemeral(ephemeralInput);

      expect(results.status).to.equal('Failed');
      expect(results.testCases).to.have.length(1);
      expect(parseConversationScorerResponse(results.testCases[0].testScorerResults![0].scorerResponse)).to.deep.equal({
        status: 'ERROR',
        reasoning: 'The agent under test failed during the simulated conversation.',
      });
    });

    it('throws with the server message when HTTP 200 says the input was rejected', async () => {
      useMocks('rejected');
      const error = await expectError(new ConversationTester(connection).runEphemeral(ephemeralInput));

      expect(error.name).to.equal('ConversationTestRejectedError');
      expect(error.message).to.equal(
        "The conversation-level test run was rejected: 'maxTurns' must be in the range [1, 30]"
      );
      expect(error.actions).to.deep.equal(['Fix the input the message names, then run again.']);
    });

    it('throws a generic reason when a rejected run has no error message or test cases', async () => {
      useMocks('rejectedNoMessage');
      const error = await expectError(new ConversationTester(connection).runEphemeral(ephemeralInput));

      expect(error.name).to.equal('ConversationTestRejectedError');
      expect(error.message).to.equal(
        "The conversation-level test run was rejected: The server didn't return a reason."
      );
    });
  });

  describe('createAndRun', () => {
    it('returns the saved suite and run IDs', async () => {
      useMocks('created');
      const response = await new ConversationTester(connection).createAndRun(createAndRunInput);

      expect(response).to.deep.equal({
        runId: '3A2RZ000000d7zJ0AQ',
        status: 'SUCCESS',
        statusMessage: 'Test suite created and run started.',
        testSuiteId: '1W4RZ000000FfXV0A0',
      });
    });

    it('throws with the status message when no IDs come back', async () => {
      useMocks('notStarted');
      const error = await expectError(new ConversationTester(connection).createAndRun(createAndRunInput));

      expect(error.name).to.equal('ConversationSuiteNotStartedError');
      expect(error.message).to.equal(
        "The conversation-level test suite wasn't saved and run: A test run is already in progress for this suite."
      );
    });

    it('throws a generic reason when no IDs or status message come back', async () => {
      useMocks('notStartedNoMessage');
      const error = await expectError(new ConversationTester(connection).createAndRun(createAndRunInput));

      expect(error.message).to.equal(
        "The conversation-level test suite wasn't saved and run: The server didn't return a reason."
      );
    });
  });
});

describe('normalizeConversationTestResults', () => {
  it('decodes entities and leaves missing fields missing', () => {
    const normalized = normalizeConversationTestResults({
      status: 'Completed',
      testCases: [
        { testNumber: 1, subjectResponse: '{&quot;a&quot;:1}', testScorerResults: [{ scorerName: 'task_resolution' }] },
        { testNumber: 2 },
      ],
    });

    expect(normalized.testCases[0].subjectResponse).to.equal('{"a":1}');
    expect(normalized.testCases[0].testScorerResults).to.deep.equal([
      { scorerName: 'task_resolution', scorerResponse: undefined },
    ]);
    expect(normalized.testCases[1]).to.deep.equal({
      testNumber: 2,
      subjectResponse: undefined,
      testScorerResults: undefined,
    });
  });
});

describe('parseConversationScorerResponse', () => {
  it('reads top-level fields', () => {
    expect(parseConversationScorerResponse('{"status":"PASS","score":5,"reasoning":"ok"}')).to.deep.equal({
      status: 'PASS',
      score: 5,
      reasoning: 'ok',
    });
  });

  it('prefers fields under content, and falls back to explanation', () => {
    expect(
      parseConversationScorerResponse('{"status":"IGNORED","content":{"status":"FAIL","score":1.5,"explanation":"no"}}')
    ).to.deep.equal({ status: 'FAIL', score: 1.5, reasoning: 'no' });
  });

  it('decodes HTML entities before parsing', () => {
    expect(
      parseConversationScorerResponse('{&quot;status&quot;:&quot;PASS&quot;,&quot;score&quot;:&quot;4&quot;}')
    ).to.deep.equal({
      status: 'PASS',
      score: '4',
    });
  });

  it('drops fields of an unexpected type', () => {
    expect(parseConversationScorerResponse('{"status":1,"score":true,"reasoning":{}}')).to.deep.equal({});
  });

  it('returns undefined for missing, invalid or non-object responses', () => {
    expect(parseConversationScorerResponse(undefined)).to.equal(undefined);
    expect(parseConversationScorerResponse('')).to.equal(undefined);
    expect(parseConversationScorerResponse('not json')).to.equal(undefined);
    expect(parseConversationScorerResponse('[1,2]')).to.equal(undefined);
    expect(parseConversationScorerResponse('null')).to.equal(undefined);
  });
});
