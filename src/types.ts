/*
 * Copyright 2025, Salesforce, Inc.
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

import { Connection, Logger, SfProject } from '@salesforce/core';
import { FileProperties } from '@salesforce/source-deploy-retrieve';
import { type ApexLog } from '@salesforce/types/tooling';
import { metric } from './utils';

// ====================================================
//               Agent Runner Types
// ====================================================
export type AgentInteractionBase = {
  start(): Promise<AgentPreviewStartResponse>;
  send(sessionId: string, message: string): Promise<AgentPreviewSendResponse>;
  end(sessionId: string, reason: EndReason): Promise<AgentPreviewEndResponse>;
  toggleApexDebugMode(enable: boolean): void;
};

export type BaseAgentConfig = {
  connection: Connection;
  logger?: Logger;
};

export type ApiStatus = {
  status: 'UP' | 'DOWN';
};

// ====================================================
//               Agent Creation Types
// ====================================================
/**
 * Options for creating instances of agents from an org.
 */
export type AgentOptions = {
  connection: Connection;
  project?: SfProject;
  /**
   * The API name or ID of the agent (Bot) that exists in the org.
   */
  nameOrId: string;
};

export type BotMetadata = {
  Id: string;
  IsDeleted: boolean;
  DeveloperName: string;
  MasterLabel: string;
  CreatedDate: string; // eg., "2025-02-13T18:25:17.000+0000",
  CreatedById: string;
  LastModifiedDate: string; // eg., "2025-02-13T18:27:30.000+0000",
  LastModifiedById: string;
  SystemModstamp: string; // eg., "2025-02-13T18:27:30.000+0000",
  BotUserId: string;
  Description: string;
  Type: string;
  AgentType: string;
  AgentTemplate: null | string;
  BotVersions: { records: BotVersionMetadata[] };
};

export type BotVersionMetadata = {
  Id: string;
  Status: 'Active' | 'Inactive';
  IsDeleted: boolean;
  BotDefinitionId: string;
  DeveloperName: string;
  CreatedDate: string; // eg., "2025-06-02T23:16:20.000+0000",
  CreatedById: string;
  LastModifiedDate: string; // eg., "2025-06-02T23:16:21.000+0000",
  LastModifiedById: string;
  SystemModstamp: string; // eg., "2025-06-02T23:16:21.000+0000",
  VersionNumber: number;
  CopilotPrimaryLanguage: null | string;
  ToneType: AgentTone;
  CopilotSecondaryLanguages: null | string[];
};

export type BotActivationResponse = {
  success: boolean;
  isActivated: boolean;
  messages?: string[];
};

/**
 * An agent job spec is a list of job titles and descriptions
 * to be performed by the agent.
 */
export type AgentJobSpec = AgentJobSpecCreateConfig & {
  topics: DraftAgentTopics;
};

export type AgentType = 'customer' | 'internal';

export type AgentTone = 'casual' | 'formal' | 'neutral';

/**
 * The parameters used to generate an agent spec.
 */
export type AgentJobSpecCreateConfig = {
  /**
   * Internal type is copilots; used by customers' employees.
   * Customer type is agents; used by customers' customers.
   */
  agentType: AgentType;
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

export type AgentCreateConfig = DraftAgentTopicsBody & {
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
    tone?: AgentTone;
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
  agentType: AgentType;
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

export type AgentCreateResponse = {
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
  topicDrafts: DraftAgentTopics;
};

/**
 * The response from the `create-af-script` API.
 */
export type CreateAgentResponse = {
  isSuccess: boolean;
  errorMessage?: string;
  agentString?: AgentString;
};

// ====================================================
//               Agent Testing Types
// ====================================================
export type AgentTestConfig = {
  /**
   * The API name of a AiEvaluationDefinition.
   */
  name?: string;

  /**
   * The local file path of a AiEvaluationDefinition metadata file.
   */
  mdPath?: string;

  /**
   * The local file path of an agent test spec file.
   */
  specPath?: string;

  /**
   * The agent test spec data.
   */
  specData?: TestSpec;
};

export type TestStatus = 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR' | 'TERMINATED';

export type AgentTestStartResponse = {
  runId: string;
  status: TestStatus;
};

export type AgentTestStatusResponse = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
};

export type TestCaseResult = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  inputs: {
    utterance: string;
  };
  generatedData: {
    actionsSequence: string[];
    invokedActions: string;
    sessionId: string;
    outcome: string;
    topic: string;
  };
  testResults: Array<{
    name: string;
    actualValue: string;
    expectedValue: string;
    score: number;
    result: null | 'PASS' | 'FAILURE';
    metricLabel: 'Accuracy' | 'Precision';
    metricExplainability: string;
    status: TestStatus;
    startTime: string;
    endTime?: string;
    errorCode?: string;
    errorMessage?: string;
  }>;
  testNumber: number;
};

