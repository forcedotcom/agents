/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Connection, Lifecycle, PollingClient, StatusResult } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { MaybeMock } from './maybe-mock';

type Format = 'human' | 'json';

type TestStatus = 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';

type AgentTestStartResponse = {
  aiEvaluationId: string;
  status: TestStatus;
};

type AgentTestStatusResponse = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
};

type TestCaseResult = {
  status: TestStatus;
  number: string;
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

type AgentTestDetailsResponse = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
  testCases: TestCaseResult[];
};

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
  public async start(nameOrId: string, type: 'name' | 'id' = 'name'): Promise<{ aiEvaluationId: string }> {
    const url = '/einstein/ai-evaluations/runs';

    return this.maybeMock.request<AgentTestStartResponse>('POST', url, {
      [type === 'name' ? 'aiEvaluationDefinitionName' : 'aiEvaluationDefinitionVersionId']: nameOrId,
    });
  }

  public async status(jobId: string): Promise<AgentTestStatusResponse> {
    const url = `/einstein/ai-evaluations/runs/${jobId}`;

    return this.maybeMock.request<AgentTestStatusResponse>('GET', url);
  }

  public async poll(
    jobId: string,
    {
      format = 'human',
      timeout = Duration.minutes(5),
    }: {
      format?: Format;
      timeout?: Duration;
    } = {
      format: 'human',
      timeout: Duration.minutes(5),
    }
  ): Promise<{ response: AgentTestDetailsResponse; formatted: string }> {
    const lifecycle = Lifecycle.getInstance();
    const client = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        const { status } = await this.status(jobId);
        if (status === 'COMPLETED') {
          await lifecycle.emit('AGENT_TEST_POLLING_EVENT', { jobId, status });
          return { payload: await this.details(jobId, format), completed: true };
        }

        await lifecycle.emit('AGENT_TEST_POLLING_EVENT', { jobId, status });
        return { completed: false };
      },
      frequency: Duration.seconds(1),
      timeout,
    });

    const result = await client.subscribe<{ response: AgentTestDetailsResponse; formatted: string }>();
    return result;
  }

  public async details(
    jobId: string,
    format: Format = 'human'
  ): Promise<{ response: AgentTestDetailsResponse; formatted: string }> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/details`;

    const response = await this.maybeMock.request<AgentTestDetailsResponse>('GET', url);
    return {
      response,
      formatted: format === 'human' ? await humanFormat(jobId, response) : await jsonFormat(response),
    };
  }

  public async cancel(jobId: string): Promise<{ success: boolean }> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/cancel`;

    return this.maybeMock.request<{ success: boolean }>('POST', url);
  }
}

export async function humanFormat(name: string, details: AgentTestDetailsResponse): Promise<string> {
  const { Ux } = await import('@salesforce/sf-plugins-core');
  const ux = new Ux();

  const tables: string[] = [];
  for (const testCase of details.testCases) {
    const table = ux.makeTable({
      title: `Test Case #${testCase.number}`,
      data: testCase.expectationResults.map((r) => ({
        name: r.name,
        outcome: r.result === 'Passed' ? 'Pass' : 'Fail',
        actualValue: r.actualValue,
        expectedValue: r.expectedValue,
        score: r.score,
        'metric label': r.metricLabel,
        message: r.errorMessage ?? '',
        'runtime (MS)': r.endTime ? new Date(r.endTime).getTime() - new Date(r.startTime).getTime() : 0,
      })),
    });
    tables.push(table);
  }
  return tables.join('\n');
}

export async function jsonFormat(details: AgentTestDetailsResponse): Promise<string> {
  return Promise.resolve(JSON.stringify(details, null, 2));
}
