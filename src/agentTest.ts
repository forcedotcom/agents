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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Connection, Lifecycle, Messages, SfError } from '@salesforce/core';
import { Duration, ensureArray } from '@salesforce/kit';
import { ComponentSetBuilder, DeployResult, RequestStatus } from '@salesforce/source-deploy-retrieve';
import { parse, stringify } from 'yaml';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import {
  AvailableDefinition,
  AgentTestConfig,
  AiEvaluationDefinition,
  AiTestCase,
  AiTestCaseScorer,
  AiTestingDefinition,
  AiConversationTurnXml,
  TestSpec,
  MetadataExpectation,
  NgtTestSpec,
  NgtTestCase,
  NgtTestCaseInput,
} from './types.js';
import { isNgtScorerName, NgtScorerCatalog, NgtScorerName } from './ngtScorerCatalog';
import { metric, sanitizeFilename, TestRunnerType } from './utils';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agentTest');

/**
 * Events emitted during agent test creation for consumers to listen to and keep track of progress.
 */
export const AgentTestCreateLifecycleStages = {
  CreatingLocalMetadata: 'Creating Local Metadata',
  Waiting: 'Waiting for the org to respond',
  DeployingMetadata: 'Deploying Metadata',
  Done: 'Done',
};

/**
 * A client side representation of an agent test (AiEvaluationDefinition) within an org.
 * Also provides utilities such as creating and listing agent tests, and converting between
 * agent test spec and AiEvaluationDefinition.
 *
 * **Examples**
 *
 * Create a new instance from an agent test spec:
 *
 * `const agentTest = new AgentTest({ specPath: path/to/specfile });`
 *
 * Get the metadata content of an agent test:
 *
 * `const metadataContent = await agentTest.getMetadata();`
 *
 * Write the metadata content to a file:
 *
 * `await agentTest.writeMetadata('path/to/metadataFile');`
 */
export class AgentTest {
  private specData?: TestSpec;
  private data?: AiEvaluationDefinition;

  /**
   * Create an AgentTest based on one of:
   *
   * 1. AiEvaluationDefinition API name.
   * 2. Path to a local AiEvaluationDefinition metadata file.
   * 3. Path to a local agent test spec file.
   * 4. Agent test spec data.
   *
   * @param config AgentTestConfig
   */
  public constructor(private config: AgentTestConfig) {
    const { name, mdPath, specPath, specData } = config;

    if (!name && !mdPath && !specPath && !specData) {
      throw messages.createError('invalidAgentTestConfig');
    }
    if (specData) {
      this.specData = specData;
    }
  }

  /**
   * List the AiEvaluationDefinitions and AiTestingDefinitions metadata in the org.
   */
  public static async list(connection: Connection): Promise<AvailableDefinition[]> {
    const [evalDefs, testingDefs] = await Promise.all([
      connection.metadata.list({ type: 'AiEvaluationDefinition' }),
      connection.metadata.list({ type: 'AiTestingDefinition' }),
    ]);
    return [...evalDefs, ...testingDefs];
  }

