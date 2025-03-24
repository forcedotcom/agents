/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
/* eslint-disable jsdoc/check-indentation */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Connection, Lifecycle, PollingClient, SfError, StatusResult } from '@salesforce/core';
import { Duration, env } from '@salesforce/kit';
import { ComponentSetBuilder, DeployResult, FileProperties, RequestStatus } from '@salesforce/source-deploy-retrieve';
import { parse, stringify } from 'yaml';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { MaybeMock } from './maybe-mock';
import { decodeHtmlEntities } from './utils';

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
  expectedActions: string[] | undefined;
  expectedOutcome: string | undefined;
  expectedTopic: string | undefined;
};

export type TestSpec = {
  name: string;
  description?: string;
  subjectType: string;
  subjectName: string;
  subjectVersion?: string;
  testCases: TestCase[];
};

type AiEvaluationDefinition = {
  AiEvaluationDefinition: {
    description?: string;
    name: string;
    subjectType: 'AGENT';
    subjectName: string;
    subjectVersion?: string;
    testCase: Array<{
      expectation: Array<{
        name: string;
        expectedValue: string;
      }>;
      inputs: {
        utterance: string;
      };
    }>;
  };
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
   * Initiates an AI evaluation run.
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

    const results = await this.maybeMock.request<AgentTestResultsResponse>('GET', url);
    return normalizeResults(results);
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
   * @param apiName - The API name of the AiEvaluationDefinition to create
   * @param specFilePath - The path to the specification file to create the definition from
   * @param options - Configuration options for creating the definition
   * @param options.outputDir - The directory where the AiEvaluationDefinition file will be written
   * @param options.preview - If true, writes the AiEvaluationDefinition file to <api-name>-preview-<timestamp>.xml in the current working directory and does not deploy it
   *
   * @returns Promise containing:
   * - path: The filesystem path to the created AiEvaluationDefinition file
   * - contents: The AiEvaluationDefinition contents as a string
   * - deployResult: The deployment result (if not in preview mode)
   *
   * @throws {SfError} When deployment fails
   */
  public async create(
    apiName: string,
    specFilePath: string,
    options: { outputDir: string; preview?: boolean }
  ): Promise<{ path: string; contents: string; deployResult?: DeployResult }> {
    const parsed = parse(await readFile(specFilePath, 'utf-8')) as TestSpec;
    const lifecycle = Lifecycle.getInstance();
    await lifecycle.emit(AgentTestCreateLifecycleStages.CreatingLocalMetadata, {});
    const preview = options.preview ?? false;
    // outputDir is overridden if preview is true
    const outputDir = preview ? process.cwd() : options.outputDir;
    const filename = preview
      ? `${apiName}-preview-${new Date().toISOString()}.xml`
      : `${apiName}.aiEvaluationDefinition-meta.xml`;
    const definitionPath = join(outputDir, filename);

    const builder = new XMLBuilder({
      format: true,
      attributeNamePrefix: '$',
      indentBy: '    ',
      ignoreAttributes: false,
    });

    const xml = builder.build({
      AiEvaluationDefinition: {
        $xmlns: 'http://soap.sforce.com/2006/04/metadata',
        ...(parsed.description && { description: parsed.description }),
        name: parsed.name,
        subjectName: parsed.subjectName,
        subjectType: parsed.subjectType,
        ...(parsed.subjectVersion && { subjectVersion: parsed.subjectVersion }),
        testCase: parsed.testCases.map((tc) => ({
          expectation: [
            {
              expectedValue: tc.expectedTopic,
              name: 'topic_sequence_match',
            },
            {
              expectedValue: `[${(tc.expectedActions ?? []).map((v) => `"${v}"`).join(',')}]`,
              name: 'action_sequence_match',
            },
            {
              expectedValue: tc.expectedOutcome,
              name: 'bot_response_rating',
            },
          ],
          inputs: {
            utterance: tc.utterance,
          },
          number: parsed.testCases.indexOf(tc) + 1,
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
      // small deploys like this, 1 file, can happen without an 'update' event being fired
      // onFinish, emit the update, and then the done event to create proper output
      void lifecycle.emit(AgentTestCreateLifecycleStages.DeployingMetadata, result);
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
 * Normalizes test results by decoding HTML entities in utterances and test result values.
 *
 * @param results - The agent test results response object to normalize
 * @returns A new AgentTestResultsResponse with decoded HTML entities
 *
 * @example
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
      })),
    })),
  };
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
  // topic_sequence_match, action_sequence_match, and bot_response_rating have all changed
  // eventually we can remove them
  switch (name) {
    case 'topic_sequence_match':
    case 'topic_assertion':
      return 'Topic';
    case 'action_sequence_match':
    case 'actions_assertion':
      return 'Action';
    case 'bot_response_rating':
    case 'output_validation':
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
        lines.push(`  actual: ${result.actualValue}`);
        lines.push(`  expected: ${result.expectedValue}`);
        lines.push('  ...');
      }
    }
  }

  return Promise.resolve(`Tap Version 14\n1..${expectationCount}\n${lines.join('\n')}`);
}

function transformStringToArray(str: string | undefined): string[] {
  try {
    if (!str) return [];
    // Remove any whitespace and ensure proper JSON format
    const cleaned = str.replace(/\s+/g, '');
    return JSON.parse(cleaned) as string[];
  } catch {
    return [];
  }
}

function castArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Generate a test specification file in YAML format.
 * This function takes a test specification object, cleans it by removing undefined and empty string values,
 * converts it to YAML format, and writes it to the specified output file.
 *
 * @param spec - The test specification object to be converted to YAML.
 * @param outputFile - The file path where the YAML output should be written.
 * @throws {Error} - May throw an error if file operations fail.
 * @returns A Promise that resolves when the file has been written.
 */
export async function writeTestSpec(spec: TestSpec, outputFile: string): Promise<void> {
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

/**
 * Generates a TestSpec object from an AI Evaluation Definition XML file.
 *
 * @param path - The file path to the AI Evaluation Definition XML file.
 * @returns Promise that resolves to a TestSpec object containing the parsed evaluation definition data.
 * @description Reads and parses an XML file containing AIEvaluationDefinition, converting it into a structured TestSpec format.
 *
 * @throws {Error} If the file cannot be read or parsed.
 */
export async function generateTestSpecFromAiEvalDefinition(path: string): Promise<TestSpec> {
  const xml = await readFile(path, 'utf-8');
  const parser = new XMLParser();
  const parsed = parser.parse(xml) as AiEvaluationDefinition;
  return {
    name: parsed.AiEvaluationDefinition.name,
    description: parsed.AiEvaluationDefinition.description,
    subjectType: parsed.AiEvaluationDefinition.subjectType,
    subjectName: parsed.AiEvaluationDefinition.subjectName,
    subjectVersion: parsed.AiEvaluationDefinition.subjectVersion,
    testCases: castArray(parsed.AiEvaluationDefinition.testCase).map((tc) => {
      const expectations = castArray(tc.expectation);
      return {
        utterance: tc.inputs.utterance,
        expectedTopic: expectations.find((e) => e.name === 'topic_sequence_match')?.expectedValue,
        expectedActions: transformStringToArray(
          expectations.find((e) => e.name === 'action_sequence_match')?.expectedValue
        ),
        expectedOutcome: expectations.find((e) => e.name === 'bot_response_rating')?.expectedValue,
      };
    }),
  };
}
