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

import { Connection, Logger, SfProject } from '@salesforce/core';
import { FileProperties } from '@salesforce/source-deploy-retrieve';
import { type ApexLog } from '@salesforce/types/tooling';
import { metric } from './utils';
import type { NgtScorerName } from './ngtScorerCatalog';
import type { CltScorerName } from './cltScorerCatalog';

// ====================================================
//     Compilation API exit codes
// ====================================================
/**
 * Exit codes set on SfError when compile() fails due to server HTTP errors.
 * Used by CLI (e.g. agent validate authoring-bundle) for scripting.
 */
export const COMPILATION_API_EXIT_CODES = {
  /** Validation/compilation API returned 404 (e.g. endpoint not available) */
  NOT_FOUND: 2,
  /** Validation/compilation API returned 500 (server error) */
  SERVER_ERROR: 3,
} as const;

// ====================================================
//               Agent Runner Types
// ====================================================
/**
 * Common preview interface that both ScriptAgent and ProductionAgent implement
 */
export type AgentPreviewInterface = {
  start: (...args: unknown[]) => Promise<AgentPreviewStartResponse>;
  send: (message: string) => Promise<AgentPreviewSendResponse>;
  getAllTraces: () => Promise<PlannerResponse[]>;
  end: (...args: unknown[]) => Promise<AgentPreviewEndResponse>;
  saveSession: (outputDir?: string) => Promise<string>;
  setApexDebugging: (apexDebugging: boolean) => void;
};

// The `type` discriminator for a ContextVariable, matching the preview API's
// `Variable.type` enum (agent-api v1.1 OpenAPI schema `Variable`).
export type ContextVariableType = 'Text' | 'Date' | 'DateTime' | 'Money' | 'Ref' | 'Boolean' | 'Number' | 'Object' | 'List' | 'Json';

/**
 * A context/custom variable sent when starting a preview session or a message.
 *
 * This mirrors the preview API's polymorphic `Variable` schema: the JSON type of
 * `value` is determined by `type`. Boolean values are booleans, Number values are
 * numbers, Object/List values are arrays, and Json is any JSON object. Sending a
 * boolean as the string "True" (the old behavior) leaves a boolean-gated route
 * closed, because the runtime compares "True" (Text) against True (Boolean).
 *
 * `value` is optional and nullable to match the API, where only `name` and `type`
 * are required.
 */
export type ContextVariable =
  | { name: string; type: 'Boolean'; value?: boolean | null }
  | { name: string; type: 'Number'; value?: number | null }
  | { name: string; type: 'Text' | 'Date' | 'DateTime' | 'Money' | 'Ref'; value?: string | null }
  | { name: string; type: 'Object'; value?: ContextVariable[] | null }
  | { name: string; type: 'List'; value?: Array<Record<string, unknown>> | null }
  | { name: string; type: 'Json'; value?: Record<string, unknown> | null };

export type AgentPreviewStartOptions = {
  contextVariables?: ContextVariable[];
};

/**
 * Session metadata type
 */
export type PreviewMetadata = {
  sessionId: string;
  agentId: string;
  startTime: string;
  endTime?: string;
  apexDebugging?: boolean;
  mockMode?: 'Mock' | 'Live Test';
  planIds: string[];
};

export type BaseAgentConfig = {
  connection: Connection;
  logger?: Logger;
};

// ====================================================
//               Agent Creation Types
// ====================================================
/**
 * Options for creating instances of agents from an org.
 */

export type AgentOptions = ScriptAgentOptions | ProductionAgentOptions;
export type ScriptAgentOptions = {
  connection: Connection;
  project: SfProject;
  // name of the AAB, e.g. 'myBundle' - the project will be searched to find the AAB directory
  aabName: string;
  // pre-compiled AgentJSON; when provided, skips the compile step during preview
  agentJson?: AgentJson;
};
export type ProductionAgentOptions = {
  connection: Connection;
  project: SfProject;
  apiNameOrId: string;
};

