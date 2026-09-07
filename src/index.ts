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

export {
  // Agent Runner Types
  type BaseAgentConfig,
  type AgentPreviewStartResponse,
  type AgentPreviewSendResponse,
  type AgentPreviewEndResponse,
  type EndReason,
  type ApiStatus,
  type AgentJson,
  type AgentCompilationSuccess,

  // Agent Creation Types
  type AgentScriptContent,
  type AgentCreateConfig,
  type AgentCreateResponse,
  type AgentJobSpec,
  type AgentJobSpecCreateConfig,
  type AgentOptions,
  type AgentTone,
  type AgentType,
  type BotMetadata,
  type BotVersionMetadata,
  type PreviewableAgent,
  type CompilationError,
  type DraftAgentTopics,
  type DraftAgentTopicsBody,
  type DraftAgentTopicsResponse,
  type AvailableDefinition,

  // Agent Preview Types
  type AgentPreviewMessageLinks,
  type AgentPreviewMessage,
  type AgentPreviewError,
  type AgentPreviewStartOptions,
  type ContextVariable,
  AgentSource,
  type ScriptAgentType,
  type ProductionAgentType,

  // Agent Testing Types
  type AgentTestResultsResponse,
  type AgentTestStartResponse,
  type AgentTestStatusResponse,
  type TestCaseResult,
  type TestStatus,
  type AgentTestConfig,
  type TestCase,
  type TestSpec,
  type MetadataMetric,
  type MetadataExpectation,
  type MetadataCustomEvaluation,
  type AiEvaluationDefinition,

  // NGT (Agentforce Studio) Authoring + Metadata Types
  type NgtTestSpec,
  type NgtTestCase,
  type NgtTestCaseInput,
  type NgtTestCaseScorer,
  type NgtContextVar,
  type NgtConversationTurn,
  type NgtPromptTestCase,
  type NgtPromptInputSet,
  type NgtPromptTestCaseInput,
  type AiTestingDefinition,
  type AiTestCase,
  type AiTestCaseInputXml,
  type AiTestCaseScorer,
  type AiConversationTurnXml,
  type AiPromptTestCase,
  type AiTestCasePromptInputXml,

  // Agentforce Studio Testing Types
  type AgentforceStudioTestStartResponse,
  type AgentforceStudioTestStatusResponse,
  type AgentforceStudioTestResultsResponse,
  type TestScorerResult,
  type AgentforceStudioTestCaseResult,

  // Agent Trace Types
  type AgentTraceResponse,
  type AgentTraceStep,
  type PlannerResponse,
  type PlanStep,
  type UserInputStep,
  type LLMExecutionStep,
  type UpdateTopicStep,
  type EventStep,
  type FunctionStep,
  type ReasoningStep,
  type PlannerResponseStep,

  // Compilation API exit codes (CLI contract)
  COMPILATION_API_EXIT_CODES,
} from './types';

