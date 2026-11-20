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

import { Lifecycle, Messages, SfError } from '@salesforce/core';
import type {
  CltTestCase,
  CltTestSpec,
  ConversationAgentTarget,
  ConversationPersona,
  ConversationPreviewConfig,
  ConversationTestCaseInput,
  CreateAndRunConversationTestSuiteInput,
  EphemeralConversationTestInput,
} from './types.js';
import { CltScorerCatalog, isCltScorerName } from './cltScorerCatalog';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'cltSpec');

/**
 * Where a CLT spec is headed. Limits and the allowed scorers differ:
 * - `ephemeral`: `conversation-tests/ephemeral-run`, run without saving.
 * - `saved`: `conversation-test-suites/create-and-run`, saved as a suite and then run.
 */
export type CltRunTarget = 'ephemeral' | 'saved';

/** Personas Core accepts (`ConversationPersonas`). Matched case-insensitively, sent upper-case. */
export const CLT_PERSONAS: readonly ConversationPersona[] = ['DEFAULT', 'FRUSTRATED', 'DISTRACTED_DAD', 'ACCENT'];

/**
 * Most turns (simulated-user message + agent reply) in one conversation.
 * - ephemeral: Core rejects values outside 1–30 (default 15).
 * - saved: Core rejects only values below 1; Platform Metabolism runs anything over 100 as 100.
 *
 * The CLI rejects values over 100 rather than run a different limit than the user wrote.
 */
export const CLT_MAX_TURNS: Readonly<Record<CltRunTarget, number>> = { ephemeral: 30, saved: 100 };

const EVALUATION_MODES = ['TEXT', 'TEXT_VOICE'];
const CONTEXT_PREFIX = '$Context.';

const SPEC_FIELDS = [
  'name',
  'description',
  'testScope',
  'subjectType',
  'subjectName',
  'subjectVersion',
  'project',
  'persona',
  'maxTurns',
  'evaluationMode',
  'simulation',
  'testCases',
];
const TEST_CASE_FIELDS = ['conversationGoal', 'contextVariables', 'connections', 'scorers'];
const TURN_LEVEL_FIELDS = ['inputs', 'utterance', 'conversationHistory'];
const SCORER_FIELDS = ['name', 'expected'];
const CONTEXT_VARIABLE_FIELDS = ['name', 'value'];
const CONNECTIONS_FIELDS = ['surfaceType'];
const PROJECT_FIELDS = ['projectId', 'projectVersionId'];
const SIMULATION_FIELDS = ['enabled', 'excludedActions'];
const EXCLUDED_ACTION_FIELDS = ['subagent', 'actions'];

/** True when a parsed YAML spec is a conversation-level test spec (`testScope: CONVERSATION_LEVEL`). */
export const isCltSpec = (spec: unknown): spec is CltTestSpec =>
  isRecord(spec) && spec.testScope === 'CONVERSATION_LEVEL';

/**
 * Validate a conversation-level test spec before any API call.
 *
 * The rules mirror Core's create-and-run and ephemeral-run validation so users get a clear local
 * error instead of a server 400. Throws on the first failure. Unknown fields are errors, so a typo
 * can't be silently dropped. Unknown scorer names only warn: Core is the authoritative scorer gate.
 *
 * @param spec - The parsed YAML spec.
 * @param ctx.target - `ephemeral` (run without saving) or `saved` (create-and-run).
 */
export const validateCltSpec = (spec: CltTestSpec, ctx: { target: CltRunTarget }): void => {
  const raw: unknown = spec;
  if (!isRecord(raw)) {
    throw cltError('cltMissingTestCases');
  }
  if (raw.testScope !== 'CONVERSATION_LEVEL') {
    throw cltError('cltWrongTestScope', [display(raw.testScope)]);
  }
  rejectUnknownFields(raw, SPEC_FIELDS, 'spec');

  if (!isNonBlankString(raw.name)) {
    throw cltError('cltMissingName');
  }
  if (raw.subjectType !== undefined && raw.subjectType !== 'AGENT') {
    throw cltError('cltUnsupportedSubjectType', [display(raw.subjectType)]);
  }
  validateAgentIdentity(raw);
  validateSuiteSettings(raw, ctx.target);

  if (!Array.isArray(raw.testCases) || raw.testCases.length === 0) {
    throw cltError('cltMissingTestCases');
  }
  raw.testCases.forEach((testCase: unknown, tcIdx) => validateTestCase(testCase, tcIdx + 1, ctx.target));
};

