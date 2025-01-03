/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Connection, Lifecycle, PollingClient, StatusResult } from '@salesforce/core';
import { Duration, env } from '@salesforce/kit';
import ansis from 'ansis';
import { MaybeMock } from './maybe-mock';

export type TestStatus = 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';

export type AgentTestStartResponse = {
  aiEvaluationId: string;
  status: TestStatus;
};

export type AgentTestStatusResponse = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
};

export type TestCaseResult = {
  status: TestStatus;
  number: string;
  utterance: string;
  startTime: string;
  endTime?: string;
  generatedData: {
    type: 'AGENT';
    actionsSequence: string[];
    outcome: 'Success' | 'Failure';
    topic: string;
    inputTokensCount: string;
    outputTokensCount: string;
  };
  expectationResults: Array<{
    name: string;
    actualValue: string;
    expectedValue: string;
    score: number;
    result: 'Passed' | 'Failed';
    metricLabel: 'Accuracy' | 'Precision';
    metricExplainability: string;
    status: TestStatus;
    startTime: string;
    endTime?: string;
    errorCode?: string;
    errorMessage?: string;
  }>;
};

export type AgentTestDetailsResponse = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
  subjectName: string;
  testSet: {
    name: string;
    testCases: TestCaseResult[];
  };
};

/**
 * AgentTester class to test Agents
 */
export class AgentTester {
  private maybeMock: MaybeMock;
  public constructor(connection: Connection) {
    this.maybeMock = new MaybeMock(connection);
  }

  /**
   * Starts an AI evaluation run based on the provided name or ID.
   *
   * @param nameOrId - The name or ID of the AI evaluation definition.
   * @param type - Specifies whether the provided identifier is a 'name' or 'id'. Defaults to 'name'. If 'name' is provided, nameOrId is treated as the name of the AiEvaluationDefinition. If 'id' is provided, nameOrId is treated as the unique ID of the AiEvaluationDefinition.
   * @returns A promise that resolves to an object containing the ID of the started AI evaluation run.
   */
  public async start(nameOrId: string, type: 'name' | 'id' = 'name'): Promise<AgentTestStartResponse> {
    const url = '/einstein/ai-evaluations/runs';

    return this.maybeMock.request<AgentTestStartResponse>('POST', url, {
      [type === 'name' ? 'aiEvaluationDefinitionName' : 'aiEvaluationDefinitionVersionId']: nameOrId,
    });
  }

  /**
   * Get the status of a test run
   *
   * @param {string} jobId
   * @returns {Promise<AgentTestStatusResponse>}
   */
  public async status(jobId: string): Promise<AgentTestStatusResponse> {
    const url = `/einstein/ai-evaluations/runs/${jobId}`;

    return this.maybeMock.request<AgentTestStatusResponse>('GET', url);
  }

  /**
   * Poll for a test run to complete
   *
   * @param {string} jobId
   * @param {Duration} timeout
   * @returns {Promise<AgentTestDetailsResponse>}
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
  ): Promise<AgentTestDetailsResponse> {
    const frequency = env.getNumber('SF_AGENT_TEST_POLLING_FREQUENCY_MS', 1000);
    const lifecycle = Lifecycle.getInstance();
    const client = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        // NOTE: we don't actually need to call the status API here since all the same information is present on the
        // details API. We could just call the details API and check the status there.
        const [detailsResponse, statusResponse] = await Promise.all([this.details(jobId), this.status(jobId)]);
        const totalTestCases = detailsResponse.testSet.testCases.length;
        const failingTestCases = detailsResponse.testSet.testCases.filter((tc) => tc.status === 'ERROR').length;
        const passingTestCases = detailsResponse.testSet.testCases.filter(
          (tc) => tc.status === 'COMPLETED' && tc.expectationResults.every((r) => r.result === 'Passed')
        ).length;

        if (statusResponse.status.toLowerCase() === 'completed') {
          await lifecycle.emit('AGENT_TEST_POLLING_EVENT', {
            jobId,
            status: statusResponse.status,
            totalTestCases,
            failingTestCases,
            passingTestCases,
          });
          return { payload: detailsResponse, completed: true };
        }

        await lifecycle.emit('AGENT_TEST_POLLING_EVENT', {
          jobId,
          status: statusResponse.status,
          totalTestCases,
          failingTestCases,
          passingTestCases,
        });
        return { completed: false };
      },
      frequency: Duration.milliseconds(frequency),
      timeout,
    });

    return client.subscribe<AgentTestDetailsResponse>();
  }

  /**
   * Request test run details
   *
   * @param {string} jobId
   * @returns {Promise<AgentTestDetailsResponse>}
   */
  public async details(jobId: string): Promise<AgentTestDetailsResponse> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/details`;

    return this.maybeMock.request<AgentTestDetailsResponse>('GET', url);
  }

  /**
   * Cancel an in-progress test run
   *
   * @param {string} jobId
   * @returns {Promise<{success: boolean}>}
   */
  public async cancel(jobId: string): Promise<{ success: boolean }> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/cancel`;

