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
  type AgentforceStudioTestStartResponse,
  type AgentforceStudioTestStatus,
  type AgentforceStudioTestStatusResponse,
  type AgentforceStudioTestResultsResponse,
} from './types.js';

/**
 * A service for testing agents using `AiTestingDefinition` metadata (Agentforce Studio).
 * Start asynchronous test runs, get or poll for test status, and get detailed test results.
 *
 * **Examples**
 *
 * Create an instance of the service:
 *
 * `const agentTester = new AgentforceStudioTester(connection);`
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
export class AgentforceStudioTester {
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
  public async start(testDefinitionName: string): Promise<AgentforceStudioTestStartResponse> {
    const url = '/einstein/ai-testing/runs';

    const result = await this.maybeMock.request<AgentforceStudioTestStartResponse>('POST', url, {
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
   * @returns {Promise<AgentforceStudioTestStatusResponse>}
   */
  public async status(runId: string): Promise<AgentforceStudioTestStatusResponse> {
    const url = `/einstein/ai-testing/runs/${runId}`;

    return this.maybeMock.request<AgentforceStudioTestStatusResponse>('GET', url);
  }

  /**
   * Poll the status of a test run until the tests are complete or the timeout is reached.
   *
   * @param {string} runId
   * @param {Duration} timeout
   * @returns {Promise<AgentforceStudioTestResultsResponse>}
   */
  public async poll(
    runId: string,
    { timeout = Duration.minutes(5) }: { timeout?: Duration } = {}
  ): Promise<AgentforceStudioTestResultsResponse> {
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

          const terminalStatuses: AgentforceStudioTestStatus[] = ['SUCCESS', 'FAILED', 'TERMINATED'];
          if (terminalStatuses.includes(resultsResponse.status as AgentforceStudioTestStatus)) {
            return { payload: resultsResponse, completed: true };
          }
        }

        return { completed: false };
      },
      frequency: Duration.milliseconds(frequency),
      timeout,
    });

    return client.subscribe<AgentforceStudioTestResultsResponse>();
  }

  /**
   * Get detailed test run results.
   *
   * @param {string} runId
   * @returns {Promise<AgentforceStudioTestResultsResponse>}
   */
  public async results(runId: string): Promise<AgentforceStudioTestResultsResponse> {
    const url = `/einstein/ai-testing/runs/${runId}/results`;

    const results = await this.maybeMock.request<AgentforceStudioTestResultsResponse>('GET', url);
    return normalizeAgentforceStudioResults(results);
  }
}

/** Decodes HTML entities in test result subject responses and scorer responses. */
export function normalizeAgentforceStudioResults(
  results: AgentforceStudioTestResultsResponse
): AgentforceStudioTestResultsResponse {
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
