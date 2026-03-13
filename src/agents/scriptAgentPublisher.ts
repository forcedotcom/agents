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
import { AuthInfo, Connection, Logger, Messages, SfError, SfProject } from '@salesforce/core';
import { ComponentSet, ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { MaybeMock } from '../maybe-mock';
import { type AgentJson, type PublishAgent, type PublishAgentJsonResponse } from '../types';
import { findAuthoringBundle } from '../utils';

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
  private readonly maybeMock: MaybeMock;
  // this is the namedJWT connection, not to be used for deploy/retrieve
  private readonly connection: Connection;
  private project: SfProject;
  private readonly agentJson: AgentJson;
  private readonly developerName: string;
  private readonly bundleMetaPath: string;
  private bundleDir: string;
  private readonly skipRetrieve: boolean;
  /**
   * Original connection username, stored to create fresh connections for metadata operations.
   * This ensures metadata operations (retrieve/deploy) use a standard connection that hasn't
   * been upgraded with JWT, which is required for SOAP API operations.
   */
  private readonly originalUsername: string;
  private readonly API_URL: string;
  private readonly API_HEADERS = {
    'x-client-name': 'afdx',
    'content-type': 'application/json',
  };

  /**
   * Creates a new AgentPublisher instance
   *
   * @param connection The connection to the Salesforce org
   * @param project The Salesforce project
   * @param agentJson
   * @param skipMetadataRetrieve Whether to skip retrieving the agent metadata from the org
   */
  public constructor(
    connection: Connection,
    project: SfProject,
    agentJson: AgentJson,
    skipMetadataRetrieve: boolean = false
  ) {
    this.maybeMock = new MaybeMock(connection);
    this.connection = connection;
    this.project = project;
    this.agentJson = agentJson;
    // Store the original username to create fresh connections for metadata operations
    this.originalUsername = connection.getUsername()!;
    this.skipRetrieve = skipMetadataRetrieve;
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

    const body = {
      agentDefinition: this.agentJson,
      instanceConfig: {
        endpoint: this.connection.instanceUrl,
      },
    };

    // Step 1: Predict the next version name by querying existing versions
    const predictedVersionName = await this.getNextVersionName();
    getLogger().debug(`Predicted next version name: ${predictedVersionName}`);

    // Step 2: Deploy the AuthoringBundle with the predicted version
    // This must happen BEFORE publishing to allow SDR string replacement logic to work
    await this.deployAuthoringBundle(predictedVersionName);

    // Step 3: Use JWT token only for the publish API call, then restore connection
    // before metadata operations that may use SOAP API
    let response: PublishAgentJsonResponse;
    try {
      const botId = await this.getPublishedBotId(this.developerName);
      // if we've found a botId in the org, then this agent has already been published before => ai-agent/v1.1/authoring/agents/<id>/versions
      // if we didn't find an Id in the org, then we're publishing for the first time         => ai-agent/v1.1/authoring/agents
      const url = botId ? `${this.API_URL}/${botId}/versions` : this.API_URL;
      response = await this.maybeMock.request<PublishAgentJsonResponse>('POST', url, body, this.API_HEADERS);
    } finally {
      // Restore the original connection for subsequent metadata operations.
      // Use refresh token if available.
      delete this.connection.accessToken;

      const authFields = this.connection.getAuthInfoFields();
      if (authFields.refreshToken) {
        await this.connection.refreshAuth();
      }
    }

    if (response.botId && response.botVersionId) {
      // Step 4: Verify the published version matches our prediction
      const actualVersionName = await this.getVersionDeveloperName(response.botVersionId);
      if (actualVersionName !== predictedVersionName) {
        getLogger().warn(
          `Version name mismatch: predicted ${predictedVersionName} but got ${actualVersionName}. This may indicate a version numbering issue.`
        );
      }

      // Step 5: Retrieve the new Agent metadata that's in the org
      if (!this.skipRetrieve) {
        await this.retrieveAgentMetadata(actualVersionName);
      }

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
   * Creates a fresh standard connection for metadata operations (retrieve/deploy).
   * This ensures metadata operations use a connection that hasn't been upgraded with JWT,
   * which is required for SOAP API operations.
   *
   * @returns A fresh Connection instance with standard authentication
   */
  private async createStandardConnection(): Promise<Connection> {
    const authInfo = await AuthInfo.create({
      username: this.originalUsername,
    });
    return Connection.create({
      authInfo,
    });
  }
  /**
   * Validates and extracts the developer name from the agent configuration,
   * and locates the corresponding authoring bundle directory and metadata file.
   *
   * @returns An object containing:
   * - developerName: The cleaned developer name without version suffixes
   * - bundleDir: The path to the authoring bundle directory
   * - bundleMetaPath: The full path to the bundle-meta.xml file
   *
   * @throws SfError if the authoring bundle directory or metadata file cannot be found
   */
  private validateDeveloperName(): { developerName: string; bundleDir: string; bundleMetaPath: string } {
    const developerName = this.agentJson.globalConfiguration.developerName.replace(/_v\d$/, '');
    const defaultPackagePath = path.resolve(this.project.getDefaultPackage().path);

    // Try to find the authoring bundle directory by recursively searching from the default package path
    const bundleDir = findAuthoringBundle(defaultPackagePath, developerName);

    if (!bundleDir) {
      throw SfError.create({
        name: 'CannotFindBundle',
        message: `Cannot find an authoring bundle in ${defaultPackagePath} that matches ${developerName}`,
      });
    }

    const bundleMetaPath = path.join(bundleDir, `${developerName}.bundle-meta.xml`);

    if (!existsSync(bundleMetaPath)) {
      throw SfError.create({
        name: 'CannotFindBundle',
        message: `Cannot find a bundle-meta.xml file in ${bundleDir} that matches ${this.developerName}`,
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
    const standardConnection = await this.createStandardConnection();

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
        username: this.originalUsername,
        exclude: [],
      },
    });
    const retrieve = await cs.retrieve({
      usernameOrConnection: standardConnection,
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
    const standardConnection = await this.createStandardConnection();

    // 2. attempt to deploy the authoring bundle to the org
    const deploy = await ComponentSet.fromSource(this.bundleDir).deploy({
      usernameOrConnection: standardConnection,
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
      const queryResult = await this.connection.singleRecordQuery<{ Id: string }>(
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
      const queryResult = await this.connection.singleRecordQuery<{ DeveloperName: string }>(
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

  /**
   * Queries for all existing bot versions and predicts the next version name.
   * Version names follow the pattern v1, v2, etc.
   *
   * @returns The predicted next version name (e.g., "v1" if no versions exist, "v3" if max is v2)
   */
  private async getNextVersionName(): Promise<string> {
    const botId = await this.getPublishedBotId(this.developerName);

    // If bot doesn't exist yet, this will be the first version
    if (!botId) {
      getLogger().debug('No existing bot found, next version will be v1');
      return 'v1';
    }

    try {
      // Query all bot versions ordered by version number
      const queryResult = await this.connection.query<{ DeveloperName: string; VersionNumber: number }>(
        `SELECT DeveloperName, VersionNumber FROM BotVersion WHERE BotDefinitionId='${botId}' AND IsDeleted = false ORDER BY VersionNumber DESC LIMIT 1`
      );

      if (queryResult.totalSize === 0) {
        getLogger().debug('No existing versions found, next version will be v1');
        return 'v1';
      }

      const latestVersion = queryResult.records[0];
      const nextVersionNumber = latestVersion.VersionNumber + 1;
      const nextVersionName = `v${nextVersionNumber}`;
      getLogger().debug(
        `Latest version is ${latestVersion.DeveloperName} (number: ${latestVersion.VersionNumber}), next version will be ${nextVersionName}`
      );
      return nextVersionName;
    } catch (error) {
      getLogger().debug(`Error querying versions: ${JSON.stringify(error)}. Defaulting to v1`);
      return 'v1';
    }
  }
}
