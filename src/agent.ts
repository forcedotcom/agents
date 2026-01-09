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

import { inspect } from 'node:util';
import * as path from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import {
  Connection,
  Lifecycle,
  Logger,
  Messages,
  SfError,
  SfProject,
  generateApiName,
  AuthInfo,
} from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { Duration } from '@salesforce/kit';
import {
  type AgentCreateConfig,
  type AgentCreateResponse,
  type AgentJobSpec,
  type AgentJobSpecCreateConfig,
  type BotMetadata,
  type DraftAgentTopicsBody,
  type DraftAgentTopicsResponse,
  ProductionAgentOptions,
  PreviewableAgent,
  ScriptAgentOptions,
  AgentSource,
} from './types';
import { MaybeMock } from './maybe-mock';
import { decodeHtmlEntities, findLocalAgents, useNamedUserJwt } from './utils';
import { ScriptAgent } from './agents/scriptAgent';
import { ProductionAgent } from './agents/productionAgent';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

let logger: Logger;
const getLogger = (): Logger => {
  if (!logger) {
    logger = Logger.childFromRoot('Agent');
  }
  return logger;
};

/**
 * Events emitted during Agent.create() for consumers to listen to and keep track of progress
 *
 * @type {{Creating: string, Previewing: string, Retrieving: string}}
 */
export const AgentCreateLifecycleStages = {
  Creating: 'creatingAgent',
  Previewing: 'previewingAgent',
  Retrieving: 'retrievingAgent',
};

/**
 * A client side representation of an agent. Also provides utilities
 * such as creating agents, listing agents, and creating agent specs.
 *
 * **Examples**
 *
 * Create a new instance and get the ID (uses the `Bot` ID):
 *
 * `const id = await Agent.init({connection, project, apiNameOrId: 'myBot' }).getId();`
 *
 * Create a new instance of an agent script based agent
 *
 * const agent = await Agent.init({connection, project, aabDirectory: 'force-app/main/default/aiAuthoringBundles/myBot' });
 *
 * Start a preview session
 *
 * const agent = await Agent.init({connection, project, aabDirectory: 'force-app/main/default/aiAuthoringBundles/myBot' });
 * await agent.preview.start();
 * await agent.preview.send('hi there');
 *
 * Create a new agent in the org:
 *
 * `const myAgent = await Agent.create(connection, project, options);`
 *
 * List all agents in the local project:
 *
 * `const agentList = await Agent.list(project);`
 */
export class Agent {
  // Overload signatures for type inference
  public static async init(options: ScriptAgentOptions): Promise<ScriptAgent>;
  public static async init(options: ProductionAgentOptions): Promise<ProductionAgent>;
  // Implementation
  public static async init(
    options: ProductionAgentOptions | ScriptAgentOptions
  ): Promise<ScriptAgent | ProductionAgent> {
    const username = options.connection.getUsername();

    // Create a fresh connection instance for agent operations
    // This ensures we don't modify the original connection passed in
    // The original connection remains unchanged and can be used for other operations, mid agent-operation
    const authInfo = await AuthInfo.create({ username });
    const isolatedConnection = await Connection.create({ authInfo });

    // Upgrade the isolated connection with JWT
    const jwtConnection = await useNamedUserJwt(isolatedConnection);

    // Type guard: check if it's ScriptAgentOptions by looking for 'aabDirectory'
    if ('aabDirectory' in options) {
      // TypeScript now knows this is ScriptAgentOptions
      return new ScriptAgent({ ...options, connection: jwtConnection });
    } else {
      // TypeScript now knows this is ProductionAgentOptions
      const agent = new ProductionAgent({ ...options, connection: jwtConnection });
      await agent.getBotMetadata();
      return agent;
    }
  }

  /**
   * List all agents in the current project.
   *
   * @param project a `SfProject` for a local DX project.
   */
  public static async list(project: SfProject): Promise<string[]> {
    const projectDirs = project.getPackageDirectories();
    const bots: string[] = [];

    const collectBots = async (botPath: string): Promise<void> => {
      try {
        const dirStat = await stat(botPath);
        if (!dirStat.isDirectory()) {
          return;
        }

        bots.push(...(await readdir(botPath)));
      } catch (_err) {
        // eslint-disable-next-line no-unused-vars
      }
    };

    for (const pkgDir of projectDirs) {
      // eslint-disable-next-line no-await-in-loop
      await collectBots(path.join(pkgDir.fullPath, 'bots'));
      // eslint-disable-next-line no-await-in-loop
      await collectBots(path.join(pkgDir.fullPath, 'main', 'default', 'bots'));
    }

    return bots;
  }

