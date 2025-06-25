/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { inspect } from 'node:util';
import * as path from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { Connection, Lifecycle, Logger, Messages, SfError, SfProject, generateApiName } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { Duration } from '@salesforce/kit';
import {
  type AgentCreateConfig,
  type AgentCreateResponse,
  type AgentJobSpec,
  type AgentJobSpecCreateConfig,
  type AgentOptions,
  type BotMetadata,
  type DraftAgentTopicsBody,
  type DraftAgentTopicsResponse,
} from './types.js';
import { MaybeMock } from './maybe-mock';
import { decodeHtmlEntities } from './utils';

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
  // The metadata fields for the agent (Bot)
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
   * Queries BotDefinition for the bot metadata and assigns:
   * 1. this.id
   * 2. this.name
   * 3. this.botMetadata
   */
  public async getBotMetadata(): Promise<BotMetadata> {
    if (!this.botMetadata) {
      const whereClause = this.id ? `Id = '${this.id}'` : `DeveloperName = '${this.name as string}'`;
      const query = `SELECT FIELDS(ALL) FROM BotDefinition WHERE ${whereClause} LIMIT 1`;
      this.botMetadata = await this.options.connection.singleRecordQuery<BotMetadata>(query);
      this.id = this.botMetadata.Id;
      this.name = this.botMetadata.DeveloperName;
    }
    return this.botMetadata;
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
