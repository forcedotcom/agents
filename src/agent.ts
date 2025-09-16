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

import { inspect } from 'node:util';
import * as path from 'node:path';
import { stat, readdir, readFile, writeFile } from 'node:fs/promises';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { Connection, Lifecycle, Logger, Messages, SfError, SfProject, generateApiName } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { Duration } from '@salesforce/kit';
import nock from 'nock';
import {
  type AgentCreateConfig,
  type AgentCreateResponse,
  type AgentJson,
  type AgentJobSpec,
  type AgentJobSpecCreateConfig,
  type AgentOptions,
  type BotActivationResponse,
  type BotMetadata,
  type BotVersionMetadata,
  type CreateAfScriptResponse,
  type CreateAgentJsonResponse,
  type DraftAgentTopicsBody,
  type DraftAgentTopicsResponse,
  PublishAgentJsonResponse,
  AfScript,
} from './types.js';
import { MaybeMock } from './maybe-mock';
import { decodeHtmlEntities, findAuthoringBundle } from './utils';

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
 * A client side representation of an agent within an org. Also provides utilities
 * such as creating agents, listing agents, and creating agent specs.
 *
 * **Examples**
 *
 * Create a new instance and get the ID (uses the `Bot` ID):
 *
 * `const id = new Agent({connection, name}).getId();`
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
  // The ID of the agent (Bot)
  private id?: string;
  // The name of the agent (Bot)
  private name?: string;
  // The metadata fields for the agent (Bot and BotVersion)
  private botMetadata?: BotMetadata;

  /**
   * Create an instance of an agent in an org. Must provide a connection to an org
   * and the agent (Bot) API name or ID as part of `AgentOptions`.
   *
   * @param {options} AgentOptions
   */
  public constructor(private options: AgentOptions) {
    if (!options.nameOrId) {
      throw messages.createError('missingAgentNameOrId');
    }

    if (options.nameOrId.startsWith('0Xx') && [15, 18].includes(options.nameOrId.length)) {
      this.id = options.nameOrId;
    } else {
      this.name = options.nameOrId;
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
          frequency: Duration.seconds(1),
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

  /**
   * Creates AF Script using agent job spec data.
   *
   * @param connection The connection to the org
   * @param agentJobSpec The agent specification data
   * @returns Promise<AfScript> The generated AF Script as a string
   * @beta
   */
  public static async createAfScript(connection: Connection, agentJobSpec: AgentJobSpec): Promise<AfScript> {
    const url = '/connect/ai-assist/create-af-script';
    const maybeMock = new MaybeMock(connection);

    getLogger().debug(`Generating AF Script with agent spec data: ${JSON.stringify(agentJobSpec)}`);

    const response = await maybeMock.request<CreateAfScriptResponse>('POST', url, agentJobSpec);
    if (response.isSuccess && response.afScript) {
      return response.afScript;
    } else {
      throw SfError.create({
        name: 'CreateAfScriptError',
        message: response.errorMessage ?? 'unknown',
        data: response,
      });
    }
  }

  /**
   * Creates agent JSON from compiling AF Script on the server.
   *
   * @param connection The connection to the org
   * @param afScript The agent AF Script as a string
   * @returns Promise<string> The generated Agent JSON as a string
   * @beta
   */
  public static async compileAfScript(connection: Connection, afScript: AfScript): Promise<AgentJson> {
    const url = '/einstein/ai-agent/v1.1/authoring/compile';
    const maybeMock = new MaybeMock(connection);

    getLogger().debug(`Generating Agent JSON with AF Script: ${afScript}`);

    const response = await maybeMock.request<CreateAgentJsonResponse>('POST', url, { afScript });
    if (response.isSuccess && response.agentJson) {
      return response.agentJson;
    } else {
      throw SfError.create({
        name: 'CreateAgentJsonError',
        message: response.errorMessage ?? 'unknown',
        data: response,
      });
    }
  }

  /**
   * Publish an AgentJson representation to the org
   *
   * @beta
   * @param {Connection} connection The connection to the org
   * @param {SfProject} project The Salesforce project
   * @param {AgentJson} agentJson The agent JSON with name
   * @returns {Promise<PublishAgentJsonResponse>} The publish response
   */
  public static async publishAgentJson(
    connection: Connection,
    project: SfProject,
    agentJson: AgentJson
  ): Promise<PublishAgentJsonResponse> {
    const maybeMock = new MaybeMock(connection);

    getLogger().debug('Publishing AfScript');

    const url = '/einstein/ai-agent/v1.1/authoring/publish';
    const response = await maybeMock.request<PublishAgentJsonResponse>('POST', url, { agentJson });
    if (response.isSuccess && response.botDeveloperName) {
      // we've published the AgentJson, now we need to:
      // 1. update the AuthoringBundle-meta.xml file with response.BotId
      // 2. retrieve the new Agent metadata that's in the org
      const defaultPackagePath = path.resolve(project.getDefaultPackage().path);

      try {
        // First update the AuthoringBundle file with the new BotId
        // Try to find the authoring bundle directory by recursively searching from the default package path
        const bundleDir = findAuthoringBundle(defaultPackagePath, response.botDeveloperName);

        if (!bundleDir) {
          throw SfError.create({
            name: 'Cannot Find Bundle',
            message: `Cannot find an authoring bundle in ${defaultPackagePath} that matches ${response.botDeveloperName}`,
          });
        }

        // Construct the full file path whether we found the directory or not
        const bundleMetaPath = path.join(bundleDir, `${response.botDeveloperName}.authoring-bundle-meta.xml`);

        const xmlParser = new XMLParser({ ignoreAttributes: false });
        const xmlBuilder = new XMLBuilder({
          ignoreAttributes: false,
          format: true,
          suppressBooleanAttributes: false,
          suppressEmptyNode: false,
        });

        const authoringBundle = xmlParser.parse(await readFile(bundleMetaPath, 'utf-8')) as {
          aiAuthoringBundle: { Target: string };
        }; // all the typing we'll need
        authoringBundle.aiAuthoringBundle.Target = response.botDeveloperName;

        await writeFile(bundleMetaPath, xmlBuilder.build(authoringBundle));

        // Now retrieve the updated agent metadata
        const cs = await ComponentSetBuilder.build({
          sourcepath: [
            path.resolve(path.join(defaultPackagePath, 'main', 'default', 'bots', response.botDeveloperName)),
          ],
          org: {
            username: connection.getUsername() as string,
            exclude: [],
          },
        });

        // will unset mocks so that retrieve will work
        nock.restore();
        nock.cleanAll();
        nock.enableNetConnect();

        const retrieve = await cs.retrieve({
          usernameOrConnection: connection,
          merge: true,
          format: 'source',
          rootTypesWithDependencies: ['Bot'],
          output: path.resolve(project.getPath(), defaultPackagePath),
        });

        const retrieveResult = await retrieve.pollStatus();

        if (!retrieveResult.response?.success) {
          const errMessages = retrieveResult.response?.messages?.toString() ?? 'unknown';
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

      return response;
    } else {
      throw SfError.create({
        name: 'CreateAgentJsonError',
        message: response.errorMessage ?? 'unknown',
        data: response,
      });
    }
  }

  /**
   * Returns the ID for this agent.
   *
   * @returns The ID of the agent (The `Bot` ID).
   */
  public async getId(): Promise<string> {
    if (!this.id) {
      await this.getBotMetadata();
    }
    return this.id!; // getBotMetadata() ensures this.id is not undefined
  }

  /**
   * Queries BotDefinition and BotVersions (limited to 10) for the bot metadata and assigns:
   * 1. this.id
   * 2. this.name
   * 3. this.botMetadata
   * 4. this.botVersionMetadata
   */
  public async getBotMetadata(): Promise<BotMetadata> {
    if (!this.botMetadata) {
      const whereClause = this.id ? `Id = '${this.id}'` : `DeveloperName = '${this.name as string}'`;
      const query = `SELECT FIELDS(ALL), (SELECT FIELDS(ALL) FROM BotVersions LIMIT 10) FROM BotDefinition WHERE ${whereClause} LIMIT 1`;
      this.botMetadata = await this.options.connection.singleRecordQuery<BotMetadata>(query);
      this.id = this.botMetadata.Id;
      this.name = this.botMetadata.DeveloperName;
    }
    return this.botMetadata;
  }

  /**
   * Returns the latest bot version metadata.
   *
   * @returns the latest bot version metadata
   */
  public async getLatestBotVersionMetadata(): Promise<BotVersionMetadata> {
    if (!this.botMetadata) {
      this.botMetadata = await this.getBotMetadata();
    }
    const botVersions = this.botMetadata.BotVersions.records;
    return botVersions[botVersions.length - 1];
  }

  /**
   * Activates the agent.
   *
   * @returns void
   */
  public async activate(): Promise<void> {
    return this.setAgentStatus('Active');
  }

  /**
   * Deactivates the agent.
   *
   * @returns void
   */
  public async deactivate(): Promise<void> {
    return this.setAgentStatus('Inactive');
  }

  private async setAgentStatus(desiredState: 'Active' | 'Inactive'): Promise<void> {
    const botMetadata = await this.getBotMetadata();
    const botVersionMetadata = await this.getLatestBotVersionMetadata();

    if (botMetadata.IsDeleted) {
      throw messages.createError('agentIsDeleted', [botMetadata.DeveloperName]);
    }

    if (botVersionMetadata.Status === desiredState) {
      getLogger().debug(`Agent ${botMetadata.DeveloperName} is already ${desiredState}. Nothing to do.`);
      return;
    }

    const url = `/connect/bot-versions/${botVersionMetadata.Id}/activation`;
    const maybeMock = new MaybeMock(this.options.connection);
    const response = await maybeMock.request<BotActivationResponse>('POST', url, { status: desiredState });
    if (response.success) {
      this.botMetadata!.BotVersions.records[0].Status = response.isActivated ? 'Active' : 'Inactive';
    } else {
      throw messages.createError('agentActivationError', [response.messages?.toString() ?? 'unknown']);
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
const decodeResponse = <T extends object>(response: T): T =>
  JSON.parse(decodeHtmlEntities(JSON.stringify(response))) as T;
