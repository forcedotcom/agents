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
import { ComponentSetBuilder, DeployResult, FileProperties, RequestStatus } from '@salesforce/source-deploy-retrieve';
import { parse, stringify } from 'yaml';
import { XMLBuilder } from 'fast-xml-parser';
import { MaybeMock } from './maybe-mock';

export type TestStatus = 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR' | 'TERMINATED';

export type AgentTestStartResponse = {
  runId: string;
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
  testNumber: number;
};

export type AgentTestResultsResponse = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
  subjectName: string;
  testCases: TestCaseResult[];
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
   * @param aiEvalDefName - The name or ID of the AI evaluation definition.
   * @param type - Specifies whether the provided identifier is a 'name' or 'id'. Defaults to 'name'. If 'name' is provided, nameOrId is treated as the name of the AiEvaluationDefinition. If 'id' is provided, nameOrId is treated as the unique ID of the AiEvaluationDefinition.
   * @returns A promise that resolves to an object containing the ID of the started AI evaluation run.
   */
  public async start(aiEvalDefName: string): Promise<AgentTestStartResponse> {
    const url = '/einstein/ai-evaluations/runs';

    return this.maybeMock.request<AgentTestStartResponse>('POST', url, {
      aiEvaluationDefinitionName: aiEvalDefName,
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
        testCase: parsed.testCases.map((tc) => ({
          number: parsed.testCases.indexOf(tc) + 1,
          inputs: {
            utterance: tc.utterance,
          },
          expectation: [
            {
              name: 'topic_sequence_match',
              expectedValue: tc.expectedTopic,
            },
            {
              name: 'action_sequence_match',
              expectedValue: `[${tc.expectedActions.map((v) => `"${v}"`).join(',')}]`,
            },
            {
              name: 'bot_response_rating',
              expectedValue: tc.expectedOutcome,
            },
          ],
        })),
      },
    }) as string;
    const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
    await mkdir(outputDir, { recursive: true });
    await writeFile(definitionPath, finalXml);
    if (preview)
      return {
        path: definitionPath,
        contents: finalXml,
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

    return { path: definitionPath, contents: finalXml, deployResult: result };
  }
}

export async function convertTestResultsToFormat(
  results: AgentTestResultsResponse,
  format: 'json' | 'junit' | 'tap'
): Promise<string> {
  switch (format) {
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

/**
 * Clean a string by replacing HTML entities with their respective characters. Implementation done by copilot.
 *
 * This is only required until W-17594913 is resolved by SF Eval
 *
 * @param str - The string to clean.
 * @returns The cleaned string with all HTML entities replaced with their respective characters.
 */
function decodeHtmlEntities(str: string): string {
  const entities: { [key: string]: string } = {
    '&quot;': '"',
    '&apos;': "'",
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&#39;': "'",
  };

  return str.replace(/&[a-zA-Z0-9#]+;/g, (entity) => entities[entity] || entity);
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

  const testCount = results.testCases.length;
  const failureCount = results.testCases.filter(
    (tc) =>
      ['error', 'completed'].includes(tc.status.toLowerCase()) && tc.testResults.some((r) => r.result === 'FAILURE')
  ).length;
  const time = results.testCases.reduce((acc, tc) => {
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
      testsuite: results.testCases.map((testCase) => {
        const testCaseTime = testCase.endTime
          ? new Date(testCase.endTime).getTime() - new Date(testCase.startTime).getTime()
          : 0;

        return {
          $name: testCase.testNumber,
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

export function humanFriendlyName(name: string): string {
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

async function tapFormat(results: AgentTestResultsResponse): Promise<string> {
  const lines: string[] = [];
  let expectationCount = 0;
  for (const testCase of results.testCases) {
    for (const result of testCase.testResults) {
      const status = result.result === 'PASS' ? 'ok' : 'not ok';
      expectationCount++;
      lines.push(`${status} ${expectationCount} ${testCase.testNumber}.${result.name}`);
      if (status === 'not ok') {
        lines.push('  ---');
        lines.push(`  message: ${result.errorMessage ?? 'Unknown error'}`);
        lines.push(`  expectation: ${result.name}`);
        lines.push(`  actual: ${decodeHtmlEntities(result.actualValue)}`);
        lines.push(`  expected: ${decodeHtmlEntities(result.expectedValue)}`);
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

  const yml = stringify(clean, undefined, {
    minContentWidth: 0,
    lineWidth: 0,
  });
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, yml);
}
