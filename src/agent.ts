/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { inspect } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { Connection, Logger, SfError, SfProject } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { Duration } from '@salesforce/kit';
import {
  type SfAgent,
  type AgentCreateConfig,
  type AgentCreateResponse,
  type AgentJobSpec,
  type AgentJobSpecCreateConfig,
  type AgentJobSpecCreateResponse,
  AttachAgentTopicsBody,
} from './types.js';
import { MaybeMock } from './maybe-mock';

/**
 * Class for creating Agents and agent specs.
 */
export class Agent implements SfAgent {
  private logger: Logger;
  private maybeMock: MaybeMock;
  private readonly connection: Connection;

  public constructor(connection: Connection, private project: SfProject) {
    this.logger = Logger.childFromRoot(this.constructor.name);
    this.maybeMock = new MaybeMock(connection);
    this.connection = connection;
  }

  public async create(config: AgentCreateConfig): Promise<AgentCreateResponse> {
    this.logger.debug(`Creating Agent using config: ${inspect(config)} in project: ${this.project.getPath()}`);
    // Generate a GenAiPlanner in the local project and deploy
    const genAiSourceDirPath = path.join(
      this.project?.getDefaultPackage().fullPath ?? 'force-app',
      'main',
      'default',
      'genAiPlanners'
    );
    const genAiSourcePath = path.join(genAiSourceDirPath, `${config.name}.genAiPlanner-meta.xml`);

    this.logger.debug(`Creating Agent using config: ${inspect(config)} in project: ${this.project.getPath()}`);
    // instead of writing file, zip to memory and send in cs.deploy({zipPath
    fs.mkdirSync(genAiSourceDirPath, { recursive: true });
    fs.writeFileSync(
      genAiSourcePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlanner xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>description for ${config.name}</description>
    <masterLabel>MasterLabel for ${config.name}</masterLabel>
    <plannerType>AiCopilot__ReAct</plannerType>
</GenAiPlanner>
      `
    );

    const cs = await ComponentSetBuilder.build({ sourcepath: [genAiSourcePath] });

    const deploy = await cs.deploy({ usernameOrConnection: this.connection });
    const result = await deploy.pollStatus({ timeout: Duration.minutes(10_000), frequency: Duration.seconds(1) });
    if (!result.response.success) {
      throw new SfError(result.response.errorMessage ?? `Unable to deploy ${result.response.id}`);
    }

    const plannerId = (
      await this.connection.singleRecordQuery<{ Id: string }>(
        `SELECT Id
           FROM GenAiPlannerDefinition
           WHERE MasterLabel = 'MasterLabel for ${config.name}'`,
        { tooling: true }
      )
    ).Id;

    // make API request to /services/data/{api-version}/connect/attach-agent-topics
    const url = `${
      this.connection.instanceUrl
    }/services/data/v${this.connection.getApiVersion()}/connect/attach-agent-topics`;

    const body: AttachAgentTopicsBody = {
      plannerId,
      agentJobSpecs: config.jobSpec,
      companyDescription: config.companyDescription,
      role: config.role,
      companyName: config.companyName,
      agentType: config.type,
    };
    const response = await this.maybeMock.request<AgentCreateResponse>('POST', url, body);

    // on success, retrieve all Agent metadata

    return response;
  }

  /**
   * Create an agent spec from provided data.
   *
   * @param config The configuration used to generate an agent spec.
   */
  public async createSpec(config: AgentJobSpecCreateConfig): Promise<AgentJobSpec> {
    this.verifyAgentSpecConfig(config);

    let agentSpec: AgentJobSpec;
    const response = await this.maybeMock.request<AgentJobSpecCreateResponse>('GET', this.buildAgentJobSpecUrl(config));
    if (response.isSuccess && response.jobSpecs) {
      agentSpec = response.jobSpecs;
    } else {
      throw SfError.create({
        name: 'AgentJobSpecCreateError',
        message: response.errorMessage ?? 'unknown',
      });
    }

    return agentSpec;
  }

  // eslint-disable-next-line class-methods-use-this
  private verifyAgentSpecConfig(config: AgentJobSpecCreateConfig): void {
    // TBD: for now just return. At some point verify all required config values.
    if (config) return;
  }

  // eslint-disable-next-line class-methods-use-this
  private buildAgentJobSpecUrl(config: AgentJobSpecCreateConfig): string {
    const { type, role, companyName, companyDescription, companyWebsite } = config;
    const website = companyWebsite ? `&companyWebsite=${companyWebsite}` : '';
    return `/connect/agent-job-spec?agentType=${type}&role=${role}&companyName=${companyName}&companyDescription=${companyDescription}${website}`;
  }
}