    return this.maybeMock.request<{ success: boolean }>('POST', url);
  }
}

function humanFriendlyName(name: string): string {
  switch (name) {
    case 'topic_sequence_match':
      return 'Topic';
    case 'action_sequence_match':
      return 'Action';
    case 'bot_response_rating':
      return 'Outcome';
    default:
      return name;
  }
}

function truncate(value: number, decimals = 2): string {
  const remainder = value % 1;
  // truncate remainder to specified decimals
  const fractionalPart = remainder ? remainder.toString().split('.')[1].slice(0, decimals) : '0'.repeat(decimals);
  const wholeNumberPart = Math.floor(value).toString();
  return decimals ? `${wholeNumberPart}.${fractionalPart}` : wholeNumberPart;
}

function readableTime(time: number, decimalPlaces = 2): string {
  if (time < 1000) {
    return '< 1s';
  }

  // if time < 1000ms, return time in ms
  if (time < 1000) {
    return `${time}ms`;
  }

  // if time < 60s, return time in seconds
  if (time < 60_000) {
    return `${truncate(time / 1000, decimalPlaces)}s`;
  }

  // if time < 60m, return time in minutes and seconds
  if (time < 3_600_000) {
    const minutes = Math.floor(time / 60_000);
    const seconds = truncate((time % 60_000) / 1000, decimalPlaces);
    return `${minutes}m ${seconds}s`;
  }

  // if time >= 60m, return time in hours and minutes
  const hours = Math.floor(time / 3_600_000);
  const minutes = Math.floor((time % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function makeSimpleTable(data: Record<string, string>, title: string): string {
  if (Object.keys(data).length === 0) {
    return '';
  }

  const longestKey = Object.keys(data).reduce((acc, key) => (key.length > acc ? key.length : acc), 0);
  const longestValue = Object.values(data).reduce((acc, value) => (value.length > acc ? value.length : acc), 0);
  const table = Object.entries(data)
    .map(([key, value]) => `${key.padEnd(longestKey)}  ${value.padEnd(longestValue)}`)
    .join('\n');

  return `${title}\n${table}`;
}

export async function humanFormat(details: AgentTestDetailsResponse): Promise<string> {
  const { Ux } = await import('@salesforce/sf-plugins-core');
  const ux = new Ux();

  const tables: string[] = [];
  for (const testCase of details.testSet.testCases) {
    const table = ux.makeTable({
      title: `${ansis.bold(`Test Case #${testCase.number}`)}\n${ansis.dim('Utterance')}: ${testCase.utterance}`,
      overflow: 'wrap',
      data: testCase.expectationResults.map((r) => ({
        test: humanFriendlyName(r.name),
        result: r.result === 'Passed' ? ansis.green('Pass') : ansis.red('Fail'),
        expected: r.expectedValue,
        actual: r.actualValue,
      })),
    });
    tables.push(table);
  }

  const topicPassCount = details.testSet.testCases.reduce((acc, tc) => {
    const topic = tc.expectationResults.find((r) => r.name === 'topic_sequence_match');
    return topic?.result === 'Passed' ? acc + 1 : acc;
  }, 0);
  const topicPassPercent = (topicPassCount / details.testSet.testCases.length) * 100;

  const actionPassCount = details.testSet.testCases.reduce((acc, tc) => {
    const action = tc.expectationResults.find((r) => r.name === 'action_sequence_match');
    return action?.result === 'Passed' ? acc + 1 : acc;
  }, 0);
  const actionPassPercent = (actionPassCount / details.testSet.testCases.length) * 100;

  const outcomePassCount = details.testSet.testCases.reduce((acc, tc) => {
    const outcome = tc.expectationResults.find((r) => r.name === 'bot_response_rating');
    return outcome?.result === 'Passed' ? acc + 1 : acc;
  }, 0);
  const outcomePassPercent = (outcomePassCount / details.testSet.testCases.length) * 100;

  const results = {
    Status: details.status,
    Duration: details.endTime
      ? readableTime(new Date(details.endTime).getTime() - new Date(details.startTime).getTime())
      : 'Unknown',
    'Topic Pass %': `${topicPassPercent.toFixed(2)}%`,
    'Action Pass %': `${actionPassPercent.toFixed(2)}%`,
    'Outcome Pass %': `${outcomePassPercent.toFixed(2)}%`,
  };

  const resultsTable = makeSimpleTable(results, ansis.bold.blue('Test Results'));

  const failedTestCases = details.testSet.testCases.filter((tc) => tc.status === 'ERROR');
  const failedTestCasesObj = Object.fromEntries(
    Object.entries(failedTestCases).map(([, tc]) => [
      `Test Case #${tc.number}`,
      tc.expectationResults
        .filter((r) => r.result === 'Failed')
        .map((r) => humanFriendlyName(r.name))
        .join(', '),
    ])
  );
  const failedTestCasesTable = makeSimpleTable(failedTestCasesObj, ansis.red.bold('Failed Test Cases'));

  return tables.join('\n') + `\n${resultsTable}\n\n${failedTestCasesTable}\n`;
}

export async function jsonFormat(details: AgentTestDetailsResponse): Promise<string> {
  return Promise.resolve(JSON.stringify(details, null, 2));
}

export async function junitFormat(details: AgentTestDetailsResponse): Promise<string> {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const { XMLBuilder } = await import('fast-xml-parser');
  const builder = new XMLBuilder({
    format: true,
    attributeNamePrefix: '$',
    ignoreAttributes: false,
  });

  const testCount = details.testSet.testCases.length;
  const failureCount = details.testSet.testCases.filter((tc) => tc.status === 'ERROR').length;
  const time = details.testSet.testCases.reduce((acc, tc) => {
    if (tc.endTime && tc.startTime) {
      return acc + new Date(tc.endTime).getTime() - new Date(tc.startTime).getTime();
    }
    return acc;
  }, 0);

  const suites = builder.build({
    testsuites: {
      $name: details.subjectName,
      $tests: testCount,
      $failures: failureCount,
      $time: time,
      property: [
        { $name: 'status', $value: details.status },
        { $name: 'start-time', $value: details.startTime },
        { $name: 'end-time', $value: details.endTime },
      ],
      testsuite: details.testSet.testCases.map((testCase) => {
        const testCaseTime = testCase.endTime
          ? new Date(testCase.endTime).getTime() - new Date(testCase.startTime).getTime()
          : 0;

        return {
          $name: `${details.testSet.name}.${testCase.number}`,
          $time: testCaseTime,
          $assertions: testCase.expectationResults.length,
          failure: testCase.expectationResults
            .map((r) => {
              if (r.result === 'Failed') {
                return { $message: r.errorMessage ?? 'Unknown error', $name: r.name };
              }
            })
            .filter((f) => f),
        };
      }),
    },
  }) as string;

  return `<?xml version="1.0" encoding="UTF-8"?>\n${suites}`.trim();
}

export async function tapFormat(details: AgentTestDetailsResponse): Promise<string> {
  const lines: string[] = [];
  let expectationCount = 0;
  for (const testCase of details.testSet.testCases) {
    for (const result of testCase.expectationResults) {
      const status = result.result === 'Passed' ? 'ok' : 'not ok';
      expectationCount++;
      lines.push(`${status} ${expectationCount} ${details.testSet.name}.${testCase.number}`);
      if (status === 'not ok') {
        lines.push('  ---');
        lines.push(`  message: ${result.errorMessage ?? 'Unknown error'}`);
        lines.push(`  expectation: ${result.name}`);
        lines.push(`  actual: ${result.actualValue}`);
        lines.push(`  expected: ${result.expectedValue}`);
        lines.push('  ...');
      }
    }
  }

  return Promise.resolve(`Tap Version 14\n1..${expectationCount}\n${lines.join('\n')}`);
}