  /**
   * Creates and deploys a test definition from a specification file.
   *
   * Two metadata types are supported, selected via `options.testRunner`:
   * `'testing-center'` (default) — legacy `AiEvaluationDefinition`. Filename `<apiName>.aiEvaluationDefinition-meta.xml`.
   * `'agentforce-studio'` — new `AiTestingDefinition` (NGT). Filename `<apiName>.aiTestingDefinition-meta.xml`.
   * Requires Metadata API v66.0 or later on the target org; the server gates this and the lib does not preflight.
   *
   * @param connection - Connection to the org where the agent test will be created.
   * @param apiName - The API name of the test definition to create.
   * @param specFilePath - The path to the YAML specification file.
   * @param options - Configuration options for creating the definition.
   * @param options.outputDir - The directory where the metadata file will be written.
   * @param options.preview - If true, writes the metadata file to `<apiName>-preview-<timestamp>.xml` in the current working directory and does not deploy.
   * @param options.testRunner - Which test runner to author for. Defaults to `'testing-center'`.
   *
   * @returns Promise containing:
   * - path: The filesystem path to the created metadata file.
   * - contents: The metadata XML as a string.
   * - deployResult: The deployment result (if not in preview mode).
   *
   * @throws {SfError} When validation or deployment fails.
   */
  public static async create(
    connection: Connection,
    apiName: string,
    specFilePath: string,
    options: { outputDir: string; preview?: boolean; testRunner?: TestRunnerType }
  ): Promise<{ path: string; contents: string; deployResult?: DeployResult }> {
    const lifecycle = Lifecycle.getInstance();
    const preview = options.preview ?? false;
    const testRunner: TestRunnerType = options.testRunner ?? 'testing-center';
    const outputDir = preview ? process.cwd() : options.outputDir;

    const rawSpec = await readFile(specFilePath, 'utf-8');

    let xml: string;
    let definitionPath: string;

    if (testRunner === 'agentforce-studio') {
      const ngtSpec = parse(rawSpec) as NgtTestSpec;
      const isMultiAgent = await fetchIsMultiAgent(connection, ngtSpec.subjectName);
      validateNgtSpec(ngtSpec, { isMultiAgent });
      await lifecycle.emit(AgentTestCreateLifecycleStages.CreatingLocalMetadata, {});

      const filename = preview
        ? `${apiName}-preview-${new Date().toISOString()}.xml`
        : `${apiName}.aiTestingDefinition-meta.xml`;
      definitionPath = join(outputDir, sanitizeFilename(filename));
      xml = buildTestingMetadataXml(convertToTestingMetadata(ngtSpec));
    } else {
      const agentTestSpec = parse(rawSpec) as TestSpec;
      await lifecycle.emit(AgentTestCreateLifecycleStages.CreatingLocalMetadata, {});

      const filename = preview
        ? `${apiName}-preview-${new Date().toISOString()}.xml`
        : `${apiName}.aiEvaluationDefinition-meta.xml`;
      definitionPath = join(outputDir, sanitizeFilename(filename));
      xml = buildMetadataXml(convertToMetadata(agentTestSpec));
    }

    await mkdir(outputDir, { recursive: true });
    await writeFile(definitionPath, xml);

    if (preview) {
      return { path: definitionPath, contents: xml };
    }

    const cs = await ComponentSetBuilder.build({ sourcepath: [definitionPath] });
    const deploy = await cs.deploy({ usernameOrConnection: connection });
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
      throw new SfError(
        ensureArray(result.response.details.componentFailures)
          .map((failure) => failure.problem)
          .join()
      );
    }

    return { path: definitionPath, contents: xml, deployResult: result };
  }

  /**
   * Get the specification for this agent test.
   *
   * Returns the test spec data if already generated. Otherwise it will generate the spec by:
   *
   * 1. Read from an existing local spec file.
   * 2. Read from an existing local AiEvaluationDefinition metadata file and convert it.
   * 3. Use the provided org connection to read the remote AiEvaluationDefinition metadata.
   *
   * @param connection Org connection to use if this AgentTest only has an AiEvaluationDefinition API name.
   * @returns Promise<TestSpec>
   */
  public async getTestSpec(connection?: Connection): Promise<TestSpec> {
    if (this.specData) {
      return this.specData;
    }
    if (this.data) {
      this.specData = convertToSpec(this.data);
      return this.specData;
    }
    if (this.config.specPath) {
      this.specData = parse(await readFile(this.config.specPath, 'utf-8')) as TestSpec;
      return this.specData;
    }
    if (this.config.mdPath) {
      this.data = await parseAgentTestXml(this.config.mdPath);
      this.specData = convertToSpec(this.data);
      return this.specData;
    }
    // read from the server if we have a connection and an API name only
    if (this.config.name) {
      if (connection) {
        // @ts-expect-error jsForce types don't know about AiEvaluationDefinition yet
        this.data = (await connection.metadata.read<AiEvaluationDefinition>(
          'AiEvaluationDefinition',
          this.config.name
        )) as AiEvaluationDefinition;
        this.specData = convertToSpec(this.data);
        return this.specData;
      } else {
        throw messages.createError('missingConnection');
      }
    }
    throw messages.createError('missingTestSpecData');
  }

  /**
   * Get the metadata content for this agent test.
   *
   * Returns the AiEvaluationDefinition metadata if already generated. Otherwise it will get it by:
   *
   * 1. Read from an existing local AiEvaluationDefinition metadata file.
   * 2. Read from an existing local spec file and convert it.
   * 3. Use the provided org connection to read the remote AiEvaluationDefinition metadata.
   *
   * @param connection Org connection to use if this AgentTest only has an AiEvaluationDefinition API name.
   * @returns Promise<TestSpec>
   */
  public async getMetadata(connection?: Connection): Promise<AiEvaluationDefinition> {
    if (this.data) {
      return this.data;
    }
    if (this.specData) {
      this.data = convertToMetadata(this.specData);
      return this.data;
    }
    if (this.config.mdPath) {
      this.data = await parseAgentTestXml(this.config.mdPath);
      return this.data;
    }
    if (this.config.specPath) {
      this.specData = parse(await readFile(this.config.specPath, 'utf-8')) as TestSpec;
      this.data = convertToMetadata(this.specData);
      return this.data;
    }
    // read from the server if we have a connection and an API name only
    if (this.config.name) {
      if (connection) {
        // @ts-expect-error jsForce types don't know about AiEvaluationDefinition yet
        this.data = (await connection.metadata.read<AiEvaluationDefinition>(
          'AiEvaluationDefinition',
          this.config.name
        )) as AiEvaluationDefinition;
        return this.data;
      } else {
        throw messages.createError('missingConnection');
      }
    }
    throw messages.createError('missingTestSpecData');
  }

  /**
   * Write a test specification file in YAML format.
   *
   * @param outputFile The file path where the YAML test spec should be written.
   */
  public async writeTestSpec(outputFile: string): Promise<void> {
    const spec = await this.getTestSpec();

    // by default, add the OOTB metrics to the spec, so generated MD will have it
    spec.testCases.forEach((tc) => (tc.metrics = tc.metrics ?? Array.from(metric)));
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
   * Write AiEvaluationDefinition metadata file.
   *
   * @param outputFile The file path where the metadata file should be written.
   */
  public async writeMetadata(outputFile: string): Promise<void> {
    const xml = buildMetadataXml(await this.getMetadata());
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, xml);
  }
}