/**
 * Convert a validated CLT spec to the `conversation-tests/ephemeral-run` body (run without saving).
 *
 * Must be called after `validateCltSpec` with `target: 'ephemeral'`. `evaluationMode` isn't sent:
 * the endpoint doesn't accept it.
 *
 * @param spec - The validated spec.
 * @param agent - The resolved `agentId` and `agentVersionId` when the spec names a published agent
 * (`subjectName`). Ignored when the spec has `project`.
 */
export const cltSpecToEphemeralInput = (
  spec: CltTestSpec,
  agent?: { agentId: string; agentVersionId: string }
): EphemeralConversationTestInput => ({
  ...agentTarget(spec, agent),
  testCases: spec.testCases.map((testCase, idx) => toTestCaseInput(testCase, idx)),
  ...(spec.persona ? { persona: normalizePersona(spec.persona) } : {}),
  ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
  ...simulationFields(spec),
});

/**
 * Convert a validated CLT spec to the `conversation-test-suites/create-and-run` body (save, then run).
 *
 * Must be called after `validateCltSpec` with `target: 'saved'`. The suite-level `maxTurns` is copied
 * to every test case, because Core reads it per case and requires the same value on all of them.
 *
 * @param spec - The validated spec.
 * @param agent - The resolved `agentId` and `agentVersionId` when the spec names a published agent
 * (`subjectName`). Ignored when the spec has `project`.
 */