  /**
   * Lists all agents in the org.
   *
   * @param connection a `Connection` to an org.
   * @returns the list of agents
   */
  public static async listRemote(connection: Connection): Promise<BotMetadata[]> {
    const agentsQuery = await connection.query<BotMetadata>(
      'SELECT FIELDS(ALL), (SELECT FIELDS(ALL) FROM BotVersions LIMIT 10) FROM BotDefinition LIMIT 200'
    );
    return agentsQuery.records;
  }

  /**
   * Lists all agents available for preview, combining agents from the org and local script files.
   *
   * @param connection a `Connection` to an org.
   * @param project a `SfProject` for a local DX project.
   * @returns the list of previewable agents with their source (org or script)
   */
  public static async listPreviewable(connection: Connection, project: SfProject): Promise<PreviewableAgent[]> {
    const results = new Array<PreviewableAgent>();

    const orgAgents = await this.listRemote(connection);
    for (const agent of orgAgents) {
      const previewableAgent: PreviewableAgent = {
        name: agent.MasterLabel,
        source: AgentSource.PUBLISHED,
        id: agent.Id,
        developerName: agent.DeveloperName,
        label: agent.MasterLabel,
      };
      results.push(previewableAgent);
    }

    // Get local script agents
    const projectDirs = project.getPackageDirectories();
    const localAgentPaths = new Set<string>();

    for (const pkgDir of projectDirs) {
      // Search in typical locations for aiAuthoringBundles
      const searchPaths = [
        path.join(pkgDir.fullPath, 'aiAuthoringBundles'),
        path.join(pkgDir.fullPath, 'main', 'default', 'aiAuthoringBundles'),
      ];

      for (const searchPath of searchPaths) {
        const agentFiles = findLocalAgents(searchPath);
        for (const agentFile of agentFiles) {
          // Extract the directory path (parent of .agent file)
          const agentDir = path.dirname(agentFile);
          const agentName = path.basename(agentDir);
          const normalizedPath = path.resolve(agentDir);

          // Avoid duplicates
          if (!localAgentPaths.has(normalizedPath)) {
            localAgentPaths.add(normalizedPath);
            const previewableAgent: PreviewableAgent = {
              name: agentName,
              source: AgentSource.SCRIPT,
              aabDirectory: normalizedPath,
            };
            results.push(previewableAgent);
          }
        }
      }
    }

    return results;
  }

  /**
   * Creates an agent from a configuration, optionally saving the agent in an org.
   *
   * @param connection a `Connection` to an org.
   * @param project a `SfProject` for a local DX project.
   * @param config a configuration for creating or previewing an agent.
   * @returns the agent definition
   */
  public static async create(
    connection: Connection,
    project: SfProject,
    config: AgentCreateConfig
  ): Promise<AgentCreateResponse> {
    const url = '/connect/ai-assist/create-agent';
    const maybeMock = new MaybeMock(connection);

    // When previewing agent creation just return the response.
    if (!config.saveAgent) {
      getLogger().debug(`Previewing agent creation using config: ${inspect(config)} in project: ${project.getPath()}`);
      await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.Previewing, {});

      const response = await maybeMock.request<AgentCreateResponse>('POST', url, config);
      return decodeResponse(response);
    }

    if (!config.agentSettings?.agentName) {
      throw messages.createError('missingAgentName');
    }

