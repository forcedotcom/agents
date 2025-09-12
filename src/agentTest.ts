/*
 * Copyright 2025, Salesforce, Inc.
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
  TestSpec,
  MetadataExpectation,
} from './types.js';
import { metric, sanitizeFilename } from './utils';

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
   * List the AiEvaluationDefinitions available in the org.
   */
  public static async list(connection: Connection): Promise<AvailableDefinition[]> {
    return connection.metadata.list({ type: 'AiEvaluationDefinition' });
  }

  /**
   * Creates and deploys an AiEvaluationDefinition from a specification file.
   *
   * @param connection - Connection to the org where the agent test will be created.
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
  public static async create(
    connection: Connection,
    apiName: string,
    specFilePath: string,
    options: { outputDir: string; preview?: boolean }
  ): Promise<{ path: string; contents: string; deployResult?: DeployResult }> {
    const agentTestSpec = parse(await readFile(specFilePath, 'utf-8')) as TestSpec;
    const lifecycle = Lifecycle.getInstance();
    await lifecycle.emit(AgentTestCreateLifecycleStages.CreatingLocalMetadata, {});
    const preview = options.preview ?? false;
    // outputDir is overridden if preview is true
    const outputDir = preview ? process.cwd() : options.outputDir;
    const filename = preview
      ? `${apiName}-preview-${new Date().toISOString()}.xml`
      : `${apiName}.aiEvaluationDefinition-meta.xml`;
    const definitionPath = sanitizeFilename(join(outputDir, filename));

    const xml = buildMetadataXml(convertToMetadata(agentTestSpec));
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
        name: 'topic_assertion',
      },
      {
        expectedValue: `[${(tc.expectedActions ?? []).map((v) => `'${v}'`).join(',')}]`,
        name: 'actions_assertion',
      },
      {
        expectedValue: tc.expectedOutcome as string,
        name: 'output_validation',
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
