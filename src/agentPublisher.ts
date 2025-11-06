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

import * as path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { Connection, Logger, Messages, SfError, SfProject } from '@salesforce/core';
import { ComponentSet, ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import {
  type AgentJson,
  type PublishAgentJsonResponse,
  type PublishAgent,
} from './types.js';
import { findAuthoringBundle, useNamedUserJwt } from './utils';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agentPublisher');

let logger: Logger;
const getLogger = (): Logger => {
  if (!logger) {
    logger = Logger.childFromRoot('AgentPublisher');
  }
  return logger;
};

/**
 * Service class responsible for publishing agents to Salesforce orgs
 */
export class AgentPublisher {
  private connection: Connection;
  private project: SfProject;
  private agentJson: AgentJson;
  private developerName: string;
  private bundleMetaPath: string;
  private bundleDir: string;

  // API configuration constants
  private API_URL = 'https://test.api.salesforce.com/einstein/ai-agent/v1.1/authoring/agents';
  private readonly API_HEADERS = {
    'x-client-name': 'afdx',
    'content-type': 'application/json',
  };
  private readonly BOT_VERSION_DELIMITER: string = '.';

  /**
   * Creates a new AgentPublisher instance
   *
   * @param connection The connection to the Salesforce org
   * @param project The Salesforce project
   */
  public constructor(connection: Connection, project: SfProject, agentJson: AgentJson) {
    this.connection = connection;
    this.project = project;
    this.agentJson = agentJson;

    // Validate and get developer name and bundle directory
    const validationResult = this.validateDeveloperName();
    this.developerName = validationResult.developerName;
    this.bundleMetaPath = validationResult.bundleMetaPath;
    this.bundleDir = validationResult.bundleDir;
  }


  /**
   * Publish an AgentJson representation to the org
   *
   * @returns Promise<PublishAgent> The publish response
   */
  public async publishAgentJson(): Promise<PublishAgent> {
    const botId = await this.getPublishedBotId(this.developerName);
    getLogger().debug('botId', botId);

    // store the access token so we can restore it afterwards
    const accessToken = this.connection.accessToken;
    // Ensure we use the correct connection for this API call
    const orgJwtConnection = await useNamedUserJwt(this.connection);

    getLogger().debug('Publishing Agent');

    // HACK for testing: use a known valid AgentJson
    // TODO: remove this once we have a real AgentJson
    const validAgentJson = JSON.parse(
      readFileSync('/Users/esteban.romero/cli/afdx-pro-code-testdrive/test/mocks/validAgentJSON.json', 'utf-8')
    ) as AgentJson;
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string
    getLogger().debug(`Error reading agent metadata: ${validAgentJson}`);
    // this.agentJson = validAgentJson;

    const body = JSON.stringify({
      'agentDefinition': this.agentJson,
      'instanceConfig': {
        'endpoint': this.connection.instanceUrl,
      }
    });
    // await this.deployAuthoringBundle('0X9xx00000000HmCAI');
    try {
      const response = await orgJwtConnection.request<PublishAgentJsonResponse>({
        method: 'POST',
        url: botId ? `${this.API_URL}/${botId}/versions` : this.API_URL,
        headers: this.API_HEADERS,
        body,
      }, { retry: { maxRetries: 3 } });
      this.connection.accessToken = accessToken;
      // eslint-disable-next-line no-console
      console.log('response', response);

      if (response.botId && response.botVersionId) {
        // we've published the AgentJson, now we need to:
        // 1. retrieve the new Agent metadata that's in the org
        await this.retrieveAgentMetadata();
        // 2. update the AuthoringBundle's -meta.xml file with response.BotId
        await this.deployAuthoringBundle(response.botVersionId);

        return { ...response, developerName: this.developerName };
      } else {
        throw SfError.create({
          name: 'CreateAgentJsonError',
          message: response.errorMessage ?? 'unknown',
          data: response,
        });
      }

    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      getLogger().debug(`Error publishing agent: ${error}`);
      throw SfError.wrap(error);
    }
  }

  private validateDeveloperName(): { developerName: string; bundleDir: string; bundleMetaPath: string } {
    const developerName = this.agentJson.globalConfiguration.developerName.replace(/_v\d$/, '');
    const defaultPackagePath = path.resolve(this.project.getDefaultPackage().path);

    // Try to find the authoring bundle directory by recursively searching from the default package path
    const bundleDir = findAuthoringBundle(defaultPackagePath, developerName);

    if (!bundleDir) {
      throw SfError.create({
        name: 'Cannot Find Bundle',
        message: `Cannot find an authoring bundle in ${defaultPackagePath} that matches ${developerName}`,
      });
    }

    const bundleMetaPath = path.join(bundleDir, `${developerName}.bundle-meta.xml`);

    if (!existsSync(bundleMetaPath)) {
      throw SfError.create({
        name: 'Cannot Find Bundle',
        message: `Cannot find a bundle-meta.xml file in ${bundleDir} that matches ${this.developerName}`,
      });
    }
    return { developerName, bundleDir, bundleMetaPath };
  }

  /**
   * Update the authoring bundle meta.xml file with the new bot ID
   *
   * @param developerName The developer name of the agent
   * @param botId The bot ID to set in the authoring bundle
   */
  private async deployAuthoringBundle(botVersionId: string): Promise<void> {
    // 1. add the target to the local authoring bundle meta.xml file
    // 2. deploy the authoring bundle to the org
    // 3. remove the target from the localauthoring bundle meta.xml file
    
    // 1. add the target to the local authoring bundle meta.xml file
    const xmlParser = new XMLParser({ ignoreAttributes: false });
    const authoringBundle = xmlParser.parse(await readFile(this.bundleMetaPath, 'utf-8')) as {
      AiAuthoringBundle: { target?: string };
    };

    authoringBundle.AiAuthoringBundle.target = this.developerName + this.BOT_VERSION_DELIMITER + await this.getBotVersion(botVersionId);
    const xmlBuilder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressBooleanAttributes: false,
      suppressEmptyNode: false,
    });
    await writeFile(this.bundleMetaPath, xmlBuilder.build(authoringBundle));

    // 2. attempt to deploy the authoring bundle to the org
    const deploy = await ComponentSet.fromSource(this.bundleDir)
      .deploy({ usernameOrConnection: this.connection.getUsername() as string });

    const deployResult = await deploy.pollStatus();

    
    // 3.remove the target from the local authoring bundle meta.xml file
    delete authoringBundle.AiAuthoringBundle.target;
    await writeFile(this.bundleMetaPath, xmlBuilder.build(authoringBundle));

    if (!deployResult.response?.success) {
      const componentFailures = deployResult.response.details?.componentFailures;
      let errMessages = 'unknown';
  
      if (componentFailures) {
        const failures = Array.isArray(componentFailures) ? componentFailures : [componentFailures];
        errMessages = failures[0].problem ?? 'unknown';
      }
      const error = messages.createError('authoringBundleDeploymentError', [errMessages]);
      error.actions = [messages.getMessage('authoringBundleDeploymentErrorActions')];
      throw error;
    }
  }
  
  /**
   * Retrieve the agent metadata from the org after publishing
   *
   * @param developerName The developer name of the agent
   * @param originalConnection The original connection to use for retrieval
   */
  private async retrieveAgentMetadata(): Promise<void> {
    const defaultPackagePath = path.resolve(this.project.getDefaultPackage().path);

    const cs = await ComponentSetBuilder.build({
      metadata: {
        metadataEntries: [`Agent:${this.developerName}`],
        directoryPaths: [defaultPackagePath],
      },
      org: {
        username: this.connection.getUsername() as string,
        exclude: [],
      },
    });
    const retrieve = await cs.retrieve({
      usernameOrConnection: this.connection,
      rootTypesWithDependencies: ['Bot'],
      merge: true,
      format: 'source',
      output: path.resolve(this.project.getPath(), defaultPackagePath),
    });

    const retrieveResult = await retrieve.pollStatus();

    if (!retrieveResult.response?.success) {
      const errMessages = retrieveResult.response?.messages?.toString() ?? 'unknown';
      const error = messages.createError('agentRetrievalError', [errMessages]);
      error.actions = [messages.getMessage('agentRetrievalErrorActions')];
      throw error;
    }
  }

  /**
   * Returns the ID for the published bot.
   *
   * @param agentApiName The agent API name
   * @returns The ID for the published bot
   */
  private async getPublishedBotId(agentApiName: string): Promise<string | undefined> {
    try {
      const queryResult = await this.connection.singleRecordQuery<{ Id: string }>(
        `SELECT Id FROM BotDefinition WHERE DeveloperName='${agentApiName}'`
      );
      getLogger().debug(`Agent with developer name ${agentApiName} and id ${queryResult.Id} is already published.`);
      return queryResult.Id;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      getLogger().debug(`Error reading agent metadata: ${error}`);
      return undefined;
    }
  }

  /**
   * Returns the ID for the published bot.
   *
   * @param agentApiName The agent API name
   * @returns The ID for the published bot
   */
  private async getBotVersion(botVersionId: string): Promise<string> {
    try {
      const queryResult = await this.connection.singleRecordQuery<{ DeveloperName: string }>(
        `SELECT DeveloperName FROM BotVersion WHERE Id='${botVersionId}'`
      );
      getLogger().debug(`Bot version with id ${botVersionId} is ${queryResult.DeveloperName}.`);
      // eslint-disable-next-line no-console
      console.log('version: ', queryResult.DeveloperName);
      return queryResult.DeveloperName;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      const err = messages.createError('findBotVersionError', [botVersionId]);
      err.actions = [messages.getMessage('agentRetrievalErrorActions')];
      throw err;
    }
  }
}
