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

import * as path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { Connection, Logger, Messages, SfError, SfProject } from '@salesforce/core';
import { ComponentSet, ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { MaybeMock } from '../maybe-mock';
import { type AgentJson, type PublishAgent, type PublishAgentJsonResponse } from '../types';
import { findAuthoringBundle } from '../utils';
import { managerFor } from '../connectionManager';

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
export class ScriptAgentPublisher {
  private readonly connection: Connection;
  private project: SfProject;
  private readonly agentJson: AgentJson;
  private readonly developerName: string;
  private readonly aabName?: string;
  private readonly bundleMetaPath: string;
  private bundleDir: string;
  private readonly skipRetrieve: boolean;
  private readonly API_URL: string;
  private readonly API_HEADERS = {
    'x-client-name': 'afdx',
    'content-type': 'application/json',
  };

  /**
   * Creates a new AgentPublisher instance.
   *
   * @param connection The caller-supplied Connection. Used as the lookup key into the
   * ConnectionManager cache (managerFor()); never used directly for SFAP or org API calls.
   * @param project The Salesforce project
   * @param agentJson The compiled AgentJson to publish
   * @param skipMetadataRetrieve Whether to skip retrieving the agent metadata from the org
   * @param aabName The authoring bundle API name the caller asked to publish (e.g. 'myAgent_2').
   * Used to locate the bundle directory to deploy. This can differ from the agent's developerName
   * for versioned bundles, where the directory carries a version suffix but the script's
   * config.developer_name (and thus agentJson.globalConfiguration.developerName) is the base name.
   * When omitted, the bundle directory is resolved from developerName for backward compatibility.
   */
  public constructor(
    connection: Connection,
    project: SfProject,
    agentJson: AgentJson,
    skipMetadataRetrieve: boolean = false,
    aabName?: string
  ) {
    this.connection = connection;
    this.project = project;
    this.agentJson = agentJson;
    this.skipRetrieve = skipMetadataRetrieve;
    this.aabName = aabName;
    this.API_URL = 'https://api.salesforce.com/einstein/ai-agent/v1.1/authoring/agents';

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
    getLogger().debug('Publishing Agent');

    const manager = await managerFor(this.connection);

    const body = {
      agentDefinition: this.agentJson,
      instanceConfig: {
        endpoint: manager.getStandardConnection().instanceUrl,
      },
    };

    const botId = await this.getPublishedBotId(this.developerName);
    // if we've found a botId in the org, then this agent has already been published before => ai-agent/v1.1/authoring/agents/<id>/versions
    // if we didn't find an Id in the org, then we're publishing for the first time         => ai-agent/v1.1/authoring/agents
    const url = botId ? `${this.API_URL}/${botId}/versions` : this.API_URL;
    const maybeMock = new MaybeMock(manager.getJwtConnection());
    const response = await maybeMock.request<PublishAgentJsonResponse>('POST', url, body, this.API_HEADERS);

    if (response.botId && response.botVersionId) {
      // we've published the AgentJson, now we need to:
      // 1. retrieve the new Agent metadata that's in the org
      // 2. deploy the AuthoringBundle's -meta.xml file with correct target attribute
      const botVersionName = await this.getVersionDeveloperName(response.botVersionId);
      if (!this.skipRetrieve) {
        await this.retrieveAgentMetadata(botVersionName);
      }
      await this.deployAuthoringBundle(botVersionName);

      return { ...response, developerName: this.developerName };
    } else {
      throw SfError.create({
        name: 'CreateAgentJsonError',
        message: response.errorMessage ?? 'unknown',
        data: response,
      });
    }
  }

  /**
   * Validates and extracts the developer name from the agent configuration,
   * and locates the corresponding authoring bundle directory and metadata file.
   *
   * The bundle directory is resolved from the caller-supplied aabName (the API name being
   * published) rather than developerName, because for versioned bundles the two differ: the
   * directory carries a version suffix (e.g. 'myAgent_2') while the agent's developerName is
   * the base name from the script's config.developer_name (e.g. 'myAgent'). Resolving from
   * developerName would deploy the wrong (unversioned) bundle. When aabName is not provided,
   * the directory is resolved from developerName to preserve prior behavior.
   *
   * @returns An object containing:
   * - developerName: The agent's developer name (used for org queries and the deploy target)
   * - bundleDir: The path to the authoring bundle directory
   * - bundleMetaPath: The full path to the bundle-meta.xml file
   *
   * @throws SfError if the authoring bundle directory or metadata file cannot be found
   */
  private validateDeveloperName(): { developerName: string; bundleDir: string; bundleMetaPath: string } {
    const developerName = this.agentJson.globalConfiguration.developerName;
    // The bundle directory (and its meta file) are named after the API name that was published,
    // which is the version-suffixed aabName when publishing a versioned bundle.
    const bundleName = this.aabName ?? developerName;
    const defaultPackagePath = path.resolve(this.project.getDefaultPackage().path);

    // Try to find the authoring bundle directory by recursively searching from the default package path
    const bundleDir = findAuthoringBundle(defaultPackagePath, bundleName);

    if (!bundleDir) {
      throw SfError.create({
        name: 'CannotFindBundle',
        message: `Cannot find an authoring bundle in ${defaultPackagePath} that matches ${bundleName}`,
      });
    }

    const bundleMetaPath = path.join(bundleDir, `${bundleName}.bundle-meta.xml`);

    if (!existsSync(bundleMetaPath)) {
      throw SfError.create({
        name: 'CannotFindBundle',
        message: `Cannot find a bundle-meta.xml file in ${bundleDir} that matches ${bundleName}`,
      });
    }
    return { developerName, bundleDir, bundleMetaPath };
  }

  /**
   * Retrieve the agent metadata from the org after publishing
   *
   * @param botVersionName The bot version name
   */
  private async retrieveAgentMetadata(botVersionName: string): Promise<void> {
    const standardConn = (await managerFor(this.connection)).getStandardConnection();
    const defaultPackagePath = path.resolve(this.project.getDefaultPackage().path);

    const genAiPluginAndFunctions = this.agentJson.agentVersion.nodes.flatMap((n) => [
      `GenAiPlugin:${n.developerName}`,
      ...n.tools.map((t) => `GenAiFunction:${t.name}`),
    ]);

    const cs = await ComponentSetBuilder.build({
      metadata: {
        metadataEntries: [
          `Bot:${this.developerName}`,
          ...genAiPluginAndFunctions,
          `Agent:${this.developerName}_${botVersionName}`,
        ],
        directoryPaths: [defaultPackagePath],
      },
      org: {
        username: standardConn.getUsername()!,
        exclude: [],
      },
    });
    const retrieve = await cs.retrieve({
      usernameOrConnection: standardConn,
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
   * Deploys the authoring bundle to the Salesforce org after setting the correct target attribute.
   * The target attribute is required for deployment but should not remain in the
   * local source files after deployment.
   *
   * @throws SfError if the deployment fails or if there are component deployment errors
   * @param botVersionName
   */
  private async deployAuthoringBundle(botVersionName: string): Promise<void> {
    // 1. add the target to the local authoring bundle meta.xml file
    // 2. deploy the authoring bundle to the org
    // 3. remove the target from the localauthoring bundle meta.xml file

    // 1. add the target to the local authoring bundle meta.xml file
    const xmlParser = new XMLParser({ ignoreAttributes: false });
    const authoringBundle = xmlParser.parse(await readFile(this.bundleMetaPath, 'utf-8')) as {
      AiAuthoringBundle: { target?: string };
    };
    const target = `${this.developerName}.${botVersionName}`;
    authoringBundle.AiAuthoringBundle.target = target;
    getLogger().debug(`Setting target to ${target} in ${this.bundleMetaPath}`);
    const xmlBuilder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressBooleanAttributes: false,
      suppressEmptyNode: false,
    });
    await writeFile(this.bundleMetaPath, xmlBuilder.build(authoringBundle));

    // 2. attempt to deploy the authoring bundle to the org
    const standardConn = (await managerFor(this.connection)).getStandardConnection();
    const deploy = await ComponentSet.fromSource(this.bundleDir).deploy({
      usernameOrConnection: standardConn,
    });
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
   * Returns the ID for the published bot.
   *
   * @param agentApiName The agent API name
   * @returns The ID for the published bot
   */
  private async getPublishedBotId(agentApiName: string): Promise<string | undefined> {
    try {
      const standardConn = (await managerFor(this.connection)).getStandardConnection();
      const queryResult = await standardConn.singleRecordQuery<{ Id: string }>(
        `SELECT Id FROM BotDefinition WHERE DeveloperName='${agentApiName}'`
      );
      getLogger().debug(`Agent with developer name ${agentApiName} and id ${queryResult.Id} is already published.`);
      return queryResult.Id;
    } catch (error) {
      getLogger().debug(`Error reading agent metadata: ${JSON.stringify(error)}`);
      return undefined;
    }
  }

  /**
   * Returns the developerName of the given bot version ID.
   *
   * @param botVersionId The Id of the bot version
   * @returns The developer name of the bot version
   */
  private async getVersionDeveloperName(botVersionId: string): Promise<string> {
    try {
      const standardConn = (await managerFor(this.connection)).getStandardConnection();
      const queryResult = await standardConn.singleRecordQuery<{ DeveloperName: string }>(
        `SELECT DeveloperName FROM BotVersion WHERE Id='${botVersionId}'`
      );
      getLogger().debug(`Bot version with id ${botVersionId} is ${queryResult.DeveloperName}.`);
      return queryResult.DeveloperName;
    } catch (error) {
      const err = messages.createError('findBotVersionError', [botVersionId]);
      err.actions = [messages.getMessage('authoringBundleDeploymentErrorActions')];
      throw err;
    }
  }
}
