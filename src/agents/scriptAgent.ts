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
import fs, { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Lifecycle, SfError, SfProject } from '@salesforce/core';
import { env } from '@salesforce/kit';
import {
  AgentJson,
  type AgentPreviewEndResponse,
  AgentPreviewInterface,
  type AgentPreviewSendResponse,
  type AgentPreviewStartResponse,
  AgentScriptContent,
  type CompileAgentScriptResponse,
  ExtendedAgentJobSpec,
  PlannerResponse,
  PreviewMetadata,
  PublishAgent,
  ScriptAgentOptions,
} from '../types';
import {
  appendTranscriptToHistory,
  writeMetaFileToHistory,
  logSessionToIndex,
  updateMetadataEndTime,
  writeTraceToHistory,
  getEndpoint,
  findAuthoringBundle,
  getHistoryDir,
  TranscriptEntry,
  getAllHistory,
  getAgentIndexDir,
} from '../utils';
import { getDebugLog } from '../apexUtils';
import { generateAgentScript } from '../templates/agentScriptTemplate';
import { ScriptAgentPublisher } from './scriptAgentPublisher';
import { AgentBase } from './agentBase';

export class ScriptAgent extends AgentBase {
  public preview: AgentPreviewInterface & {
    setMockMode: (mockMode: 'Mock' | 'Live Test') => void;
  };
  private mockMode: 'Mock' | 'Live Test' = 'Mock';
  private agentScriptContent: AgentScriptContent;
  private agentJson: AgentJson | undefined;
  private apiBase = `https://${getEndpoint()}api.salesforce.com/einstein/ai-agent`;
  private readonly aabDirectory: string;
  private readonly metaContent: string;
  public constructor(private options: ScriptAgentOptions) {
    super(options.connection);
    this.options = options;

    // Find the AAB directory using the project
    const projectDirs = options.project.getPackageDirectories();
    const searchDirs = projectDirs.map((pkgDir) => pkgDir.fullPath);
    const foundDirectory = findAuthoringBundle(searchDirs, options.aabName);

    if (!foundDirectory) {
      throw SfError.create({
        name: 'AABNotFound',
        message: `Cannot find an authoring bundle named '${
          options.aabName
        }' in the project. Searched in: ${searchDirs.join(', ')}`,
      });
    }

    this.aabDirectory = foundDirectory;

    // Set initial name from AAB name (will be updated when agent is compiled)
    this.name = options.aabName;

    // Load the .agent file
    this.agentScriptContent = fs.readFileSync(join(this.aabDirectory, `${options.aabName}.agent`), 'utf-8');

    // Load and validate the bundle-meta.xml file
    const bundleMetaPath = join(this.aabDirectory, `${options.aabName}.bundle-meta.xml`);
    if (!existsSync(bundleMetaPath)) {
      throw SfError.create({
        name: 'BundleMetaNotFound',
        message: `Cannot find bundle-meta.xml file for '${options.aabName}' at ${bundleMetaPath}`,
      });
    }
    this.metaContent = fs.readFileSync(bundleMetaPath, 'utf-8');
    this.preview = {
      start: (mockMode?: 'Mock' | 'Live Test', apexDebugging?: boolean): Promise<AgentPreviewStartResponse> =>
        this.startPreview(mockMode, apexDebugging),
      send: (message: string): Promise<AgentPreviewSendResponse> => this.sendMessage(message),
      getAllTraces: (): Promise<PlannerResponse[]> => this.getAllTracesFromDisc(),
      end: (): Promise<AgentPreviewEndResponse> => this.endSession(),
      saveSession: (outputDir: string): Promise<string> => this.saveSessionTo(outputDir),
      setMockMode: (mockMode: 'Mock' | 'Live Test'): void => this.setMockMode(mockMode),
      setApexDebugging: (apexDebugging: boolean): void => this.setApexDebugging(apexDebugging),
    } as AgentPreviewInterface & { setMockMode: (mockMode: 'Mock' | 'Live Test') => void };
  }