    getLogger().debug(`Creating agent using config: ${inspect(config)} in project: ${project.getPath()}`);
    await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.Creating, {});
    if (!config.agentSettings.agentApiName) {
      config.agentSettings.agentApiName = generateApiName(config.agentSettings?.agentName);
    }
    const response = await maybeMock.request<AgentCreateResponse>('POST', url, config);

    // When saving agent creation we need to retrieve the created metadata.
    if (response.isSuccess) {
      await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.Retrieving, {});
      const defaultPackagePath = project.getDefaultPackage().path ?? 'force-app';
      try {
        const cs = await ComponentSetBuilder.build({
          metadata: {
            metadataEntries: [`Agent:${config.agentSettings.agentApiName}`],
            directoryPaths: [defaultPackagePath],
          },
          org: {
            username: connection.getUsername() as string,
            exclude: [],
          },
        });
        const retrieve = await cs.retrieve({
          usernameOrConnection: connection,
          merge: true,
          format: 'source',
          output: path.resolve(project.getPath(), defaultPackagePath),
        });
        const retrieveResult = await retrieve.pollStatus({
          frequency: Duration.milliseconds(200),
          timeout: Duration.minutes(5),
        });
        if (!retrieveResult.response.success) {
          const errMessages = retrieveResult.response.messages?.toString() ?? 'unknown';
          const error = messages.createError('agentRetrievalError', [errMessages]);
          error.actions = [messages.getMessage('agentRetrievalErrorActions')];
          throw error;
        }
      } catch (err) {
        const error = SfError.wrap(err);
        if (error.name === 'AgentRetrievalError') {
          throw error;
        }
        throw SfError.create({
          name: 'AgentRetrievalError',
          message: messages.getMessage('agentRetrievalError', [error.message]),
          cause: error,
          actions: [messages.getMessage('agentRetrievalErrorActions')],
        });
      }
    }

    return decodeResponse(response);
  }

  /**
   * Create an agent spec from provided data.
   *
   * @param connection a `Connection` to an org.
   * @param config The configuration used to generate an agent spec.
   * @returns the agent job spec
   */
  public static async createSpec(connection: Connection, config: AgentJobSpecCreateConfig): Promise<AgentJobSpec> {
    const maybeMock = new MaybeMock(connection);
    verifyAgentSpecConfig(config);

    const url = '/connect/ai-assist/draft-agent-topics';

    const body: DraftAgentTopicsBody = {
      agentType: config.agentType,
      generationInfo: {
        defaultInfo: {
          role: config.role,
          companyName: config.companyName,
          companyDescription: config.companyDescription,
        },
      },
      generationSettings: {
        maxNumOfTopics: config.maxNumOfTopics ?? 10,
      },
    };
    if (config.companyWebsite) {
      body.generationInfo.defaultInfo.companyWebsite = config.companyWebsite;
    }
    if (config.promptTemplateName) {
      body.generationInfo.customizedInfo = { promptTemplateName: config.promptTemplateName };
      if (config.groundingContext) {
        body.generationInfo.customizedInfo.groundingContext = config.groundingContext;
      }
    }

    const response = await maybeMock.request<DraftAgentTopicsResponse>('POST', url, body);
    const htmlDecodedResponse = decodeResponse<DraftAgentTopicsResponse>(response);

    if (htmlDecodedResponse.isSuccess) {
      return { ...config, topics: htmlDecodedResponse.topicDrafts };
    } else {
      throw SfError.create({
        name: 'AgentJobSpecCreateError',
        message: htmlDecodedResponse.errorMessage ?? 'unknown',
        data: htmlDecodedResponse,
      });
    }
  }
}

// private function used by Agent.createSpec()
const verifyAgentSpecConfig = (config: AgentJobSpecCreateConfig): void => {
  const { agentType, role, companyName, companyDescription } = config;
  if (!agentType || !role || !companyName || !companyDescription) {
    throw messages.createError('invalidAgentSpecConfig');
  }
};

// Decodes all HTML entities in ai-assist API responses.
// Recursively decodes HTML entities in all string values (not keys) throughout the object structure.
export const decodeResponse = <T>(response: T): T => {
  if (response === null || response === undefined) {
    return response;
  }

  // Handle arrays
  if (Array.isArray(response)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return response.map((item) => decodeResponse(item)) as T;
  }

  // Handle primitive values (strings, numbers, booleans, etc.)
  if (typeof response !== 'object') {
    if (typeof response === 'string') {
      return decodeHtmlEntities(response) as unknown as T;
    }
    return response;
  }

  // Handle objects - only decode values, preserve keys
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(response)) {
    // Recursively decode the value, preserving the key as-is
    decoded[key] = decodeResponse(value);
  }
  return decoded as T;
};
