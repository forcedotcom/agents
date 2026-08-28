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
import { Connection, Lifecycle, Messages, SfError, SfProject } from '@salesforce/core';
import { Duration, env } from '@salesforce/kit';
import { ComponentSet, ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { MaybeMock } from '../maybe-mock';
import { type AgentJson, type PublishAgent, type PublishAgentJsonResponse } from '../types';
import { findAuthoringBundle, getHttpStatusCode, supportsAiAgentDefinition } from '../utils';
import { CtxLogger } from '../ctxLogger';
import { managerFor } from '../connectionManager';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agentPublisher');

let logger: CtxLogger;
const getLogger = (): CtxLogger => {
  if (!logger) {
    logger = CtxLogger.child('AgentPublisher');
  }
  return logger;
};

// Error name thrown by Connection.singleRecordQuery() when the SOQL matched zero rows.
// Not exported from @salesforce/core, so we match the string it sets on the SfError.
const SINGLE_RECORD_QUERY_NO_RECORDS = 'SingleRecordQuery_NoRecords';

/**
 * The metadata retrieve/deploy steps after a publish poll the server with SDR's pollStatus(),
 * which defaults to a 60-minute timeout when called without one. A stuck server-side operation
 * therefore blocks silently for up to an hour with no interim output (especially under --json).
 * Bound each poll to a shorter, env-overridable timeout so a stalled publish fails fast with a
 * clear error instead of hanging. Normal publishes complete in well under a minute, so 10 minutes
 * leaves generous headroom for a legitimately slow one.
 */
const getMetadataPollTimeout = (): Duration =>
  Duration.minutes(env.getNumber('SF_AGENT_PUBLISH_METADATA_POLL_TIMEOUT_MINUTES', 10));

/**
 * Service class responsible for publishing agents to Salesforce orgs
 */
export class ScriptAgentPublisher {
  private readonly connection: Connection;
  private project: SfProject;
  private readonly agentJson: AgentJson;
  private readonly developerName: string;
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
   */
  public constructor(
    connection: Connection,
    project: SfProject,
    agentJson: AgentJson,
    skipMetadataRetrieve: boolean = false
  ) {
    this.connection = connection;
    this.project = project;
    this.agentJson = agentJson;
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
    getLogger().debug('Publishing agent', { developerName: this.developerName });

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
      const botVersion = await this.getBotVersion(response.botVersionId);
      if (!this.skipRetrieve) {
        await this.retrieveAgentMetadata(botVersion);
      }
      await this.deployAuthoringBundle(botVersion.developerName);

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
   * @returns An object containing:
   * - developerName: The agent's developer name
   * - bundleDir: The path to the authoring bundle directory
   * - bundleMetaPath: The full path to the bundle-meta.xml file
   *
   * @throws SfError if the authoring bundle directory or metadata file cannot be found
   */
  private validateDeveloperName(): { developerName: string; bundleDir: string; bundleMetaPath: string } {
    const developerName = this.agentJson.globalConfiguration.developerName;
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
   * Retrieve the agent metadata from the org after publishing.
   *
   * On orgs that support it (API version >= 68), the agent is retrieved as the simplified
   * `AiAgentDefinition` / `AiAgentDefinitionVersion` metadata types, with action dependencies
   * (Flow, ApexClass, PromptTemplate, etc.) spidered via `rootTypesWithDependencies` so they
   * do not need to be enumerated in the manifest. Older orgs fall back to the legacy
   * `Bot` / `GenAiPlugin` / `GenAiFunction` / `Agent` manifest.
   *
   * @param botVersion The developerName and numeric version of the just-published agent
   */
  private async retrieveAgentMetadata(botVersion: { developerName: string; versionNumber: number }): Promise<void> {
    const standardConn = (await managerFor(this.connection)).getStandardConnection();
    const defaultPackagePath = path.resolve(this.project.getDefaultPackage().path);

    const useNewFormat = supportsAiAgentDefinition(standardConn);
    getLogger().debug('Retrieving agent metadata', {
      developerName: this.developerName,
      format: useNewFormat ? 'AiAgentDefinition' : 'Bot/GenAiPlanner',
      orgApiVersion: standardConn.getApiVersion(),
    });
    const metadataEntries = useNewFormat
      ? [
          `AiAgentDefinition:${this.developerName}`,
          `AiAgentDefinitionVersion:${this.developerName}#${botVersion.versionNumber}`,
        ]
      : [
          `Bot:${this.developerName}`,
          ...this.agentJson.agentVersion.nodes.flatMap((n) => [
            `GenAiPlugin:${n.developerName}`,
            // Some node types (e.g. `related_agent` from a `connected_subagent` block) are pure
            // delegation stubs and compile with no `tools` array, so guard against undefined.
            ...(n.tools ?? []).map((t) => `GenAiFunction:${t.name}`),
          ]),
          `Agent:${this.developerName}_${botVersion.developerName}`,
        ];

    const cs = await ComponentSetBuilder.build({
      metadata: {
        metadataEntries,
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
      // spider action dependencies for the new metadata types only
      ...(useNewFormat ? { rootTypesWithDependencies: ['AiAgentDefinitionVersion'] } : {}),
    });

    const retrieveTimeout = getMetadataPollTimeout();
    const retrieveStart = Date.now();
    getLogger().debug('Polling for agent metadata retrieve', { timeoutMinutes: retrieveTimeout.minutes });
    const retrieveResult = await retrieve.pollStatus({ timeout: retrieveTimeout });
    getLogger().debug('Agent metadata retrieve poll completed', { durationMs: Date.now() - retrieveStart });

    if (!retrieveResult.response?.success) {
      const errMessages = JSON.stringify(retrieveResult.response?.messages) ?? 'unknown';
      const error = messages.createError('agentRetrievalError', [errMessages]);
      error.actions = [messages.getMessage('agentRetrievalErrorActions')];
      throw error;
    }

    // A v68+ org with the AiAgentDefinition feature flag disabled resolves the new types to
    // nothing, producing a success:true retrieve that wrote zero agent files. Surface that.
    const fileResponses = retrieveResult.getFileResponses();
    const resolvedTypes = [...new Set(fileResponses.map((f) => f.type))];
    getLogger().debug('Agent metadata retrieve resolved components', {
      developerName: this.developerName,
      componentCount: fileResponses.length,
      types: resolvedTypes,
    });
    if (useNewFormat && fileResponses.length === 0) {
      getLogger().warn('New-format retrieve resolved zero components; org may have the AiAgentDefinition feature flag disabled', {
        developerName: this.developerName,
        orgApiVersion: standardConn.getApiVersion(),
      });
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
    getLogger().debug('Setting target on authoring bundle meta.xml', {
      target,
      bundleMetaPath: this.bundleMetaPath,
    });
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
    const deployTimeout = getMetadataPollTimeout();
    const deployStart = Date.now();
    getLogger().debug('Polling for authoring bundle deploy', { timeoutMinutes: deployTimeout.minutes });
    const deployResult = await deploy.pollStatus({ timeout: deployTimeout });
    getLogger().debug('Authoring bundle deploy poll completed', { durationMs: Date.now() - deployStart });

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
      // Escape single quotes so a developerName carrying one cannot break out of the SOQL
      // string literal (CWE-89). Mirrors the repo's canonical pattern in agentEvalRunner.ts.
      const escapedApiName = agentApiName.replace(/'/g, "''");
      const queryResult = await standardConn.singleRecordQuery<{ Id: string }>(
        `SELECT Id FROM BotDefinition WHERE DeveloperName='${escapedApiName}'`
      );
      getLogger().debug('Agent is already published', { agentApiName, botId: queryResult.Id });
      return queryResult.Id;
    } catch (error) {
      const wrapped = SfError.wrap(error);
      // No BotDefinition matched the developer name: the agent genuinely has not been
      // published yet. Return undefined so the caller POSTs a first version.
      if (wrapped.name === SINGLE_RECORD_QUERY_NO_RECORDS) {
        getLogger().debug('Agent is not yet published', { agentApiName });
        return undefined;
      }
      // Any other error means the lookup itself failed (auth, network, multiple matches),
      // so we cannot tell whether the agent already exists. Collapsing this into
      // "not published" risks POSTing a duplicate first version over an existing agent,
      // so surface it instead of swallowing it. We log at debug and rethrow (rather than
      // warn) per ai-docs/logging.md: the rethrown error propagates and is logged upstack,
      // so the telemetry event — not this line — is the durable signal for this failure.
      getLogger().debug('Failed to determine whether agent is already published', {
        agentApiName,
        statusCode: getHttpStatusCode(error),
        errName: wrapped.name,
        errMsg: wrapped.message,
      });
      await Lifecycle.getInstance().emitTelemetry({
        eventName: 'agent_publish_botid_lookup_failed',
        statusCode: getHttpStatusCode(error) ?? null,
        errName: wrapped.name,
      });
      throw wrapped;
    }
  }

  /**
   * Returns the developerName and numeric version of the given bot version ID.
   *
   * @param botVersionId The Id of the bot version
   * @returns The developer name (e.g. `v1`) and numeric version (e.g. `1`) of the bot version
   */
  private async getBotVersion(botVersionId: string): Promise<{ developerName: string; versionNumber: number }> {
    try {
      const standardConn = (await managerFor(this.connection)).getStandardConnection();
      const escapedBotVersionId = botVersionId.replace(/'/g, "''");
      const queryResult = await standardConn.singleRecordQuery<{ DeveloperName: string; VersionNumber: number }>(
        `SELECT DeveloperName, VersionNumber FROM BotVersion WHERE Id='${escapedBotVersionId}'`
      );
      getLogger().debug('Resolved bot version', {
        botVersionId,
        developerName: queryResult.DeveloperName,
        versionNumber: queryResult.VersionNumber,
      });
      return { developerName: queryResult.DeveloperName, versionNumber: queryResult.VersionNumber };
    } catch (error) {
      const err = messages.createError('findBotVersionError', [botVersionId], undefined, error as Error);
      err.actions = [messages.getMessage('authoringBundleDeploymentErrorActions')];
      throw err;
    }
  }
}