export type AgentTestResultsResponse = {
  status: TestStatus;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
  subjectName: string;
  testCases: TestCaseResult[];
};

export type AvailableDefinition = Omit<FileProperties, 'manageableState' | 'namespacePrefix'>;

// yaml type representation
export type TestCase = {
  utterance: string;
  expectedActions: string[] | undefined;
  expectedOutcome: string | undefined;
  expectedTopic: string | undefined;
  metrics?: Array<(typeof metric)[number]>;
  contextVariables?: Array<{ name: string; value: string }>;
  conversationHistory?: Array<
    | { role: 'user'; message: string; index?: number }
    | { role: 'agent'; message: string; topic: string; index?: number }
  >;
  customEvaluations?: Array<{
    label: string;
    name: string;
    parameters: Array<
      | { name: 'operator'; value: string; isReference: false }
      | { name: 'actual'; value: string; isReference: true }
      | { name: 'expected'; value: string; isReference: boolean }
    >;
  }>;
};

// yaml representation
export type TestSpec = {
  name: string;
  description?: string;
  subjectType: 'AGENT';
  subjectName: string;
  subjectVersion?: string;
  testCases: TestCase[];
};

// Metadata XML representation of what's required for a metric (just name)
export type MetadataMetric = { name: string };
// Metadata XML representation of evaluation (name / expectedValue)
export type MetadataExpectation = {
  // topic/action/outcome matching
  name:
    | 'topic_sequence_match'
    | 'topic_assertion'
    | 'action_sequence_match'
    | 'actions_assertion'
    | 'bot_response_rating'
    | 'output_validation';
  expectedValue: string;
};

export type MetadataCustomEvaluation = {
  // custom evaluators
  name: string;
  label: string;
  parameter: Array<
    | { name: 'operator'; value: string; isReference: false }
    | { name: 'actual'; value: string; isReference: true }
    | { name: 'expected'; value: string; isReference: boolean }
  >;
};

// metadata xml
export type AiEvaluationDefinition = {
  description?: string;
  name: string;
  subjectType: 'AGENT';
  subjectName: string;
  subjectVersion?: string;
  testCase: Array<{
    expectation: Array<MetadataMetric | MetadataExpectation | MetadataCustomEvaluation>;
    inputs: {
      contextVariable?: Array<{ variableName: string; variableValue: string }>;
      conversationHistory?: Array<
        | { role: 'user'; message: string; index: number }
        | { role: 'agent'; message: string; topic: string; index: number }
      >;
      utterance: string;
    };
  }>;
};

// ====================================================
//               Agent Preview Types
// ====================================================
export type AgentPreviewMessageLinks = {
  self: Href | null;
  messages: Href | null;
  session: Href | null;
  end: Href | null;
};

type Href = { href: string };

export type AgentPreviewError = {
  status: number;
  path: string;
  requestId: string;
  error: string;
  message: string;
  timestamp: number;
};

export type MessageType =
  | 'Inform'
  | 'TextChunk'
  | 'ProgressIndicator'
  | 'Inquire'
  | 'Confirm'
  | 'Failure'
  | 'Escalate'
  | 'SessionEnded'
  | 'EndOfTurn'
  | 'Error';

export type AgentPreviewMessage = {
  type: MessageType;
  id: string;
  feedbackId: string;
  planId: string;
  isContentSafe: boolean;
  message: string;
  result: {
    type: string;
    property: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
  };
  citedReferences: {
    type: string;
    value: string;
  };
};

export type AgentPreviewStartResponse = {
  sessionId: string;
  _links: AgentPreviewMessageLinks;
  messages: AgentPreviewMessage[];
};

export type AgentPreviewSendResponse = {
  messages: AgentPreviewMessage[];
  _links: AgentPreviewMessageLinks;
  apexDebugLog?: ApexLog;
};

export type AgentPreviewEndMessage = {
  type: string;
  id: string;
  reason: string;
  feedbackId: string;
};

export type AgentPreviewEndResponse = {
  messages: AgentPreviewEndMessage[];
  _links: AgentPreviewMessageLinks;
};

