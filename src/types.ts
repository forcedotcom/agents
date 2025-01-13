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

export type AgentJobSpecV2 = {
  config: AgentJobSpecCreateConfigV2;
  topics: DraftAgentTopics;
};

/**
 * The body POST'd to /services/data/{api-version}/connect/attach-agent-topics
 */
export type AttachAgentTopicsBody = {
  plannerId: string;
  role: string;
  companyName: string;
  companyDescription: string;
  agentType: string;
  agentJobSpecs: AgentJobSpec;
};

/**
 * The parameters used to generate an agent spec.
 */
export type AgentJobSpecCreateConfig = {
  // this name is not created with 'agent create spec'
  name: string;
  type: 'customer' | 'internal';
  role: string;
  companyName: string;
  companyDescription: string;
  companyWebsite?: string;
};

/**
 * The parameters used to generate an agent spec V2.
 */
export type AgentJobSpecCreateConfigV2 = {
  /**
   * Internal type is copilots; used by customers' employees.
   * Customer type is agents; used by customers' customers.
   */
  agentType: 'customer' | 'internal';
  role: string;
  companyName: string;
  companyDescription: string;
  companyWebsite?: string;
  /**
   * The maximum number of topics to create in the spec.
   * Default is 10.
   */
  maxNumOfTopics?: number;
  /**
   * Developer name of the prompt template.
   */
  promptTemplateName?: string;
  /**
   * Context info to be used in customized prompt template
   */
  groundingContext?: string;
};

/**
 * The parameters used to generate an agent in an org.
 *
 * NOTE: This is likely to change with planned serverside APIs.
 */
export type AgentCreateConfig = AgentJobSpecCreateConfig & {
  jobSpec: AgentJobSpec;
};

/**
 * The request body to send to the `draft-agent-topics` API.
 */
export type DraftAgentTopicsBody = {
  agentType: 'customer' | 'internal';
  generationInfo: {
    defaultInfo: {
      role: string;
      companyName: string;
      companyDescription: string;
      companyWebsite?: string;
    };
    customizedInfo?: {
      promptTemplateName: string;
      groundingContext?: string;
    };
  };
  generationSettings: {
    maxNumOfTopics?: number;
  };
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

export type DraftAgentTopics = [
  {
    name: string;
    description: string;
  }
];

/**
 * The response from the `draft-agent-topics` API.
 */
export type DraftAgentTopicsResponse = {
  isSuccess: boolean;
  errorMessage?: string;
  topics: DraftAgentTopics;
};
