/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { inspect } from 'node:util';
import { Connection, Logger, SfError, SfProject } from '@salesforce/core';
import { Duration, sleep } from '@salesforce/kit';
import { MaybeMock } from './mockDir';
import {
  type SfAgent,
  type AgentCreateConfig,
  type AgentCreateResponse,
  type AgentJobSpec,
  type AgentJobSpecCreateConfig,
  type AgentJobSpecCreateResponse,
} from './types.js';

export class Agent implements SfAgent {
  private logger: Logger;
  private maybeMock: MaybeMock;

  public constructor(connection: Connection, private project: SfProject) {
    this.logger = Logger.childFromRoot(this.constructor.name);
    this.maybeMock = new MaybeMock(connection);
  }

  public async create(config: AgentCreateConfig): Promise<AgentCreateResponse> {
    this.logger.debug(`Creating Agent using config: ${inspect(config)} in project: ${this.project.getPath()}`);
    // Generate a GenAiPlanner in the local project and deploy

    // make API request to /services/data/{api-version}/connect/attach-agent-topics
    await sleep(Duration.seconds(3));

    // on success, retrieve all Agent metadata

    return { isSuccess: true };
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