export const cltSpecToCreateAndRunInput = (
  spec: CltTestSpec,
  agent?: { agentId: string; agentVersionId: string }
): CreateAndRunConversationTestSuiteInput => ({
  ...agentTarget(spec, agent),
  name: spec.name,
  ...(spec.description ? { description: spec.description } : {}),
  ...(spec.evaluationMode ? { evaluationMode: spec.evaluationMode } : {}),
  ...(spec.persona ? { persona: normalizePersona(spec.persona) } : {}),
  testCases: spec.testCases.map((testCase, idx) => ({
    ...toTestCaseInput(testCase, idx),
    ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
  })),
  ...simulationFields(spec),
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const validateAgentIdentity = (raw: Record<string, unknown>): void => {
  const hasSubject = isNonBlankString(raw.subjectName);
  const hasProject = raw.project !== undefined;
  if (hasSubject === hasProject) {
    throw cltError('cltAgentIdentity');
  }
  if (!hasProject) {
    return;
  }
  if (!isRecord(raw.project)) {
    throw cltError('cltProjectIncomplete');
  }
  rejectUnknownFields(raw.project, PROJECT_FIELDS, 'project');
  if (!isNonBlankString(raw.project.projectId) || !isNonBlankString(raw.project.projectVersionId)) {
    throw cltError('cltProjectIncomplete');
  }
  if (raw.subjectVersion !== undefined) {
    throw cltError('cltSubjectVersionWithProject');
  }
};

const validateSuiteSettings = (raw: Record<string, unknown>, target: CltRunTarget): void => {
  if (raw.persona !== undefined && !CLT_PERSONAS.includes(normalizePersona(raw.persona))) {
    throw cltError('cltInvalidPersona', [display(raw.persona), CLT_PERSONAS.join(', ')]);
  }

  if (raw.evaluationMode !== undefined) {
    if (typeof raw.evaluationMode !== 'string' || !EVALUATION_MODES.includes(raw.evaluationMode)) {
      throw cltError('cltInvalidEvaluationMode', [display(raw.evaluationMode)]);
    }
    if (target === 'ephemeral') {
      void Lifecycle.getInstance().emitWarning(messages.getMessage('cltEvaluationModeIgnored'));
    }
  }

  if (raw.maxTurns !== undefined) {
    const max = CLT_MAX_TURNS[target];
    const turns = raw.maxTurns;
    if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1 || turns > max) {
      throw cltError('cltInvalidMaxTurns', [display(turns), max]);
    }
  }

  if (raw.simulation !== undefined) {
    validateSimulation(raw.simulation);
  }
};

const validateSimulation = (simulation: unknown): void => {
  if (!isRecord(simulation)) {
    throw cltError('cltInvalidSimulation');
  }
  rejectUnknownFields(simulation, SIMULATION_FIELDS, 'simulation');
  if (simulation.enabled !== undefined && typeof simulation.enabled !== 'boolean') {
    throw cltError('cltInvalidSimulation');
  }
  if (simulation.excludedActions === undefined) {
    return;
  }
  if (!Array.isArray(simulation.excludedActions)) {
    throw cltError('cltInvalidSimulation');
  }
  simulation.excludedActions.forEach((entry: unknown) => {
    if (!isRecord(entry)) {
      throw cltError('cltInvalidSimulation');
    }
    rejectUnknownFields(entry, EXCLUDED_ACTION_FIELDS, 'simulation.excludedActions');
    const actions: unknown = entry.actions;
    if (
      !isNonBlankString(entry.subagent) ||
      !Array.isArray(actions) ||
      actions.length === 0 ||
      !actions.every(isNonBlankString)
    ) {
      throw cltError('cltInvalidSimulation');
    }
  });
};

const validateTestCase = (testCase: unknown, caseNumber: number, target: CltRunTarget): void => {
  if (!isRecord(testCase)) {
    throw cltError('cltMissingConversationGoal', [caseNumber]);
  }
  const turnLevelField = TURN_LEVEL_FIELDS.find((field) => field in testCase);
  if (turnLevelField) {
    throw cltError('cltTurnLevelField', [caseNumber, turnLevelField, turnLevelField]);
  }
  rejectUnknownFields(testCase, TEST_CASE_FIELDS, `testCases[${caseNumber}]`);

  if (!isNonBlankString(testCase.conversationGoal)) {
    throw cltError('cltMissingConversationGoal', [caseNumber]);
  }
  validateContextVariables(testCase.contextVariables, caseNumber);
  validateConnections(testCase.connections, caseNumber);
  validateScorers(testCase.scorers, caseNumber, target);
};

const validateContextVariables = (contextVariables: unknown, caseNumber: number): void => {
  if (contextVariables === undefined) {
    return;
  }
  if (!Array.isArray(contextVariables)) {
    throw cltError('cltContextVariableMissingName', [caseNumber]);
  }
  const seen = new Set<string>();
  contextVariables.forEach((cv: unknown) => {
    if (!isRecord(cv)) {
      throw cltError('cltContextVariableMissingName', [caseNumber]);
    }
    rejectUnknownFields(cv, CONTEXT_VARIABLE_FIELDS, `testCases[${caseNumber}].contextVariables`);
    const bare = bareContextVariableName(cv.name);
    if (bare === undefined) {
      throw cltError('cltContextVariableMissingName', [caseNumber]);
    }
    // "ChannelType" and "$Context.ChannelType" name the same variable (Core `ConversationContextVariables`).
    if (seen.has(bare)) {
      throw cltError('cltContextVariableDuplicate', [caseNumber, bare]);
    }
    seen.add(bare);
  });
};

const validateConnections = (connections: unknown, caseNumber: number): void => {
  if (connections === undefined) {
    return;
  }
  if (!isRecord(connections)) {
    throw cltError('cltConnectionsMissingSurfaceType', [caseNumber]);
  }
  rejectUnknownFields(connections, CONNECTIONS_FIELDS, `testCases[${caseNumber}].connections`);
  if (!isNonBlankString(connections.surfaceType)) {
    throw cltError('cltConnectionsMissingSurfaceType', [caseNumber]);
  }
};

const validateScorers = (scorers: unknown, caseNumber: number, target: CltRunTarget): void => {
  // Omitted or empty: Core scores with task_resolution.
  if (scorers === undefined) {
    return;
  }
  if (!Array.isArray(scorers)) {
    throw cltError('cltScorerMissingName', [caseNumber]);
  }
  scorers.forEach((scorer: unknown) => {
    if (!isRecord(scorer)) {
      throw cltError('cltScorerMissingName', [caseNumber]);
    }
    rejectUnknownFields(scorer, SCORER_FIELDS, `testCases[${caseNumber}].scorers`);
    if (!isNonBlankString(scorer.name)) {
      throw cltError('cltScorerMissingName', [caseNumber]);
    }
    const name = scorer.name;
    if (!isCltScorerName(name)) {
      void Lifecycle.getInstance().emitWarning(messages.getMessage('cltUnknownScorerName', [caseNumber, name]));
      return;
    }
    const entry = CltScorerCatalog[name];
    if (entry.needsExpected && !isNonBlankString(scorer.expected)) {
      throw cltError('cltScorerMissingExpected', [name, caseNumber]);
    }
    if (target === 'ephemeral' && !entry.ephemeral) {
      throw cltError('cltScorerNotEphemeral', [name, caseNumber, ephemeralScorerNames().join(', '), name]);
    }
  });
};

const rejectUnknownFields = (value: Record<string, unknown>, allowed: string[], where: string): void => {
  const unknownField = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownField !== undefined) {
    throw cltError('cltUnknownField', [unknownField, where, allowed.join(', ')]);
  }
};

