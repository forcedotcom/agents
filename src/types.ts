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

export type AgentJobSpecV2 = AgentJobSpecCreateConfigV2 & {
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

export type AgentCreateConfigV2 = DraftAgentTopicsBody & {
  generationInfo: {
    defaultInfo: {
      /**
       * List of topics from an agent spec.
       */
      preDefinedTopics?: DraftAgentTopics;
    };
  };
  /**
   * Whether to persist the agent creation in the org (true) or preview
   * what would be created (false).
   *
   * Default: false
   */
  saveAgent?: boolean;

  /**
   * Settings for the agent being created. Needed only when saveAgent=true
   */
  agentSettings?: {
    /**
     * The name to use for the Agent metadata to be created.
     */
    agentName: string;
    /**
     * The API name to use for the Agent metadata to be created.
     */
    agentApiName?: string;
    /**
     * The GenAiPlanner metadata ID if already created in the org.
     */
    plannerId?: string;
    /**
     * User ID of an existing user.
     *
     * Determines what this agent can access and do. If your agent uses
     * features or objects that require additional permissions, assign
     * a custom user.
     */
    userId?: string;
    /**
     * Store conversation transcripts, including end-user data, in event logs
     * for this agent for troubleshooting. If false, conversation data is
     * replaced with, "Sensitive data not available."
     *
     * Default: false
     */
    enrichLogs?: boolean;
    /**
     * The conversational style of your agent's responses. Can be one of:
     * formal, casual, or neutral.
     *
     * Default: casual
     */
    tone?: 'casual';
    /**
     * The language your agent uses in conversations. Agent currently
     * supports English only.
     *
     * Default: en_US
     */
    primaryLanguage?: 'en_US';
  };
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

export type AgentCreateResponseV2 = {
  isSuccess: boolean;
  errorMessage?: string;
  /**
   * If the agent was created with saveAgent=true, these are the
   * IDs that make up an agent; Bot, BotVersion, and GenAiPlanner metadata.
   */
  agentId?: {
    botId: string;
    botVersionId: string;
    plannerId: string;
  };
  agentDefinition: {
    agentDescription: string;
    topics: [
      {
        scope: string;
        topic: string;
        actions: [
          {
            actionName: string;
            exampleOutput: string;
            actionDescription: string;
            inputs: [
              {
                inputName: string;
                inputDataType: string;
                inputDescription: string;
              }
            ];
            outputs: [
              {
                outputName: string;
                outputDataType: string;
                outputDescription: string;
              }
            ];
          }
        ];
        instructions: string[];
        classificationDescription: string;
      }
    ];
    sampleUtterances: string[];
  };
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
