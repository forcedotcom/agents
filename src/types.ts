/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * An agent job spec is a list of job titles and descriptions
 * to be performed by the agent.
 */
export type AgentJobSpec = [
  {
    jobTitle: string;
    jobDescription: string;
  }
];

/**
 * The parameters used to generate an agent spec.
 */
export type AgentJobSpecCreateConfig = {
  name: string;
  type: 'customer_facing' | 'employee_facing';
  role: string;
  companyName: string;
  companyDescription: string;
  companyWebsite?: string;
};

/**
 * The parameters used to generate an agent in an org.
 *
 * NOTE: This is likely to change with planned serverside APIs.
 */
export type AgentCreateConfig = AgentJobSpecCreateConfig & {
  jobSpecs: AgentJobSpec;
};

/**
 * An interface for working with Agents.
 */
export type SfAgent = {
  create(config: AgentCreateConfig): Promise<AgentCreateResponse>;
  createSpec(config: AgentJobSpecCreateConfig): Promise<AgentJobSpec>;
};

/**
 * The response from the `agent-job-spec` API.
 */
export type AgentJobSpecCreateResponse = {
  isSuccess: boolean;
  errorMessage?: string;
  jobSpecs?: AgentJobSpec;
};

/**
 * The response from the `attach-agent-topics` API.
 */
export type AgentCreateResponse = {
  isSuccess: boolean;
  errorMessage?: string;
};