export type EndReason = 'UserRequest' | 'Transfer' | 'Expiration' | 'Error' | 'Other';

// ====================================================
//               Agent Trace Types
// ====================================================

export type AgentTraceStep =
  | UserInputStep
  | LLMExecutionStep
  | UpdateTopicStep
  | EventStep
  | ReasoningStep
  | PlannerResponseStep;

export type UserInputStep = {
  type: 'UserInputStep';
  message: string;
};

export type LLMExecutionStep = {
  type: 'LLMExecutionStep';
  promptName: string;
  promptContent: string;
  promptResponse: string;
  executionLatency: number;
  startExecutionTime: number;
  endExecutionTime: number;
};

export type UpdateTopicStep = {
  type: 'UpdateTopicStep';
  topic: string;
  description: string;
  job: string;
  instructions: string[];
  availableFunctions: unknown[];
};

export type EventStep = {
  type: 'EventStep';
  eventName: string;
  isError: boolean;
  payload: {
    oldTopic: string;
    newTopic: string;
  };
};

export type ReasoningStep = {
  type: 'ReasoningStep';
  reason: string;
};

export type PlannerResponseStep = {
  type: 'PlannerResponseStep';
  message: string;
  responseType: string;
  isContentSafe: boolean;
  safetyScore: {
    safety_score: number;
    category_scores: {
      toxicity: number;
      hate: number;
      identity: number;
      violence: number;
      physical: number;
      sexual: number;
      profanity: number;
      biased: number;
    };
  };
};

export type AgentTraceResponse = {
  actions: Array<{
    id: string;
    state: string;
    returnValue: {
      type: string;
      planId: string;
      sessionId: string;
      intent: string;
      topic: string;
      plan: AgentTraceStep[];
    };
    error: unknown[];
  }>;
};

export type CompileAgentResponse = AgentCompilationSuccess | AgentCompilationError;

export type PublishAgentJsonResponse = {
  botVersionId: string;
  botId: string;
  errorMessage?: string;
};

export type PublishAgent = PublishAgentJsonResponse & { developerName: string };
export type AgentCompilationError = {
  status: 'failure';
  compiledArtifact: null;
  errors: Array<{
    errorType: string;
    description: string;
    lineStart: number;
    lineEnd: number;
    colStart: number;
    colEnd: number;
  }>;
  syntacticMap: {
    blocks: [];
  };
  dslVersion: '0.0.3.rc29';
};

export type AgentCompilationSuccess = {
  status: 'success';
  compiledArtifact: AgentJson;
  errors: [];
  syntacticMap: {
    blocks: [];
  };
  dslVersion: '0.0.3.rc29';
};

export type AgentJson = {
  schemaVersion: string;
  globalConfiguration: {
    developerName: string;
    label: string;
    description: string;
    enableEnhancedEventLogs: boolean;
    agentType: string;
    templateName: string;
    defaultAgentUser: string;
    defaultOutboundRouting: string;
    contextVariables: [];
  };
  agentVersion: {
    developerName: string;
    plannerType: string;
    systemMessages: [];
    modalityParameters: {
      voice: {
        inboundModel: null;
        inboundFillerWordsDetection: null;
        outboundVoice: null;
        outboundModel: null;
        outboundSpeed: null;
        outboundStyleExaggeration: null;
      };
      language: {
        defaultLocale: 'en_US';
        additionalLocales: [];
        allAdditionalLocales: boolean;
      };
    };
    additionalParameters: boolean;
    company: string;
    role: string;
    stateVariables: Array<{
      developerName: string;
      label: string;
      description: string;
      dataType: 'string';
      isList: boolean;
      default: boolean;
      visibility: 'Internal';
    }>;
    initialNode: string;
    nodes: Array<{
      type: string;
      reasoningType: string;
      description: string;
      beforeReasoning: string;
      instructions: string;
      focusPrompt: string;
      tools: [];
      preToolCall: null;
      postToolCall: null;
      afterReasoning: null;
      developerName: string;
      label: string;
      onInit: null;
      transitions: null;
      onExit: null;
      actionDefinitions: [];
    }>;
    knowledgeDefinitions: null;
  };
};

export type AgentString = string;

export type FindLocalAgentsFunction = (dir: string) => string[];

export type NamedUserJwtResponse = {
  access_token: string;
  token_format: 'jwt';
  scope: string;
  token_type: 'Bearer';
  issued_at: number;
  api_instance_url: string;
};