export {
  metric,
  findAuthoringBundle,
  readTranscriptEntries,
  determineTestRunner,
  detectTestRunnerFromId,
  type TestRunnerType,
  createPreviewSessionCache,
  validatePreviewSession,
  removePreviewSessionCache,
  getCachedPreviewSessionIds,
  getCurrentPreviewSessionId,
  listCachedPreviewSessions,
  listSessionTraces,
  readSessionTrace,
  readTurnIndex,
  type TraceFileInfo,
  type TurnIndex,
  type TurnIndexEntry,
  type SessionType,
  type PreviewSessionMeta,
  type CachedPreviewSessionInfo,
  type CachedPreviewSessionEntry,
} from './utils';
export { Agent, AgentCreateLifecycleStages, type AgentInstance } from './agent';
export { AgentTester } from './agentTester';
export { AgentforceStudioTester, normalizeAgentforceStudioResults } from './agentforceStudioTester';
export { createAgentTester, type CreateAgentTesterOptions, type CreateAgentTesterResult } from './agentTesterFactory';
export {
  type NgtScorerName,
  type KnownNgtScorerName,
  type NgtScorerGrade,
  type NgtScorerEntry,
  NgtScorerCatalog,
  isNgtScorerName,
} from './ngtScorerCatalog';
export {
  AgentTest,
  AgentTestCreateLifecycleStages,
  validateNgtSpec,
  convertToTestingMetadata,
  convertToNgtSpec,
  buildTestingMetadataXml,
  parseNgtMetadataXml,
} from './agentTest';
export { ProductionAgent } from './agents/productionAgent';
export { ScriptAgent } from './agents/scriptAgent';
export { AgentBase } from './agents/agentBase';
export { convertTestResultsToFormat, humanFriendlyName } from './agentTestResults';
export { writeDebugLog } from './apexUtils';
export {
  applyStringReplacements,
  applyStringReplacementsToAgent,
  type ReplacementConfig,
  type ReplacementResult,
} from './stringReplacements';
export {
  normalizePayload,
  normalizeMcpShorthand,
  autoCorrectFields,
  normalizeCamelCase,
  normalizeEvaluatorFields,
  convertShorthandRefs,
  injectDefaults,
  stripUnrecognizedFields,
  splitIntoBatches,
  type EvalPayload,
  type EvalTest,
  type EvalStep,
} from './evalNormalizer';
export {
  formatResults,
  type EvalApiResponse,
  type EvalOutput,
  type EvalResult,
  type TestError,
  type TestResult,
  type ResultFormat,
} from './evalFormatter';
export { isYamlTestSpec, parseTestSpec, translateTestSpec, translateTestCase } from './yamlSpecTranslator';
export { resolveAgent, executeBatches, buildResultSummary, type AgentEvalRunResult } from './agentEvalRunner';
export { AgentDataLibrary } from './agentDataLibrary';
export {
  type DataLibrarySummary,
  type DataLibraryDetail,
  type IndexingStatusResponse,
  type CreateLibraryInput,
  type UpdateLibraryInput,
  type UploadResult,
  type FileAddResult,
  type GroundingFileRef,
  type GroundingSource,
  type StageDetail,
  type SourceType,
  type RetrieverDetail,
  type RetrieverActionDetail,
  type StageArtifact,
  type FileListResponse,
} from './dataLibraryTypes';
export {
  // Authoring model + shared vocabulary
  type ScorerSpec,
  type ScorerInputScope,
  type ScorerEngineType,
  type ScorerStatus,
  type ScorerOutcomeType,
  type OutputEnumValue,
  type AgentAssociation,
  type ScorerCreateResult,
  type SupportedLightningType,
  MAX_ENUM_VALUES,
  SCORER_API_NAME_MAX_LENGTH,
  SCORER_API_NAME_PATTERN,
  SCORER_INPUT_SCOPES,
  SCORER_ENGINE_TYPES,
  SCORER_STATUSES,
  SCORER_OUTCOME_TYPES,
  SUPPORTED_LIGHTNING_TYPES,
  isValidScorerApiName,
  labelToApiName,
  validateScorerSpec,
  buildDefaultPromptContent,
  buildScorerXml,
  buildPromptTemplateXml,
  parseScorerXml,
  createScorerDefinition,
  loadScorerSpec,

  // STDM session model scorer input (the `Input:Session` value shape)
  type SessionView,
  type SessionStateView,
  type ActorView,
  type MetricsView,
  type MessageView,
  type StepView,
  type AgentLoopView,
  type RunView,

  // Running a scorer
  runScorer,
  type ScorerEngine,
  type EngineRunInput,
  type ScorerResult,
  registerEngine,
  getEngine,
  supportedEngineTypes,
} from './agentScorer';
export { SCORER_SPEC_JSON_SCHEMA, scorerSpecJsonSchema } from './agentScorers/scorerSpecSchema';
export { SESSION_VIEW_JSON_SCHEMA, sessionViewJsonSchema } from './agentScorers/sessionViewSchema';
export { ApiCatalog } from './apiCatalog';
export {
  type McpServerType,
  type McpAuthType,
  type McpAssetKind,
  type McpConnectionStatus,
  type McpServerStatusFilter,
  type McpServerAuthorizationOutput,
  type McpServerAuthorizationInput,
  type McpServerOutput,
  type McpServerCollection,
  type McpServerCreateInput,
  type McpServerUpdateInput,
  type McpFetchedAsset,
  type McpServerCreateOutput,
  type McpServerFetchOutput,
  type McpServerAssetOutput,
  type McpServerAssetCollection,
  type McpServerAssetReplaceItem,
  type McpServerAssetReplaceInput,
  type ListMcpServersOptions,
} from './apiCatalogTypes';