// Convert AiEvaluationDefinition metadata XML content to a YAML test spec object.
const convertToSpec = (data: AiEvaluationDefinition): TestSpec => ({
  name: data.name,
  description: data.description,
  subjectType: data.subjectType,
  subjectName: data.subjectName,
  subjectVersion: data.subjectVersion,
  testCases: ensureArray(data.testCase).map((tc) => {
    const expectations = ensureArray(tc.expectation);
    return {
      utterance: tc.inputs.utterance,
      contextVariables: ensureArray(tc.inputs.contextVariable).map((cv) => ({
        name: cv.variableName,
        value: cv.variableValue,
      })),
      ...(tc.inputs.conversationHistory && {
        conversationHistory: ensureArray(tc.inputs.conversationHistory).map((ch) =>
          ch.role === 'agent'
            ? { role: ch.role, message: ch.message, topic: ch.topic }
            : { role: ch.role, message: ch.message }
        ),
      }),
      customEvaluations: expectations
        .filter((e) => 'parameter' in e)
        .map((ce) => ({ name: ce.name, label: ce.label, parameters: ce.parameter })),
      // TODO: remove old names once removed in 258 (topic_sequence_match, action_sequence_match, bot_response_rating)
      expectedTopic: (
        expectations.find(
          (e) => e.name === 'topic_sequence_match' || e.name === 'topic_assertion'
        ) as MetadataExpectation
      )?.expectedValue,
      expectedActions: transformStringToArray(
        (
          expectations.find(
            (e) => e.name === 'action_sequence_match' || e.name === 'actions_assertion'
          ) as MetadataExpectation
        )?.expectedValue
      ),
      expectedOutcome: (
        expectations.find(
          (e) => e.name === 'bot_response_rating' || e.name === 'output_validation'
        ) as MetadataExpectation
      )?.expectedValue,
      metrics: expectations
        .filter((e) => metric.includes(e.name as (typeof metric)[number]))
        .map((e) => e.name as (typeof metric)[number]),
    };
  }),
});

