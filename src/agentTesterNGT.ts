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

import { Connection, Lifecycle, PollingClient, SfError, StatusResult } from '@salesforce/core';
import { Duration, env } from '@salesforce/kit';
import { MaybeMock } from './maybe-mock';
import { decodeHtmlEntities } from './utils';
import {
  type AgentTestNGTStartResponse,
  type AgentTestNGTStatusResponse,
  type AgentTestNGTResultsResponse,
} from './types.js';

/**
 * A service for testing agents using `AiTestingDefinition` metadata (NGT - Next Generation Testing).
 * Start asynchronous test runs, get or poll for test status, and get detailed test results.
 *
 * **Examples**
 *
 * Create an instance of the service:
 *
 * `const agentTester = new AgentTesterNGT(connection);`
 *
 * Start a test run:
 *
 * `const startResponse = await agentTester.start(aiTestSuiteDefName);`
 *
 * Get the status for a test run:
 *
 * `const status = await agentTester.status(startResponse.runId);`
 *
 * Get detailed results for a test run:
 *
 * `const results = await agentTester.results(startResponse.runId);`
 */
export class AgentTesterNGT {
  private maybeMock: MaybeMock;

  public constructor(connection: Connection) {
    this.maybeMock = new MaybeMock(connection);
  }

  /**
   * Initiates a test run (i.e., AI test suite evaluation).
   *
   * @param testDefinitionName - The name of the AI test suite definition to run.
   * @returns Promise that resolves with the response from starting the test.
   */
  public async start(testDefinitionName: string): Promise<AgentTestNGTStartResponse> {
    const url = '/einstein/ai-testing/runs';

    const result = await this.maybeMock.request<AgentTestNGTStartResponse>('POST', url, {
      testDefinitionName,
    });

    if (result?.runId === undefined) {
      throw SfError.create({ name: 'TestInProgress', message: 'a test run is already in progress' });
    }
    return result;
  }

  /**
   * Get the status of a test run.
   *
   * @param {string} runId
   * @returns {Promise<AgentTestNGTStatusResponse>}
   */
  public async status(runId: string): Promise<AgentTestNGTStatusResponse> {
    const url = `/einstein/ai-testing/runs/${runId}`;

    return this.maybeMock.request<AgentTestNGTStatusResponse>('GET', url);
  }

  /**
   * Poll the status of a test run until the tests are complete or the timeout is reached.
   *
   * @param {string} runId
   * @param {Duration} timeout
   * @returns {Promise<AgentTestNGTResultsResponse>}
   */
  public async poll(
    runId: string,
    { timeout = Duration.minutes(5) }: { timeout?: Duration } = {}
  ): Promise<AgentTestNGTResultsResponse> {
    const frequency = env.getNumber('SF_AGENT_TEST_POLLING_FREQUENCY_MS', 1000);
    const lifecycle = Lifecycle.getInstance();
    const client = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        const statusResponse = await this.status(runId);
        if (statusResponse.status.toLowerCase() !== 'new') {
          const resultsResponse = await this.results(runId);
          const totalTestCases = resultsResponse.testCases.length;
          const isPassingScorer = (scorerResponse: string): boolean => {
            try {
              const { actualValue, expectedValue } = JSON.parse(scorerResponse) as {
                actualValue?: string;
                expectedValue?: string;
              };
              return actualValue !== undefined && actualValue === expectedValue;
            } catch {
              return false;
            }
          };
          const passingTestCases = resultsResponse.testCases.filter(
            (tc) =>
              tc.testScorerResults.length > 0 && tc.testScorerResults.every((s) => isPassingScorer(s.scorerResponse))
          ).length;
          const failingTestCases = totalTestCases - passingTestCases;

          await lifecycle.emit('AGENT_TEST_POLLING_EVENT', {
            // to match the other AGENT_TEST_POLLING_EVENT for consumers
            jobId: runId,
            status: resultsResponse.status,
            totalTestCases,
            failingTestCases,
            passingTestCases,
          });

          if (resultsResponse.status.toLowerCase() === 'success') {
            return { payload: resultsResponse, completed: true };
          }
        }

        return { completed: false };
      },
      frequency: Duration.milliseconds(frequency),
      timeout,
    });

    return client.subscribe<AgentTestNGTResultsResponse>();
  }

  /**
   * Get detailed test run results.
   *
   * @param {string} runId
   * @returns {Promise<AgentTestNGTResultsResponse>}
   */
  public async results(runId: string): Promise<AgentTestNGTResultsResponse> {
    const url = `/einstein/ai-testing/runs/${runId}/results`;

    const results = await this.maybeMock.request<AgentTestNGTResultsResponse>('GET', url);
    return normalizeNGTResults(results);
  }
}

/** Decodes HTML entities in test result subject responses and scorer responses. */
export function normalizeNGTResults(results: AgentTestNGTResultsResponse): AgentTestNGTResultsResponse {
  return {
    ...results,
    testCases: results.testCases.map((tc) => ({
      ...tc,
      subjectResponse: decodeHtmlEntities(tc.subjectResponse),
      testScorerResults: tc.testScorerResults.map((scorer) => ({
        ...scorer,
        scorerResponse: decodeHtmlEntities(scorer.scorerResponse),
      })),
    })),
  };
}
