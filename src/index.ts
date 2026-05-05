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

  // Agentforce Studio Testing Types
  type AgentforceStudioTestStartResponse,
  type AgentforceStudioTestStatusResponse,
  type AgentforceStudioTestResultsResponse,
  type TestScorerResult,
  type AgentforceStudioTestCaseResult,

  // Agent Trace Types
  type AgentTraceResponse,
  type AgentTraceStep,
  type UserInputStep,
  type LLMExecutionStep,
  type UpdateTopicStep,
  type EventStep,
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
  type SessionType,
  type PreviewSessionMeta,
  type CachedPreviewSessionInfo,
  type CachedPreviewSessionEntry,
} from './utils';
export { Agent, AgentCreateLifecycleStages, type AgentInstance } from './agent';
export { AgentTester } from './agentTester';
export { AgentforceStudioTester, normalizeAgentforceStudioResults } from './agentforceStudioTester';
export { createAgentTester, type CreateAgentTesterOptions, type CreateAgentTesterResult } from './agentTesterFactory';
export { AgentTest, AgentTestCreateLifecycleStages } from './agentTest';
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
export { formatResults, type EvalApiResponse, type ResultFormat } from './evalFormatter';
export {
  isYamlTestSpec,
  parseTestSpec,
  translateTestSpec,
  translateTestCase,
} from './yamlSpecTranslator';
export {
  resolveAgent,
  executeBatches,
  buildResultSummary,
  type AgentEvalRunResult,
} from './agentEvalRunner';