// Convert a YAML test spec object to AiEvaluationDefinition metadata XML content.
const convertToMetadata = (spec: TestSpec): AiEvaluationDefinition => ({
  ...(spec.description && { description: spec.description }),
  name: spec.name,
  subjectName: spec.subjectName,
  subjectType: spec.subjectType,
  ...(spec.subjectVersion && { subjectVersion: spec.subjectVersion }),
  testCase: spec.testCases.map((tc) => ({
    expectation: [
      ...ensureArray(tc.customEvaluations).map((ce) => ({
        name: ce.name,
        label: ce.label,
        parameter: ce.parameters,
      })),
      {
        expectedValue: tc.expectedTopic as string,
        name: 'topic_sequence_match',
      },
      {
        expectedValue: `[${(tc.expectedActions ?? []).map((v) => `'${v}'`).join(',')}]`,
        name: 'action_sequence_match',
      },
      {
        expectedValue: tc.expectedOutcome as string,
        name: 'bot_response_rating',
      },
      ...ensureArray(tc.metrics).map((m) => ({ name: m })),
    ],
    inputs: {
      utterance: tc.utterance,
      contextVariable: tc.contextVariables?.map((cv) => ({ variableName: cv.name, variableValue: cv.value })),
      ...(tc.conversationHistory && {
        conversationHistory: tc.conversationHistory.map((ch, index) =>
          ch.role === 'agent'
            ? { role: ch.role, message: ch.message, topic: ch.topic, index: ch.index ?? index }
            : { role: ch.role, message: ch.message, index: ch.index ?? index }
        ),
      }),
    },
    number: spec.testCases.indexOf(tc) + 1,
  })),
});

function transformStringToArray(str: string | undefined): string[] {
  try {
    if (!str) return [];
    // Remove any whitespace and ensure proper JSON format
    const cleaned = str.replace(/\s+/g, '').replaceAll(/'/g, '"');
    return JSON.parse(cleaned) as string[];
  } catch {
    return [];
  }
}

type AiEvaluationDefinitionXml = {
  AiEvaluationDefinition: AiEvaluationDefinition;
};
const parseAgentTestXml = async (mdPath: string): Promise<AiEvaluationDefinition> => {
  const xml = await readFile(mdPath, 'utf-8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '$',
    isArray: (name) =>
      name === 'testCase' || name === 'expectation' || name === 'contextVariable' || name === 'conversationHistory',
    processEntities: true,
    htmlEntities: true,
  });
  const xmlContent = parser.parse(xml) as AiEvaluationDefinitionXml;
  return xmlContent.AiEvaluationDefinition;
};

const buildMetadataXml = (data: AiEvaluationDefinition): string => {
  const aiEvalXml = {
    AiEvaluationDefinition: {
      $xmlns: 'http://soap.sforce.com/2006/04/metadata',
      ...data,
    },
  };

  const builder = new XMLBuilder({
    format: true,
    attributeNamePrefix: '$',
    indentBy: '    ',
    ignoreAttributes: false,
  });

  const xml = builder.build(aiEvalXml);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
};

/**
 * Validate an NGT test spec before conversion.
 *
 * Throws on the first failure encountered so authors get one clear actionable
 * error at a time. Emits a Lifecycle warning (does not throw) for unknown
 * scorer names — Core's MD validator catches those at deploy time.
 */
export const validateNgtSpec = (spec: NgtTestSpec, ctx: { isMultiAgent: boolean }): void => {
  if (!spec.testCases || spec.testCases.length === 0) {
    throw ngtError('ngtMissingTestCases');
  }

  spec.testCases.forEach((testCase, tcIdx) => {
    if (!testCase.inputs || testCase.inputs.length === 0) {
      throw ngtError('ngtTestCaseMissingInputs', [tcIdx + 1]);
    }
    if (!testCase.scorers || testCase.scorers.length === 0) {
      throw ngtError('ngtTestCaseMissingScorers', [tcIdx + 1]);
    }

    testCase.scorers.forEach((scorer) => {
      if (!isNgtScorerName(scorer.name)) {
        const unknownName = String(scorer.name);
        void Lifecycle.getInstance().emitWarning(
          `Unknown NGT scorer name '${unknownName}'. The deploy will be validated by the server.`
        );
        return;
      }
      const entry = NgtScorerCatalog[scorer.name];
      if (entry.needsExpected && (scorer.expected === undefined || scorer.expected === '')) {
        throw ngtError('ngtScorerMissingExpected', [scorer.name, tcIdx + 1]);
      }
    });

    const hasTaskResolution = testCase.scorers.some((s) => s.name === 'task_resolution');
    if (hasTaskResolution) {
      const anyHistory = testCase.inputs.some(
        (input) => Array.isArray(input.conversationHistory) && input.conversationHistory.length > 0
      );
      if (!anyHistory) {
        throw ngtError('ngtTaskResolutionRequiresConversationHistory', [tcIdx + 1]);
      }
    }

    if (ctx.isMultiAgent) {
      const hasHandoff = testCase.scorers.some(
        (s) => s.name === 'agent_handoff_match' && s.expected !== undefined && s.expected !== ''
      );
      if (!hasHandoff) {
        throw ngtError('ngtMultiAgentMissingHandoff', [tcIdx + 1]);
      }
    }

    testCase.inputs.forEach((input, inputIdx) => {
      const turns = input.conversationHistory;
      if (!turns || turns.length === 0) return;
      const withIndex = turns.filter((t) => t.index !== undefined).length;
      if (withIndex !== 0 && withIndex !== turns.length) {
        throw ngtError('ngtConversationHistoryIndexAllOrNothing', [tcIdx + 1, inputIdx + 1]);
      }
    });
  });
};

