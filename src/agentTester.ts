/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Connection, Lifecycle, PollingClient, SfError, StatusResult } from '@salesforce/core';
import { Duration, env } from '@salesforce/kit';
import ansis from 'ansis';
import { ComponentSetBuilder, DeployResult, FileProperties, RequestStatus } from '@salesforce/source-deploy-retrieve';
import { parse, stringify } from 'yaml';
import { XMLBuilder } from 'fast-xml-parser';
import { MaybeMock } from './maybe-mock';

export type TestStatus = 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR' | 'TERMINATED';

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
  startTime: string;
  endTime?: string;
  inputs: {
    utterance: string;
  };
  generatedData: {
    actionsSequence: string[];
    outcome: string;
    topic: string;
  };
  testResults: Array<{
    name: string;
    actualValue: string;
    expectedValue: string;
    score: number;
    result: 'PASS' | 'FAILURE';
    metricLabel: 'Accuracy' | 'Precision';
    metricExplainability: string;
    status: TestStatus;
    startTime: string;
    endTime?: string;
    errorCode?: string;
    errorMessage?: string;
  }>;
};

export type AgentTestResultsResponse = {
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

export type AvailableDefinition = Omit<FileProperties, 'manageableState' | 'namespacePrefix'>;

export type TestCase = {
  utterance: string;
  expectedActions: string[];
  expectedOutcome: string;
  expectedTopic: string;
};

export type TestSpec = {
  name: string;
  description?: string;
  subjectType: string;
  subjectName: string;
  subjectVersion?: string;
  testCases: TestCase[];
};

export const AgentTestCreateLifecycleStages = {
  CreatingLocalMetadata: 'Creating Local Metadata',
  Waiting: 'Waiting for the org to respond',
  DeployingMetadata: 'Deploying Metadata',
  Done: 'Done',
};

/**
 * AgentTester class to test Agents
 */
export class AgentTester {
  private maybeMock: MaybeMock;
  public constructor(private connection: Connection) {
    this.maybeMock = new MaybeMock(connection);
  }

  /**
   * List the AiEvaluationDefinitions available in the org.
   */
  public async list(): Promise<AvailableDefinition[]> {
    return this.connection.metadata.list({ type: 'AiEvaluationDefinition' });
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
          const totalTestCases = resultsResponse.testSet.testCases.length;
          const passingTestCases = resultsResponse.testSet.testCases.filter(
            (tc) => tc.status.toLowerCase() === 'completed' && tc.testResults.every((r) => r.result === 'PASS')
          ).length;
          const failingTestCases = resultsResponse.testSet.testCases.filter(
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
   * Request test run details
   *
   * @param {string} jobId
   * @returns {Promise<AgentTestResultsResponse>}
   */
  public async results(jobId: string): Promise<AgentTestResultsResponse> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/results`;

    return this.maybeMock.request<AgentTestResultsResponse>('GET', url);
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

  /**
   * Creates and deploys an AiEvaluationDefinition from a specification file.
   *
   * @param specFilePath - The path to the specification file to create the definition from
   * @param options - Configuration options for creating the definition
   * @param options.outputDir - The directory where the AiEvaluationDefinition file will be written
   * @param options.preview - If true, writes the AiEvaluationDefinition file to <api-name>-preview-<timestamp>.xml in the current working directory and does not deploy it
   * @param options.confirmationCallback - Optional callback function to confirm overwriting existing definitions
   *
   * @returns Promise containing:
   * - path: The filesystem path to the created AiEvaluationDefinition file
   * - contents: The AiEvaluationDefinition contents as a string
   * - deployResult: The deployment result (if not in preview mode)
   *
   * @throws {SfError} When a definition with the same name already exists and is not confirmed to be overwritten
   * @throws {SfError} When deployment fails
   */
  public async create(
    specFilePath: string,
    options: { outputDir: string; preview?: boolean; confirmationCallback?: (spec: TestSpec) => Promise<boolean> }
  ): Promise<{ path: string; contents: string; deployResult?: DeployResult }> {
    const parsed = parse(await readFile(specFilePath, 'utf-8')) as TestSpec;
    const existingDefinitions = await this.list();

    if (existingDefinitions.some((d) => d.fullName === parsed.name)) {
      const getConfirmation = options.confirmationCallback ?? (async (): Promise<boolean> => Promise.resolve(false));
      const confirmation = await getConfirmation(parsed);
      if (!confirmation) {
        throw new SfError(`An AiEvaluationDefinition with the name ${parsed.name} already exists in the org.`);
      }
    }

    const lifecycle = Lifecycle.getInstance();
    await lifecycle.emit(AgentTestCreateLifecycleStages.CreatingLocalMetadata, {});
    const preview = options.preview ?? false;
    // outputDir is overridden if preview is true
    const outputDir = preview ? process.cwd() : options.outputDir;
    const filename = preview
      ? `${parsed.name}-preview-${new Date().toISOString()}.xml`
      : `${parsed.name}.aiEvaluationDefinition-meta.xml`;
    const definitionPath = join(outputDir, filename);

    const builder = new XMLBuilder({
      format: true,
      attributeNamePrefix: '$',
      ignoreAttributes: false,
    });

    const xml = builder.build({
      AiEvaluationDefinition: {
        $xmlns: 'http://soap.sforce.com/2006/04/metadata',
        ...(parsed.description && { description: parsed.description }),
        name: parsed.name,
        subjectType: parsed.subjectType,
        subjectName: parsed.subjectName,
        ...(parsed.subjectVersion && { subjectVersion: parsed.subjectVersion }),
        // TODO: Once SF Eval removes AiEvaluationTestSet, we can remove testSetName and uncomment testCase
        testSetName: 'CliTestSet',
        // testCase: parsed.testCases.map((tc) => ({
        //   number: parsed.testCases.indexOf(tc) + 1,
        //   inputs: {
        //     utterance: tc.utterance,
        //   },
        //   expectation: [
        //     {
        //       name: 'expectedTopic',
        //       expectedValue: tc.topicSequenceExpectedValue,
        //     },
        //     {
        //       name: 'expectedActions',
        //       expectedValue: `[${tc.actionSequenceExpectedValue.map((v) => `"${v}"`).join(',')}]`,
        //     },
        //     {
        //       name: 'expectedOutcome',
        //       expectedValue: tc.botRatingExpectedValue,
        //     },
        //   ],
        // })),
      },
    }) as string;

    await mkdir(outputDir, { recursive: true });
    await writeFile(definitionPath, `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
    if (preview)
      return {
        path: definitionPath,
        contents: xml,
      };

    const cs = await ComponentSetBuilder.build({ sourcepath: [definitionPath] });
    const deploy = await cs.deploy({ usernameOrConnection: this.connection });
    deploy.onUpdate((status) => {
      if (status.status === RequestStatus.Pending) {
        void lifecycle.emit(AgentTestCreateLifecycleStages.Waiting, status);
      } else {
        void lifecycle.emit(AgentTestCreateLifecycleStages.DeployingMetadata, status);
      }
    });

    deploy.onFinish((result) => {
      void lifecycle.emit(AgentTestCreateLifecycleStages.Done, result);
    });

    const result = await deploy.pollStatus({ timeout: Duration.minutes(10_000), frequency: Duration.seconds(1) });

    if (!result.response.success) {
      throw new SfError(result.response.errorMessage ?? `Unable to deploy ${result.response.id}`);
    }

    return { path: definitionPath, contents: xml, deployResult: result };
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

export async function convertTestResultsToFormat(
  results: AgentTestResultsResponse,
  format: 'human' | 'json' | 'junit' | 'tap'
): Promise<string> {
  switch (format) {
    case 'human':
      return humanFormat(results);
    case 'json':
      return jsonFormat(results);
    case 'junit':
      return junitFormat(results);
    case 'tap':
      return tapFormat(results);
    default:
      throw new Error(`Unsupported format: ${format as string}`);
  }
}

async function humanFormat(details: AgentTestResultsResponse): Promise<string> {
  const { Ux } = await import('@salesforce/sf-plugins-core');
  const ux = new Ux();

  const tables: string[] = [];
  for (const testCase of details.testSet.testCases) {
    const number = details.testSet.testCases.indexOf(testCase) + 1;
    const table = ux.makeTable({
      title: `${ansis.bold(`Test Case #${number}`)}\n${ansis.dim('Utterance')}: ${testCase.inputs.utterance}`,
      overflow: 'wrap',
      columns: ['test', 'result', { key: 'expected', width: '40%' }, { key: 'actual', width: '40%' }],
      data: testCase.testResults.map((r) => ({
        test: r.name,
        result: r.result === 'PASS' ? ansis.green('Pass') : ansis.red('Fail'),
        expected: r.expectedValue,
        actual: r.actualValue,
      })),
      width: '100%',
    });
    tables.push(table);
  }

  const topicPassCount = details.testSet.testCases.reduce((acc, tc) => {
    const topic = tc.testResults.find((r) => r.name === 'topic_sequence_match');
    return topic?.result === 'PASS' ? acc + 1 : acc;
  }, 0);
  const topicPassPercent = (topicPassCount / details.testSet.testCases.length) * 100;

  const actionPassCount = details.testSet.testCases.reduce((acc, tc) => {
    const action = tc.testResults.find((r) => r.name === 'action_sequence_match');
    return action?.result === 'PASS' ? acc + 1 : acc;
  }, 0);
  const actionPassPercent = (actionPassCount / details.testSet.testCases.length) * 100;

  const outcomePassCount = details.testSet.testCases.reduce((acc, tc) => {
    const outcome = tc.testResults.find((r) => r.name === 'bot_response_rating');
    return outcome?.result === 'PASS' ? acc + 1 : acc;
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

  const failedTestCases = details.testSet.testCases.filter((tc) => tc.status.toLowerCase() === 'error');
  const failedTestCasesObj = Object.fromEntries(
    Object.entries(failedTestCases).map(([, tc]) => [
      `Test Case #${failedTestCases.indexOf(tc) + 1}`,
      tc.testResults.filter((r) => r.result === 'FAILURE').join(', '),
    ])
  );
  const failedTestCasesTable = makeSimpleTable(failedTestCasesObj, ansis.red.bold('Failed Test Cases'));

  return tables.join('\n') + `\n${resultsTable}\n\n${failedTestCasesTable}\n`;
}

async function jsonFormat(results: AgentTestResultsResponse): Promise<string> {
  return Promise.resolve(JSON.stringify(results, null, 2));
}

async function junitFormat(results: AgentTestResultsResponse): Promise<string> {
  const builder = new XMLBuilder({
    format: true,
    attributeNamePrefix: '$',
    ignoreAttributes: false,
  });

  const testCount = results.testSet.testCases.length;
  const failureCount = results.testSet.testCases.filter(
    (tc) =>
      ['error', 'completed'].includes(tc.status.toLowerCase()) && tc.testResults.some((r) => r.result === 'FAILURE')
  ).length;
  const time = results.testSet.testCases.reduce((acc, tc) => {
    if (tc.endTime && tc.startTime) {
      return acc + new Date(tc.endTime).getTime() - new Date(tc.startTime).getTime();
    }
    return acc;
  }, 0);

  const suites = builder.build({
    testsuites: {
      $name: results.subjectName,
      $tests: testCount,
      $failures: failureCount,
      $time: time,
      property: [
        { $name: 'status', $value: results.status },
        { $name: 'start-time', $value: results.startTime },
        { $name: 'end-time', $value: results.endTime },
      ],
      testsuite: results.testSet.testCases.map((testCase) => {
        const testCaseTime = testCase.endTime
          ? new Date(testCase.endTime).getTime() - new Date(testCase.startTime).getTime()
          : 0;

        return {
          $name: `${results.testSet.name}.${results.testSet.testCases.indexOf(testCase) + 1}`,
          $time: testCaseTime,
          $assertions: testCase.testResults.length,
          failure: testCase.testResults
            .map((r) => {
              if (r.result === 'FAILURE') {
                return { $message: r.errorMessage ?? 'Unknown error', $name: r.name };
              }
            })
            .filter((f) => f),
        };
      }),
    },
  }) as string;

  return Promise.resolve(`<?xml version="1.0" encoding="UTF-8"?>\n${suites}`.trim());
}

async function tapFormat(results: AgentTestResultsResponse): Promise<string> {
  const lines: string[] = [];
  let expectationCount = 0;
  for (const testCase of results.testSet.testCases) {
    for (const result of testCase.testResults) {
      const status = result.result === 'PASS' ? 'ok' : 'not ok';
      expectationCount++;
      lines.push(
        `${status} ${expectationCount} ${results.testSet.name}.${results.testSet.testCases.indexOf(testCase) + 1}`
      );
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

/**
 * Generate a test spec file from a TestSpec object
 */
export async function generateTestSpec(spec: TestSpec, outputFile: string): Promise<void> {
  // strip out undefined values and empty strings
  const clean = Object.entries(spec).reduce<Partial<TestSpec>>((acc, [key, value]) => {
    if (value !== undefined && value !== '') return { ...acc, [key]: value };
    return acc;
  }, {});

  const yml = stringify(clean);
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, yml);
}