  /**
   * Creates an AiAuthoringBundle directory, .script file, and -meta.xml file
   *
   * @returns Promise<void>
   * @beta
   * @param options {
   * project: SfProject;
   * bundleApiName: string;
   * outputDir?: string;
   * agentSpec?: ExtendedAgentJobSpec;
   *}
   */
  public static async createAuthoringBundle(options: {
    project: SfProject;
    bundleApiName: string;
    outputDir?: string;
    agentSpec?: ExtendedAgentJobSpec;
  }): Promise<void> {
    // this will eventually be done via AI in the org, but for now, we're hardcoding a valid .agent file boilerplate response

    const agentScript = generateAgentScript(options.bundleApiName, options.agentSpec);

    // Get default output directory if not specified
    const targetOutputDir = join(
      options.outputDir ?? join(options.project.getDefaultPackage().fullPath, 'main', 'default'),
      'aiAuthoringBundles',
      options.bundleApiName
    );
    mkdirSync(targetOutputDir, { recursive: true });

    // Generate file paths
    const agentPath = join(targetOutputDir, `${options.bundleApiName}.agent`);
    const metaXmlPath = join(targetOutputDir, `${options.bundleApiName}.bundle-meta.xml`);

    // Write Agent file
    await writeFile(agentPath, agentScript);

    // Write meta.xml file
    const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">
  <bundleType>AGENT</bundleType>
</AiAuthoringBundle>`;
    await writeFile(metaXmlPath, metaXml);
  }

  public async refreshContent(): Promise<void> {
    this.agentScriptContent = await fs.promises.readFile(
      join(this.aabDirectory, `${this.options.aabName}.agent`),
      'utf-8'
    );
    await this.compile();
  }

  public async getTrace(planId: string): Promise<PlannerResponse> {
    try {
      return await this.connection.request<PlannerResponse>({
        method: 'GET',
        url: `${this.apiBase}/v1.1/preview/sessions/${this.sessionId!}/plans/${planId}`,
        headers: {
          'x-client-name': 'afdx',
        },
      });
    } catch (error) {
      const errorName = (error as { name?: string })?.name ?? '';
      if (errorName.includes('404')) {
        throw SfError.create({
          name: 'AgentApiNotFound',
          message: `Trace API returned 404. SF_TEST_API=${
            env.getBoolean('SF_TEST_API') ? 'true' : 'false'
          } If targeting a test.api environment, set SF_TEST_API=true, otherwise it's false.`,
          cause: error,
        });
      }
      throw SfError.wrap(error);
    }
  }

  /**
   * Compiles AgentScript returning agent JSON when successful, otherwise the compile errors are returned.
   *
   * @returns Promise<CompileAgentScriptResponse> The raw API response
   * @beta
   */
  public async compile(): Promise<CompileAgentScriptResponse> {
    const url = `https://${getEndpoint()}api.salesforce.com/einstein/ai-agent/v1.1/authoring/scripts`;

    const compileData = {
      assets: [
        {
          type: 'AFScript',
          name: 'AFScript',
          content: this.agentScriptContent,
        },
      ],
      afScriptVersion: '1.0.1',
    };

    const headers = {
      'x-client-name': 'afdx',
      'content-type': 'application/json',
    };

    try {
      const response = await this.connection.request<CompileAgentScriptResponse>(
        {
          method: 'POST',
          url,
          headers,
          body: JSON.stringify(compileData),
        },
        { retry: { maxRetries: 3 } }
      );
      if (response.status === 'success') {
        this.agentJson = response.compiledArtifact;

        // Set the display name from agentJson label, or fallback to AAB name
        this.name = this.agentJson.globalConfiguration.label || this.options.aabName;
      }

      return response;
    } catch (error) {
      const errorName = (error as { name?: string })?.name ?? '';
      if (errorName.includes('404')) {
        throw SfError.create({
          name: 'AgentApiNotFound',
          message: `Validation API returned 404. SF_TEST_API=${
            env.getBoolean('SF_TEST_API') ? 'true' : 'false'
          } If targeting a test.api environment, set SF_TEST_API=true, otherwise it's false.`,
          cause: error,
        });
      }
      throw SfError.wrap(error);
    }
  }
  /**
   * Publish an AgentJson representation to the org
   *
   * @beta
   * @returns {Promise<PublishAgentJsonResponse>} The publish response
   */
  public async publish(skipMetadataRetrieve?: boolean): Promise<PublishAgent> {
    if (!this.agentJson) {
      await this.compile();
    }
    const publisher = new ScriptAgentPublisher(
      this.connection,
      this.options.project,
      this.agentJson!,
      skipMetadataRetrieve
    );
    return publisher.publishAgentJson();
  }

  public getHistoryFromDisc(sessionId?: string): Promise<{
    metadata: PreviewMetadata | null;
    transcript: TranscriptEntry[];
    traces: PlannerResponse[];
  }> {
    // Use provided sessionId, or fall back to this.sessionId, or let getAllHistory find the most recent
    const actualSessionId = sessionId ?? this.sessionId;

    return getAllHistory(this.getAgentIdForStorage(), actualSessionId);
  }

  /**
   * Ending is not required
   * this will save all the transcripts to disc
   *
   * @returns `AgentPreviewEndResponse`
   */
  public async endSession(): Promise<AgentPreviewEndResponse> {
    if (!this.sessionId) {
      return Promise.resolve({ messages: [], _links: [] } as unknown as AgentPreviewEndResponse);
    }

    if (this.historyDir) {
      await appendTranscriptToHistory(
        {
          timestamp: new Date().toISOString(),
          agentId: this.getAgentIdForStorage(),
          sessionId: this.sessionId,
          role: 'agent',
          reason: 'UserRequest',
          raw: [],
        },
        this.historyDir
      );
      // Update metadata with end time
      await updateMetadataEndTime(this.historyDir, new Date().toISOString(), this.planIds);
    }

    // Clear session data for next session
    this.sessionId = undefined;
    this.historyDir = undefined;
    this.planIds = new Set<string>();

    return Promise.resolve({ messages: [], _links: [] } as unknown as AgentPreviewEndResponse);
  }

  public getAgentIdForStorage(): string {
    return this.options.aabName;
  }

  protected canApexDebug(): boolean {
    return this.mockMode === 'Live Test';
  }

  protected async handleApexDebuggingSetup(): Promise<void> {
    // ScriptAgent doesn't need trace flag setup for Apex debugging
    // Apex debugging is handled differently for script agents
    // Reference this to satisfy linter
    void this;
    return Promise.resolve();
  }

  protected async sendMessage(message: string): Promise<AgentPreviewSendResponse> {
    if (!this.sessionId) {
      throw SfError.create({ name: 'noSessionId', message: 'Agent not started, please call .start() first' });
    }

    const url = `${this.apiBase}/v1.1/preview/sessions/${this.sessionId}/messages`;

    const body = {
      message: {
        sequenceId: Date.now(),
        type: 'Text',
        text: message,
      },
      variables: [],
    };

    try {
      const start = Date.now();

      // Handle Apex debugging setup if needed
      if (this.apexDebugging && this.canApexDebug()) {
        await this.handleApexDebuggingSetup();
      }

      const agentId = this.getAgentIdForStorage();

      // Ensure session directory exists
      if (!this.historyDir) {
        this.historyDir = await getHistoryDir(agentId, this.sessionId);
      }

      void appendTranscriptToHistory(
        {
          timestamp: new Date().toISOString(),
          agentId,
          sessionId: this.sessionId,
          role: 'user',
          text: message,
        },
        this.historyDir
      );

      let response: AgentPreviewSendResponse;
      try {
        response = await this.connection.request<AgentPreviewSendResponse>({
          method: 'POST',
          url,
          body: JSON.stringify(body),
          headers: {
            'x-client-name': 'afdx',
          },
        });
      } catch (error) {
        const errorName = (error as { name?: string })?.name ?? '';
        if (errorName.includes('404')) {
          throw SfError.create({
            name: 'AgentApiNotFound',
            message: `Preview Send API returned 404. SF_TEST_API=${
              env.getBoolean('SF_TEST_API') ? 'true' : 'false'
            } If targeting a test.api environment, set SF_TEST_API=true, otherwise it's false.`,
            cause: error,
          });
        }
        throw SfError.wrap(error);
      }

      const planId = response.messages.at(0)!.planId;
      this.planIds.add(planId);

      await appendTranscriptToHistory(
        {
          timestamp: new Date().toISOString(),
          agentId,
          sessionId: this.sessionId,
          role: 'agent',
          text: response.messages.at(0)?.message,
          raw: response.messages,
        },
        this.historyDir
      );

      // Fetch and write trace immediately if available
      if (planId) {
        try {
          const trace = await this.getTrace(planId);
          await writeTraceToHistory(planId, trace, this.historyDir);
        } catch (error) {
          throw SfError.wrap(error);
        }
      }

      if (this.apexDebugging && this.canApexDebug()) {
        const apexLog = await getDebugLog(this.connection, start, Date.now());
        if (apexLog) {
          response.apexDebugLog = apexLog;
        }
      }

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }

  private setMockMode(mockMode: 'Mock' | 'Live Test'): void {
    this.mockMode = mockMode;
  }

  private async startPreview(
    mockMode?: 'Mock' | 'Live Test',
    apexDebugging?: boolean
  ): Promise<AgentPreviewStartResponse> {
    if (!this.agentJson) {
      void Lifecycle.getInstance().emit('agents:compiling', {});
      await this.compile();
    }

    if (!this.agentJson) {
      throw SfError.create({ message: 'error compiling', name: 'unable to start preview' });
    }

    // Use the provided mockMode parameter if given, otherwise keep the previously set one
    if (mockMode !== undefined) {
      this.mockMode = mockMode;
    }
    if (apexDebugging !== undefined) {
      this.apexDebugging = apexDebugging;
    }

    // send bypassUser=false when the compiledAgent.globalConfiguration.defaultAgentUser is INVALID
    let bypassUser =
      (
        await this.connection.query(
          `SELECT Id FROM USER WHERE username='${this.agentJson.globalConfiguration.defaultAgentUser}'`
        )
      ).totalSize === 1;

    if (bypassUser && this.agentJson.globalConfiguration.agentType === 'AgentforceEmployeeAgent') {
      // another situation which bypassUser = false, is when previewing an agent script, with a valid default_agent_user, and it's an AgentforceEmployeeAgent type
      bypassUser = false;
    }

    const agentDefinition = this.agentJson;
    agentDefinition.agentVersion.developerName = this.metaContent.match(/<target>.*(v\d+)<\/target>/)?.at(1) ?? 'v0';

    const body = {
      agentDefinition,
      enableSimulationMode: this.mockMode === 'Mock',
      externalSessionKey: randomUUID(),
      instanceConfig: {
        endpoint: this.options.connection.instanceUrl,
      },
      variables: [],
      parameters: {},
      streamingCapabilities: {
        chunkTypes: ['Text', 'LightningChunk'],
      },
      richContentCapabilities: {},
      bypassUser,
      executionHistory: [],
      conversationContext: [],
    };

    try {
      void Lifecycle.getInstance().emit('agents:simulation-starting', {});

      let response: AgentPreviewStartResponse;
      try {
        response = await this.connection.request<AgentPreviewStartResponse>(
          {
            method: 'POST',
            url: `${this.apiBase}/v1.1/preview/sessions`,
            headers: {
              'x-attributed-client': 'no-builder', // <- removes markdown from responses
              'x-client-name': 'afdx',
            },
            body: JSON.stringify(body),
          },
          { retry: { maxRetries: 3 } }
        );
      } catch (error) {
        const err = SfError.wrap(error);
        if (err.name.includes('404')) {
          throw SfError.create({
            name: 'AgentApiNotFound',
            message: `Preview Start API returned 404. SF_TEST_API=${
              env.getBoolean('SF_TEST_API') ? 'true' : 'false'
            } If targeting a test.api environment, set SF_TEST_API=true, otherwise it's false.`,
            cause: error,
          });
        }
        const stackToCheck = (err.cause as Error)?.stack ?? err.stack;
        if (this.mockMode === 'Live Test' && stackToCheck?.includes('Internal Error')) {
          err.message =
            "ensure the 'default_agent_user' set, is valid, and has the required permission sets assigned ['AgentforceServiceAgentBase', 'AgentforceServiceAgentUser', 'EinsteinGPTPromptTemplateUser']";
        }
        throw err;
      }
      this.sessionId = response.sessionId;
      const agentIdForStorage = this.options.aabName;

      // Initialize session directory and write initial data
      // Session directory structure:
      // .sfdx/agents/<agentId>/sessions/<sessionId>/
      // ├── transcript.jsonl    # All transcript entries (one per line)
      // ├── traces/             # Individual trace files
      // │   ├── <planId1>.json
      // │   └── <planId2>.json
      // └── metadata.json       # Session metadata (start time, end time, planIds, etc.)
      this.historyDir = await getHistoryDir(agentIdForStorage, response.sessionId);
      const startTime = new Date().toISOString();

      // Write initial agent messages immediately
      await appendTranscriptToHistory(
        {
          timestamp: startTime,
          agentId: agentIdForStorage,
          sessionId: response.sessionId,
          role: 'agent',
          text: response.messages.map((m) => m.message).join('\n'),
          raw: response.messages,
        },
        this.historyDir
      );

      // Write initial metadata
      await writeMetaFileToHistory(this.historyDir, {
        sessionId: response.sessionId,
        agentId: agentIdForStorage,
        startTime,
        apexDebugging: this.apexDebugging,
        mockMode: this.mockMode,
        planIds: [],
      });

      const agentDir = await getAgentIndexDir(agentIdForStorage);
      await logSessionToIndex(agentDir, {
        sessionId: response.sessionId,
        startTime,
        simulated: this.mockMode === 'Mock',
        agentId: agentIdForStorage,
      });

      return response;
    } catch (err) {
      throw SfError.wrap(err);
    }
  }
}