/**
 * Represents an agent available for preview, either from the org or from a local script file
 */
export type PreviewableAgent = {
  name: string;
  source: AgentSource;
  id?: string; // Bot ID for org agents
  developerName?: string; // Developer name for org agents
  aabName?: string; // Name of the AAB for script agents
  label?: string; // MasterLabel for org agents
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

export type ExtendedAgentJobSpec = AgentJobSpec & {
  developerName: string;
  name: string;
};

export type AgentType = 'customer' | 'internal' | 'AGENT';

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
 * The response from the API call to create an AgentScript.
 */
export type CreateAgentScriptResponse = {
  isSuccess: boolean;
  errorMessage?: string;
  agentScriptContent?: AgentScriptContent;
};

// ====================================================
//               Agent Testing Types
// ====================================================
export type AgentTestConfig = {
  /**
   * The API name of an AiEvaluationDefinition or AiTestingDefinition.
   */
  name?: string;

  /**
   * The local file path of an AiEvaluationDefinition or AiTestingDefinition metadata file.
   */
  mdPath?: string;

  /**
   * The local file path of an agent test spec file (legacy YAML or NGT YAML).
   */
  specPath?: string;

  /**
   * The agent test spec data (legacy `TestSpec` or NGT `NgtTestSpec`).
   */
  specData?: TestSpec | NgtTestSpec;
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

// ====================================================
//         Agent Testing Types (Agentforce Studio)
// ====================================================

export type AgentforceStudioTestStartResponse = {
  runId: string;
  status: AgentforceStudioTestStatus;
};

export type AgentforceStudioTestStatus = 'CREATED' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'TERMINATED';

export type AgentforceStudioTestStatusResponse = {
  status: string;
  startTime: string;
  endTime?: string;
  errorMessage?: string;
};

export type TestScorerResult = {
  scorerName: string;
  scorerResponse: string;
};

export type AgentforceStudioTestCaseResult = {
  subjectResponse: string;
  testNumber: number;
  testScorerResults: TestScorerResult[];
};

export type AgentforceStudioTestResultsResponse = {
  status: string;
  testCases: AgentforceStudioTestCaseResult[];
};

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
//    NGT Agent Testing Types (Agentforce Studio)
// ====================================================

// Authoring (YAML) types for NGT specs.

export type NgtContextVar = {
  name: string;
  value: string;
};

export type NgtConversationTurn =
  | { role: 'user'; message: string; index?: number }
  | { role: 'agent'; message: string; topic: string; index?: number };

export type NgtTestCaseInput = {
  utterance: string;
  contextVariables?: NgtContextVar[];
  conversationHistory?: NgtConversationTurn[];
};

export type NgtTestCaseScorer = {
  name: NgtScorerName;
  expected?: string;
};

export type NgtTestCase = {
  inputs: NgtTestCaseInput[];
  scorers: NgtTestCaseScorer[];
};

// PROMPT-subject authoring (YAML) types. One `NgtPromptInputSet` = one template
// invocation (all input slots it needs, filled together); `NgtPromptTestCase.inputs`
// is an array of invocations that fan out 1:1 into XML <testCase> elements sharing
// one scorer set — mirrors AGENT's NgtTestCase.inputs[] fan-out.
export type NgtPromptTestCaseInput = {
  referenceName: string;
  value: string;
};

export type NgtPromptInputSet = {
  promptInput: NgtPromptTestCaseInput[];
};

export type NgtPromptTestCase = {
  inputs: NgtPromptInputSet[];
  scorers: NgtTestCaseScorer[];
};

export type NgtTestSpec =
  | {
      name: string;
      description?: string;
      subjectType: 'AGENT';
      subjectName: string;
      subjectVersion?: string;
      testCases: NgtTestCase[];
    }
  | {
      name: string;
      description?: string;
      subjectType: 'PROMPT';
      subjectName: string;
      subjectVersion?: string;
      testCases: NgtPromptTestCase[];
    };

// ====================================================
//    Conversation-Level Test (CLT) Types
// ====================================================

// Authoring (YAML) types for CLT specs. A spec is CLT when `testScope` is `CONVERSATION_LEVEL`.

export type AiTestScope = 'TURN_LEVEL' | 'CONVERSATION_LEVEL';

/** Simulated-user persona (Core `ConversationPersonas`). */
export type ConversationPersona = 'DEFAULT' | 'FRUSTRATED' | 'DISTRACTED_DAD' | 'ACCENT';

/** Saved-suite evaluation mode. Not accepted when running without saving. */
export type ConversationEvaluationMode = 'TEXT' | 'TEXT_VOICE';

/** A draft (not yet published) agent, identified by its project and project version. */
export type CltProject = {
  projectId: string;
  projectVersionId: string;
};

export type CltTestCaseScorer = {
  name: CltScorerName;
  expected?: string;
};

export type CltConnections = {
  /** One of the agent's connection types, for example `Messaging`. */
  surfaceType: string;
};

export type CltTestCase = {
  conversationGoal: string;
  contextVariables?: NgtContextVar[];
  connections?: CltConnections;
  /** Omit to score with `task_resolution` only (the server default). */
  scorers?: CltTestCaseScorer[];
};

export type CltSimulation = {
  enabled?: boolean;
  excludedActions?: Array<{ subagent: string; actions: string[] }>;
};

export type CltTestSpec = {
  name: string;
  description?: string;
  testScope: 'CONVERSATION_LEVEL';
  subjectType?: 'AGENT';
  /** Published agent API name. Exactly one of `subjectName` or `project`. */
  subjectName?: string;
  subjectVersion?: string;
  /** Draft agent. Exactly one of `subjectName` or `project`. */
  project?: CltProject;
  /** Case-insensitive; sent upper-case. */
  persona?: ConversationPersona | Lowercase<ConversationPersona>;
  /** One limit for the whole suite. */
  maxTurns?: number;
  evaluationMode?: ConversationEvaluationMode;
  simulation?: CltSimulation;
  testCases: CltTestCase[];
};

// Request (API) types the CLT converters produce. Field names match the Connect API inputs.

/** Agent identity sent to the conversation-test endpoints, after `subjectName` is resolved. */
export type ConversationAgentTarget =
  | { agentId: string; agentVersionId: string }
  | { projectId: string; projectVersionId: string };

export type ConversationTestScorerInput = {
  name: string;
  expectedValue?: string;
};

export type ConversationTestCaseInput = {
  number: number;
  maxTurns?: number;
  conversationGoal: string;
  contextVariables?: Array<{ variableName: string; variableValue: string }>;
  connections?: { surfaceConfig: { surfaceType: string } };
  scorers?: ConversationTestScorerInput[];
};

export type ConversationPreviewConfig = {
  excludedActionsFromSimulate: Array<{ subagent: string; actions: Array<{ name: string }> }>;
};

/** Body for `POST conversation-tests/ephemeral-run` (run without saving). */
export type EphemeralConversationTestInput = ConversationAgentTarget & {
  testCases: ConversationTestCaseInput[];
  persona?: ConversationPersona;
  maxTurns?: number;
  enableSimulationMode?: boolean;
  previewConfig?: ConversationPreviewConfig;
};

/** Body for `POST conversation-test-suites/create-and-run` (save the suite, then run it). */
export type CreateAndRunConversationTestSuiteInput = ConversationAgentTarget & {
  name: string;
  description?: string;
  evaluationMode?: ConversationEvaluationMode;
  persona?: ConversationPersona;
  testCases: ConversationTestCaseInput[];
  enableSimulationMode?: boolean;
  previewConfig?: ConversationPreviewConfig;
};

// Metadata (XML) types for AiTestingDefinition.

export type AiConversationTurnXml =
  | { role: 'user'; message: string; index: number }
  | { role: 'agent'; message: string; topic: string; index: number };

export type AiTestCaseInputXml = {
  utterance: string;
  contextVariable?: Array<{ variableName: string; variableValue: string }>;
  conversationHistory?: AiConversationTurnXml[];
};

export type AiTestCaseScorer = {
  name: NgtScorerName;
  expectedValue?: string;
  // 'Custom' reserved for the future, converter never emits it for v1.
  scorerType?: 'OOTB' | 'Custom';
};

export type AiTestCase = {
  number: number;
  inputs: AiTestCaseInputXml;
  scorer: AiTestCaseScorer[];
};

// PROMPT-subject metadata (XML) types. `AiTestCasePromptInputXml` maps to the
// `<inputs>` element of one <testCase>; `promptInput` is its repeatable child.
export type AiTestCasePromptInputXml = {
  promptInput: Array<{ referenceName: string; value: string }>;
};

export type AiPromptTestCase = {
  number: number;
  inputs: AiTestCasePromptInputXml;
  scorer: AiTestCaseScorer[];
};

export type AiTestingDefinition =
  | {
      description?: string;
      name: string;
      subjectName: string;
      subjectType: 'AGENT';
      subjectVersion?: string;
      testCase: AiTestCase[];
    }
  | {
      description?: string;
      name: string;
      subjectName: string;
      subjectType: 'PROMPT';
      subjectVersion?: string;
      testCase: AiPromptTestCase[];
    };

// ====================================================
//               Agent Preview Types
// ====================================================
export type ApiStatus = {
  status: 'UP' | 'DOWN';
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

export type AgentPreviewMessageLinks = {
  self: Href | null;
  messages: Href | null;
  session: Href | null;
  end: Href | null;
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

// ====================================================
//               Agent Plan Response Types
// ====================================================

export type PlannerResponse = {
  type: 'PlanSuccessResponse';
  planId: string;
  sessionId: string;
  intent: string;
  topic: string;
  plan: PlanStep[];
};

export type PlanStep =
  | UserInputStep
  | LLMExecutionStep
  | UpdateTopicStep
  | EventStep
  | FunctionStep
  | PlannerResponseStep;

export type FunctionStep = {
  type: 'FunctionStep';
  function: {
    name: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  };
  executionLatency: number;
  startExecutionTime: number;
  endExecutionTime: number;
};

export type CompileAgentScriptResponse = AgentCompilationSuccess | AgentCompilationError;

export type AgentCompilationSuccess = {
  status: 'success';
  compiledArtifact: AgentJson;
  errors: [];
  syntacticMap: {
    blocks: [];
  };
  dslVersion: '0.0.3.rc29';
};
export type AgentCompilationError = {
  status: 'failure';
  compiledArtifact: null;
  errors: CompilationError[];
  syntacticMap: {
    blocks: [];
  };
  dslVersion: '0.0.3.rc29';
};

export type CompilationError = {
  errorType: string;
  description: string;
  lineStart: number;
  lineEnd: number;
  colStart: number;
  colEnd: number;
};

export type PublishAgentJsonResponse = {
  botVersionId: string;
  botId: string;
  errorMessage?: string;
};

export type PublishAgent = PublishAgentJsonResponse & { developerName: string };

/**
 * Set as `data.publishedAgent` on an error thrown after the publish POST already committed a new
 * BotVersion (for example, a failed metadata retrieve or authoring bundle deploy). Its presence
 * means the version exists in the org, so the caller must not publish again.
 *
 * The reverse doesn't hold: a missing `data.publishedAgent` doesn't prove that nothing was committed.
 * If the publish POST itself times out or returns a gateway error, Core may still have created the
 * BotVersion. Re-query the agent's latest BotVersion before retrying in that case.
 */
export type PublishedAgentInfo = {
  developerName: string;
  botId: string;
  botVersionId: string;
  /** Absent when the BotVersion lookup itself is the step that failed. */
  versionNumber?: number;
  /**
   * The `<target>` value (`<agentDeveloperName>.<botVersionDeveloperName>`) the authoring bundle's
   * bundle-meta.xml needs to be deployed against this version. Absent when the BotVersion lookup failed.
   */
  target?: string;
  /** The post-commit step that threw. */
  failedStep: 'botVersionLookup' | 'retrieve' | 'bundleDeploy';
};

export type PublishOptions = {
  /** Where the agent came from ("Bot" for a converted Einstein Bot). Sent on the first publish only. */
  sourceType?: 'Bot';
};

// This is not accurate but good enough for now
export type AgentJson = {
  schemaVersion: string;
  globalConfiguration: {
    developerName: string;
    label: string;
    description: string;
    enableEnhancedEventLogs: boolean;
    agentType: string;
    templateName: string;
    // Optional: a compiled authoring bundle may not configure a default agent user.
    defaultAgentUser?: string;
    // Optional: "Bot" when the agent was converted from an Einstein Bot. Core sets BotDefinition.BotSource from it on create.
    botSource?: 'Bot';
    defaultOutboundRouting: string;
    contextVariables: [];
  };
  agentVersion: {
    developerName: string | null;
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
      // Optional: delegation node types (e.g. `related_agent`) compile with no `tools`.
      tools?: Array<{
        type: string;
        target: string | null;
        boundInputs: unknown;
        llmInputs: unknown;
        enabled: boolean | null;
        stateUpdates: Array<Record<string, string>> | null;
        name: string;
        description: string;
        inputParameters: unknown;
        forced: boolean | null;
      }>;
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

export type AgentScriptContent = string;

export enum AgentSource {
  PUBLISHED = 'published',
  SCRIPT = 'script',
}

export type ScriptAgentType = { DeveloperName: string; source: AgentSource.SCRIPT; path: string };
export type ProductionAgentType = {
  Id: string;
  DeveloperName: string;
  source: AgentSource.PUBLISHED;
};

export type NamedUserJwtResponse = {
  access_token: string;
  token_format: 'jwt';
  scope: string;
  token_type: 'Bearer';
  issued_at: number;
  api_instance_url: string;
};

// Response types for the conversation-test endpoints (`ConversationTester`).

/** Body of a run's results: ephemeral-run, and `runs/{runId}/results` for a saved suite. */
export type ConversationTestResultsResponse = {
  /** ephemeral-run sends `Completed` or `Failed`; saved runs use the run status (`SUCCESS`, `FAILED`, ...). */
  status: string;
  errorRepresentation?: { errorCode?: string; errorMessage?: string; retryable?: boolean };
  /** Omitted until the run is complete. */
  summary?: {
    totalNumberOfTestCases?: number;
    taskResolutionPassPercent?: number;
    acceptanceCriteriaPassPercent?: number;
  } & Record<string, number | undefined>;
  testCases: ConversationTestCaseResult[];
};

export type ConversationTestCaseResult = {
  /** The 1-based `number` sent in the request. */
  testNumber: number;
  /** Saved suites only. */
  testCaseId?: string;
  /** JSON string: the simulated conversation (turns, topics, actions, completion reason). */
  subjectResponse?: string;
  testScorerResults?: Array<{ scorerName: string; scorerResponse?: string }>;
};

/** A scorer's result, read from its JSON-string `scorerResponse` by `parseConversationScorerResponse`. */
export type ConversationScorerOutcome = {
  /** For example `PASS`, `FAIL` or `ERROR`. */
  status?: string;
  score?: number | string;
  reasoning?: string;
};

/** Body returned by `POST conversation-test-suites/create-and-run`. */
export type CreateAndRunConversationTestSuiteResponse = {
  status: string;
  /** The saved suite (1W4). */
  testSuiteId: string;
  /** The run that was started (3A2). Poll it with `AgentforceStudioTester`. */
  runId: string;
  statusMessage?: string;
};