const ephemeralScorerNames = (): string[] =>
  Object.entries(CltScorerCatalog)
    .filter(([, entry]) => entry.ephemeral)
    .map(([name]) => name);

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

const agentTarget = (
  spec: CltTestSpec,
  agent: { agentId: string; agentVersionId: string } | undefined
): ConversationAgentTarget => {
  if (spec.project) {
    return { projectId: spec.project.projectId, projectVersionId: spec.project.projectVersionId };
  }
  if (!agent) {
    throw cltError('cltAgentNotResolved', [String(spec.subjectName)]);
  }
  return { agentId: agent.agentId, agentVersionId: agent.agentVersionId };
};

const toTestCaseInput = (testCase: CltTestCase, idx: number): ConversationTestCaseInput => ({
  number: idx + 1,
  conversationGoal: testCase.conversationGoal,
  ...(testCase.contextVariables?.length
    ? {
        contextVariables: testCase.contextVariables.map((cv) => ({
          variableName: cv.name,
          variableValue: cv.value ?? '',
        })),
      }
    : {}),
  ...(testCase.connections
    ? { connections: { surfaceConfig: { surfaceType: testCase.connections.surfaceType } } }
    : {}),
  ...(testCase.scorers?.length
    ? {
        scorers: testCase.scorers.map((scorer) => ({
          name: scorer.name,
          ...(scorer.expected !== undefined ? { expectedValue: scorer.expected } : {}),
        })),
      }
    : {}),
});

const simulationFields = (
  spec: CltTestSpec
): { enableSimulationMode?: boolean; previewConfig?: ConversationPreviewConfig } => {
  if (!spec.simulation) {
    return {};
  }
  const { enabled, excludedActions } = spec.simulation;
  return {
    ...(enabled !== undefined ? { enableSimulationMode: enabled } : {}),
    ...(excludedActions?.length
      ? {
          previewConfig: {
            excludedActionsFromSimulate: excludedActions.map((entry) => ({
              subagent: entry.subagent,
              actions: entry.actions.map((name) => ({ name })),
            })),
          },
        }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const normalizePersona = (persona: unknown): ConversationPersona =>
  String(persona).trim().toUpperCase() as ConversationPersona;

/** Strips surrounding whitespace and a leading `$Context.`. Returns undefined for a blank name. */
const bareContextVariableName = (name: unknown): string | undefined => {
  if (!isNonBlankString(name)) {
    return undefined;
  }
  let bare = name.trim();
  if (bare.startsWith(CONTEXT_PREFIX)) {
    bare = bare.substring(CONTEXT_PREFIX.length).trim();
  }
  return bare === '' ? undefined : bare;
};

/** Renders a spec value for an error message. Non-strings (numbers, objects from bad YAML) are shown as JSON. */
const display = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonBlankString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const cltError = (key: string, tokens: Array<string | number> = []): SfError =>
  new SfError(messages.getMessage(key, tokens), key);
