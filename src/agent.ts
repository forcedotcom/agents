/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { inspect } from 'node:util';
import * as path from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { Connection, Lifecycle, Logger, Messages, SfError, SfProject } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { Duration } from '@salesforce/kit';
import {
  type AgentCreateConfig,
  type AgentCreateResponse,
  type AgentJobSpec,
  type AgentJobSpecCreateConfig,
  type DraftAgentTopicsBody,
  type DraftAgentTopicsResponse,
} from './types.js';
import { MaybeMock } from './maybe-mock';
import { decodeHtmlEntities } from './utils';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

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
 * Class for creating Agents and agent specs.
 */
export class Agent {
  private logger: Logger;
  private maybeMock: MaybeMock;
  private readonly connection: Connection;

  /**
   * Create an Agent instance
   *
   * @param {Connection} connection
   * @param {SfProject} project
   */
  public constructor(connection: Connection, private project: SfProject) {
    this.logger = Logger.childFromRoot(this.constructor.name);
    this.maybeMock = new MaybeMock(connection);
    this.connection = connection;
  }

  /**
   * List all agents in the current project.
   */
  public async list(): Promise<string[]> {
    const projectDirs = this.project.getPackageDirectories();
    const bots: string[] = [];

    for (const pkgDir of projectDirs) {
      const botsPath = path.join(pkgDir.fullPath, 'main', 'default', 'bots');

      try {
        // eslint-disable-next-line no-await-in-loop
        const dirStat = await stat(botsPath);
        if (!dirStat.isDirectory()) {
          this.logger.debug(`${botsPath} is not a directory.`);
        }

        // eslint-disable-next-line no-await-in-loop
        bots.push(...(await readdir(botsPath)));
      } catch (err) {
        if (err instanceof Error) {
          this.logger.debug(`Failed to read bots at ${botsPath} due to: \n${err.message}\n`);
        } else {
          throw err;
        }
      }
    }

    return bots;
  }

  /**
   * Creates an agent from a configuration, optionally saving the agent in an org.
   *
   * @param config a configuration for creating or previewing an agent
   * @returns the agent definition
   */
  public async create(config: AgentCreateConfig): Promise<AgentCreateResponse> {
    const url = '/connect/ai-assist/create-agent';

    // When previewing agent creation just return the response.
    if (!config.saveAgent) {
      this.logger.debug(
        `Previewing agent creation using config: ${inspect(config)} in project: ${this.project.getPath()}`
      );
      await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.Previewing, {});

      const response = await this.maybeMock.request<AgentCreateResponse>('POST', url, config);
      return decodeResponse(response);
    }

    if (!config.agentSettings?.agentName) {
      throw messages.createError('missingAgentName');
    }

    this.logger.debug(`Creating agent using config: ${inspect(config)} in project: ${this.project.getPath()}`);
    await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.Creating, {});
    if (!config.agentSettings.agentApiName) {
      config.agentSettings.agentApiName = generateAgentApiName(config.agentSettings?.agentName);
    }
    const response = await this.maybeMock.request<AgentCreateResponse>('POST', url, config);

    // When saving agent creation we need to retrieve the created metadata.
    if (response.isSuccess) {
      await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.Retrieving, {});
      const defaultPackagePath = this.project.getDefaultPackage().path ?? 'force-app';
      try {
        const cs = await ComponentSetBuilder.build({
          metadata: {
            metadataEntries: [`Agent:${config.agentSettings.agentApiName}`],
            directoryPaths: [defaultPackagePath],
          },
          org: {
            username: this.connection.getUsername() as string,
            exclude: [],
          },
        });
        const retrieve = await cs.retrieve({
          usernameOrConnection: this.connection,
          merge: true,
          format: 'source',
          output: defaultPackagePath,
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
   * @param config The configuration used to generate an agent spec.
   */
  public async createSpec(config: AgentJobSpecCreateConfig): Promise<AgentJobSpec> {
    this.verifyAgentSpecConfig(config);

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

    const response = await this.maybeMock.request<DraftAgentTopicsResponse>('POST', url, body);
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

  // eslint-disable-next-line class-methods-use-this
  private verifyAgentSpecConfig(config: AgentJobSpecCreateConfig): void {
    const { agentType, role, companyName, companyDescription } = config;
    if (!agentType || !role || !companyName || !companyDescription) {
      throw messages.createError('invalidAgentSpecConfig');
    }
  }
}

/**
 * Generate an API name from an agent name. Matches what the UI does.
 */
export const generateAgentApiName = (agentName: string): string => {
  const maxLength = 255;
  let apiName = agentName;
  apiName = apiName.replace(/[\W_]+/g, '_');
  if (apiName.charAt(0).match(/_/i)) {
    apiName = apiName.slice(1);
  }
  apiName = apiName
    .replace(/(^\d+)/, 'X$1')
    .slice(0, maxLength)
    .replace(/_$/, '');
  const logger = Logger.childFromRoot('Agent-GenApiName');
  logger.debug(`Generated Agent API name: [${apiName}] from Agent name: [${agentName}]`);
  return apiName;
};

// Decodes all HTML entities in ai-assist API responses.
const decodeResponse = <T extends object>(response: T): T =>
  JSON.parse(decodeHtmlEntities(JSON.stringify(response))) as T;
