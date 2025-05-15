/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { Connection, Lifecycle, PollingClient, StatusResult } from '@salesforce/core';
import { Duration, env } from '@salesforce/kit';
import { MaybeMock } from './maybe-mock';
import { decodeHtmlEntities } from './utils';
import { type AgentTestStartResponse, type AgentTestStatusResponse, type AgentTestResultsResponse } from './types.js';

/**
 * A service for testing agents using `AiEvaluationDefinition` metadata. Start asynchronous
 * test runs, get or poll for test status, and get detailed test results.
 *
 * **Examples**
 *
 * Create an instance of the service:
 *
 * `const agentTester = new AgentTester(connection);`
 *
 * Start a test run:
 *
 * `const startResponse = await agentTester.start(aiEvalDef);`
 *
 * Get the status for a test run:
 *
 * `const status = await agentTester.status(startResponse.runId);`
 *
 * Get detailed results for a test run:
 *
 * `const results = await agentTester.results(startResponse.runId);`
 */
export class AgentTester {
  private maybeMock: MaybeMock;

  public constructor(connection: Connection) {
    this.maybeMock = new MaybeMock(connection);
  }

  /**
   * Initiates a test run (i.e., AI evaluation).
   *
   * @param aiEvalDefName - The name of the AI evaluation definition to run.
   * @returns Promise that resolves with the response from starting the test.
   */
  public async start(aiEvalDefName: string): Promise<AgentTestStartResponse> {
    const url = '/einstein/ai-evaluations/runs';

    return this.maybeMock.request<AgentTestStartResponse>('POST', url, {
      aiEvaluationDefinitionName: aiEvalDefName,
    });
  }

  /**
   * Get the status of a test run.
   *
   * @param {string} jobId
   * @returns {Promise<AgentTestStatusResponse>}
   */
  public async status(jobId: string): Promise<AgentTestStatusResponse> {
    const url = `/einstein/ai-evaluations/runs/${jobId}`;

    return this.maybeMock.request<AgentTestStatusResponse>('GET', url);
  }

  /**
   * Poll the status of a test run until the tests are complete or the timeout is reached.
   *
   * @param {string} jobId
   * @param {Duration} timeout
   * @returns {Promise<AgentTestResultsResponse>}
   */
  public async poll(
    jobId: string,
    {
      timeout = Duration.minutes(5),
    }: {
      timeout?: Duration;
    } = {
      timeout: Duration.minutes(5),
    }
  ): Promise<AgentTestResultsResponse> {
    const frequency = env.getNumber('SF_AGENT_TEST_POLLING_FREQUENCY_MS', 1000);
    const lifecycle = Lifecycle.getInstance();
    const client = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        const statusResponse = await this.status(jobId);
        if (statusResponse.status.toLowerCase() !== 'new') {
          const resultsResponse = await this.results(jobId);
          const totalTestCases = resultsResponse.testCases.length;
          const passingTestCases = resultsResponse.testCases.filter(
            (tc) => tc.status.toLowerCase() === 'completed' && tc.testResults.every((r) => r.result === 'PASS')
          ).length;
          const failingTestCases = resultsResponse.testCases.filter(
            (tc) =>
              ['error', 'completed'].includes(tc.status.toLowerCase()) &&
              tc.testResults.some((r) => r.result === 'FAILURE')
          ).length;

          if (resultsResponse.status.toLowerCase() === 'completed') {
            await lifecycle.emit('AGENT_TEST_POLLING_EVENT', {
              jobId,
              status: resultsResponse.status,
              totalTestCases,
              failingTestCases,
              passingTestCases,
            });
            return { payload: resultsResponse, completed: true };
          }

          await lifecycle.emit('AGENT_TEST_POLLING_EVENT', {
            jobId,
            status: resultsResponse.status,
            totalTestCases,
            failingTestCases,
            passingTestCases,
          });
        }

        return { completed: false };
      },
      frequency: Duration.milliseconds(frequency),
      timeout,
    });

    return client.subscribe<AgentTestResultsResponse>();
  }

  /**
   * Get detailed test run results.
   *
   * @param {string} jobId
   * @returns {Promise<AgentTestResultsResponse>}
   */
  public async results(jobId: string): Promise<AgentTestResultsResponse> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/results`;

    const results = await this.maybeMock.request<AgentTestResultsResponse>('GET', url);
    return normalizeResults(results);
  }

  /**
   * Cancel an in-progress test run.
   *
   * @param {string} jobId
   * @returns {Promise<{success: boolean}>}
   */
  public async cancel(jobId: string): Promise<{ success: boolean }> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/cancel`;

    return this.maybeMock.request<{ success: boolean }>('POST', url);
  }
}

/**
 * Normalizes test results by decoding HTML entities in utterances and test result values.
 *
 * @param results - The agent test results response object to normalize
 * @returns A new AgentTestResultsResponse with decoded HTML entities
 *
 * @example
 * ```
 * const results = {
 *   testCases: [{
 *     inputs: { utterance: "&quot;hello&quot;" },
 *     testResults: [{
 *       actualValue: "&amp;test",
 *       expectedValue: "&lt;value&gt;"
 *     }]
 *   }]
 * };
 * const normalized = normalizeResults(results);
 * ```
 */
export function normalizeResults(results: AgentTestResultsResponse): AgentTestResultsResponse {
  return {
    ...results,
    testCases: results.testCases.map((tc) => ({
      ...tc,
      inputs: {
        utterance: decodeHtmlEntities(tc.inputs.utterance),
      },
      testResults: tc.testResults.map((r) => ({
        ...r,
        actualValue: decodeHtmlEntities(r.actualValue),
        expectedValue: decodeHtmlEntities(r.expectedValue),
        metricExplainability: decodeHtmlEntities(r.metricExplainability),
      })),
    })),
  };
}