const ngtError = (key: string, tokens: Array<string | number> = []): SfError => {
  const message = messages.getMessage(key, tokens);
  return new SfError(message, key);
};

/** Reads `BotDefinition.IsMultiAgent` for the named subject. Conservative default `false` on read failure. */
const fetchIsMultiAgent = async (connection: Connection, subjectName: string): Promise<boolean> => {
  try {
    // @ts-expect-error jsForce types don't model BotDefinition
    const data = (await connection.metadata.read('BotDefinition', subjectName)) as { IsMultiAgent?: boolean } | undefined;
    return Boolean(data?.IsMultiAgent);
  } catch {
    return false;
  }
};

/**
 * Convert a validated `NgtTestSpec` to the `AiTestingDefinition` shape ready for XML serialization.
 *
 * Multi-input fan-out: when a test case has N inputs, emit N `<testCase>` elements sharing the
 * same scorer set. The `<number>` field increments globally across the whole document.
 *
 * Must be called after `validateNgtSpec`.
 */
export const convertToTestingMetadata = (spec: NgtTestSpec): AiTestingDefinition => {
  const testCases: AiTestCase[] = [];
  let counter = 1;
  for (const tc of spec.testCases) {
    const sharedScorers = tc.scorers.map(toScorerXml);
    for (const input of tc.inputs) {
      testCases.push({
        number: counter++,
        inputs: toInputsXml(input),
        scorer: sharedScorers,
      });
    }
  }
  return {
    ...(spec.description && { description: spec.description }),
    name: spec.name,
    subjectName: spec.subjectName,
    subjectType: spec.subjectType,
    ...(spec.subjectVersion && { subjectVersion: spec.subjectVersion }),
    testCase: testCases,
  };
};

const toScorerXml = (scorer: NgtTestCase['scorers'][number]): AiTestCaseScorer => {
  const name = scorer.name as NgtScorerName;
  // Quality scorers (needsExpected:false) and unknown names omit expectedValue.
  const known = isNgtScorerName(name) ? NgtScorerCatalog[name] : undefined;
  const includeExpected = scorer.expected !== undefined && (known?.needsExpected ?? true);
  return includeExpected ? { name, expectedValue: scorer.expected as string } : { name };
};

const toInputsXml = (input: NgtTestCaseInput): AiTestCase['inputs'] => {
  const inputs: { utterance: string; contextVariable?: Array<{ variableName: string; variableValue: string }>; conversationHistory?: AiConversationTurnXml[] } = {
    utterance: input.utterance,
  };
  if (input.contextVariables && input.contextVariables.length > 0) {
    inputs.contextVariable = input.contextVariables.map((cv) => ({
      variableName: cv.name,
      variableValue: cv.value,
    }));
  }
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    inputs.conversationHistory = input.conversationHistory.map((turn, i) =>
      turn.role === 'agent'
        ? { role: turn.role, message: turn.message, topic: turn.topic, index: turn.index ?? i }
        : { role: turn.role, message: turn.message, index: turn.index ?? i }
    );
  }
  return inputs;
};

/** Serialize an `AiTestingDefinition` to source-format XML. Mirrors `buildMetadataXml`. */
export const buildTestingMetadataXml = (data: AiTestingDefinition): string => {
  const wrapped = {
    AiTestingDefinition: {
      $xmlns: 'http://soap.sforce.com/2006/04/metadata',
      ...data,
    },
  };

  const builder = new XMLBuilder({
    format: true,
    attributeNamePrefix: '$',
    indentBy: '    ',
    ignoreAttributes: false,
  });

  const xml = builder.build(wrapped);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
};
