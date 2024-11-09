/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';
import { Connection, Logger, SfError, SfProject } from '@salesforce/core';
import { Duration, sleep } from '@salesforce/kit';
import { getMockDir } from './mockDir';
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
  private mockDir?: string;

  public constructor(private connection: Connection, private project: SfProject) {
    this.logger = Logger.childFromRoot(this.constructor.name);
    this.mockDir = getMockDir();
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

    if (this.mockDir) {
      const specFileName = `${config.name}Spec.json`;
      const specFilePath = join(this.mockDir, `${specFileName}`);
      try {
        this.logger.debug(`Using mock directory: ${this.mockDir} for agent job spec creation`);
        statSync(specFilePath);
      } catch (err) {
        throw SfError.create({
          name: 'MissingMockFile',
          message: `SF_MOCK_DIR [${this.mockDir}] must contain a spec file with name ${specFileName}`,
          cause: err,
        });
      }
      try {
        this.logger.debug(`Returning mock agent spec file: ${specFilePath}`);
        agentSpec = JSON.parse(readFileSync(specFilePath, 'utf8')) as AgentJobSpec;
      } catch (err) {
        throw SfError.create({
          name: 'InvalidMockFile',
          message: `SF_MOCK_DIR [${this.mockDir}] must contain a valid spec file with name ${specFileName}`,
          cause: err,
          actions: [
            'Check that the file is readable',
            'Check that the file is a valid JSON array of jobTitle and jobDescription objects',
          ],
        });
      }
    } else {
      // TODO: We'll probably want to wrap this for better error handling but let's see
      //       what it looks like first.
      const response = await this.connection.requestGet<AgentJobSpecCreateResponse>(this.buildAgentJobSpecUrl(config), {
        retry: { maxRetries: 3 },
      });
      if (response.isSuccess) {
        agentSpec = response?.jobSpecs as AgentJobSpec;
      } else {
        throw SfError.create({
          name: 'AgentJobSpecCreateError',
          message: response.errorMessage ?? 'unknown',
        });
      }
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
