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
  EphemeralConversationTestInput,
} from './types';
import {
  type CltRunTarget,
  CltScorerCatalog,
  cltScorersFor,
  type KnownCltScorerName,
  isCltScorerName,
} from './cltScorerCatalog';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'cltSpec');

/** How each target reads in a user-facing message. */
const TARGET_PHRASES: Readonly<Record<CltRunTarget, string>> = {
  ephemeral: 'when running without saving',
  saved: 'in a saved suite',
};

/** Label each scorer key with its Testing Center name, for error messages. */
const withUiLabels = (names: KnownCltScorerName[]): string =>
  names.map((name) => `${name} (${CltScorerCatalog[name].uiLabel})`).join(', ');

/**
 * Personas Core accepts in 264 (`ConversationPersonas`). Matched case-insensitively, sent upper-case.
 * Other values get a warning and are sent as written (upper-cased), so Core decides.
 */
export const CLT_PERSONAS: readonly ConversationPersona[] = ['DEFAULT', 'FRUSTRATED', 'DISTRACTED_DAD', 'ACCENT'];

/**
 * Most turns (simulated-user message + agent reply) in one conversation.
 * - ephemeral: Core rejects values outside 1–30 (default 15).
 * - saved: Core rejects only values below 1; Platform Metabolism runs anything over 100 as 100.
 *
 * A value over the target's limit gets a warning and is sent as written, so a raised Core limit works
 * without a CLI release.
 */
export const CLT_MAX_TURNS: Readonly<Record<CltRunTarget, number>> = { ephemeral: 30, saved: 100 };

/**
 * Most test cases in one spec. Core's saved-suite limit (`getMaxConversationGoalsPerSuite`) is 250. A run
 * without saving allows 10, or 250 with the org's devagentenhancement gate; the CLI can't read the gate, so
 * that lower limit is left to the server. More cases than this get a warning.
 */
export const CLT_MAX_TEST_CASES = 250;

/** Evaluation modes Core accepts in 264. Other values get a warning. */
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
 * Strict about the spec's structure and non-strict about values Core owns, as `validateNgtSpec` is:
 * - Errors (thrown, first failure wins): unknown fields, so a typo can't be silently dropped; wrong
 * YAML shapes and types; missing required values; a missing `expected` on a known scorer that needs
 * one; and `agent_handoff_match`, which Core accepts but scores wrongly.
 * - Warnings (lifecycle `emitWarning`): values Core may change between releases. These are unknown
 * scorers, scorers not supported for this target, unknown `persona` or `evaluationMode` values, `maxTurns`
 * over the target's limit, and more than `CLT_MAX_TEST_CASES` test cases. The spec is sent as written
 * and Core decides; its error comes back through `ConversationTestRejected`.
 *
 * @param spec - The parsed YAML spec. On success it's narrowed to `CltTestSpec`.
 * @param ctx.target - `ephemeral` (run without saving) or `saved` (create-and-run). Only `ephemeral` has a
 * converter today; `saved` keeps the saved-suite limits for the command that will save suites.
 */
export const validateCltSpec: (spec: unknown, ctx: { target: CltRunTarget }) => asserts spec is CltTestSpec = (
  spec,
  ctx
) => {
  const raw = spec;
  if (!isRecord(raw)) {
    throw cltError('cltSpecNotObject');
  }
  if (raw.testScope !== 'CONVERSATION_LEVEL') {
    throw cltError('cltWrongTestScope', [display(raw.testScope)]);
  }
  rejectUnknownFields(raw, SPEC_FIELDS, 'the spec');

  if (!isNonBlankString(raw.name)) {
    throw cltError('cltMissingName');
  }
  rejectNonString(raw, 'description');
  rejectNonString(raw, 'subjectVersion');
  if (raw.subjectType !== undefined && raw.subjectType !== 'AGENT') {
    throw cltError('cltUnsupportedSubjectType', [display(raw.subjectType)]);
  }
  validateAgentIdentity(raw);
  validateSuiteSettings(raw, ctx.target);

  if (raw.testCases !== undefined && !Array.isArray(raw.testCases)) {
    throw shapeError('`testCases`', 'a list', raw.testCases, '- conversationGoal: Return an item.');
  }
  if (!Array.isArray(raw.testCases) || raw.testCases.length === 0) {
    throw cltError('cltMissingTestCases');
  }
  if (raw.testCases.length > CLT_MAX_TEST_CASES) {
    cltWarning('cltTooManyTestCases', [raw.testCases.length, CLT_MAX_TEST_CASES]);
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
 * (`subjectName`). Ignored when the spec has `project`. The converter doesn't read `subjectName` or
 * `subjectVersion`; the caller resolves them to these IDs.
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

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const validateAgentIdentity = (raw: Record<string, unknown>): void => {
  // A blank or non-string subjectName counts as set, so it isn't silently ignored next to `project`.
  const hasSubject = raw.subjectName !== undefined;
  const hasProject = raw.project !== undefined;
  if (hasSubject === hasProject || (hasSubject && !isNonBlankString(raw.subjectName))) {
    throw cltError('cltAgentIdentity');
  }
  if (!hasProject) {
    return;
  }
  if (!isRecord(raw.project)) {
    throw shapeError('`project`', 'a mapping', raw.project, 'project: { projectId: 1bY..., projectVersionId: 1bZ... }');
  }
  rejectUnknownFields(raw.project, PROJECT_FIELDS, '`project`');
  if (!isNonBlankString(raw.project.projectId) || !isNonBlankString(raw.project.projectVersionId)) {
    throw cltError('cltProjectIncomplete');
  }
  if (raw.subjectVersion !== undefined) {
    throw cltError('cltSubjectVersionWithProject');
  }
};

const validateSuiteSettings = (raw: Record<string, unknown>, target: CltRunTarget): void => {
  rejectNonString(raw, 'persona');
  if (raw.persona !== undefined && !CLT_PERSONAS.includes(normalizePersona(raw.persona))) {
    cltWarning('cltUnknownPersona', [display(raw.persona), CLT_PERSONAS.join(', ')]);
  }

  rejectNonString(raw, 'evaluationMode');
  if (raw.evaluationMode !== undefined) {
    if (target === 'ephemeral') {
      cltWarning('cltEvaluationModeIgnored');
    } else if (!EVALUATION_MODES.includes(raw.evaluationMode as string)) {
      cltWarning('cltUnknownEvaluationMode', [display(raw.evaluationMode), EVALUATION_MODES.join(', ')]);
    }
  }

  if (raw.maxTurns !== undefined) {
    const turns = raw.maxTurns;
    if (typeof turns === 'string' && /^\s*\d+\s*$/.test(turns)) {
      throw cltError('cltMaxTurnsQuoted', [display(turns)]);
    }
    if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1) {
      throw cltError('cltInvalidMaxTurns', [display(turns)]);
    }
    const max = CLT_MAX_TURNS[target];
    if (turns > max) {
      cltWarning(target === 'ephemeral' && turns <= CLT_MAX_TURNS.saved ? 'cltMaxTurnsSavedOnly' : 'cltMaxTurnsOverLimit', [
        turns,
        max,
        TARGET_PHRASES[target],
      ]);
    }
  }

  if (raw.simulation !== undefined) {
    validateSimulation(raw.simulation);
  }
};

const validateSimulation = (simulation: unknown): void => {
  if (!isRecord(simulation)) {
    throw shapeError('`simulation`', 'a mapping', simulation, 'enabled: true');
  }
  rejectUnknownFields(simulation, SIMULATION_FIELDS, '`simulation`');
  if (simulation.enabled !== undefined && typeof simulation.enabled !== 'boolean') {
    throw cltError('cltSimulationEnabledNotBoolean', [display(simulation.enabled)]);
  }
  if (simulation.excludedActions === undefined) {
    return;
  }
  if (!Array.isArray(simulation.excludedActions)) {
    throw shapeError(
      '`simulation.excludedActions`',
      'a list',
      simulation.excludedActions,
      '- { subagent: Order_Management, actions: [Cancel_Order] }'
    );
  }
  simulation.excludedActions.forEach((entry: unknown, idx) => {
    const where = `excluded action entry ${idx + 1} in \`simulation\``;
    if (!isRecord(entry)) {
      throw shapeError(where, 'a mapping', entry, '- { subagent: Order_Management, actions: [Cancel_Order] }');
    }
    rejectUnknownFields(entry, EXCLUDED_ACTION_FIELDS, where);
    if (!isNonBlankString(entry.subagent)) {
      throw cltError('cltSimulationMissingSubagent', [idx + 1]);
    }
    const actions: unknown = entry.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      throw cltError('cltSimulationMissingActions', [idx + 1, display(entry.subagent)]);
    }
    const badAction = actions.findIndex((action) => !isNonBlankString(action));
    if (badAction !== -1) {
      throw cltError('cltSimulationInvalidAction', [badAction + 1, idx + 1, display(actions[badAction])]);
    }
  });
};

const validateTestCase = (testCase: unknown, caseNumber: number, target: CltRunTarget): void => {
  if (!isRecord(testCase)) {
    throw shapeError(`test case ${caseNumber}`, 'a mapping', testCase, '- conversationGoal: Return an item.');
  }
  const turnLevelField = TURN_LEVEL_FIELDS.find((field) => field in testCase);
  if (turnLevelField) {
    throw cltError('cltTurnLevelField', [caseNumber, turnLevelField, turnLevelField]);
  }
  rejectUnknownFields(testCase, TEST_CASE_FIELDS, `test case ${caseNumber}`);

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
    throw shapeError(
      `\`contextVariables\` in test case ${caseNumber}`,
      'a list',
      contextVariables,
      '- { name: ChannelType, value: Web }'
    );
  }
  const seen = new Set<string>();
  contextVariables.forEach((cv: unknown, idx) => {
    const where = `context variable ${idx + 1} in test case ${caseNumber}`;
    if (!isRecord(cv)) {
      throw shapeError(where, 'a mapping', cv, '- { name: ChannelType, value: Web }');
    }
    rejectUnknownFields(cv, CONTEXT_VARIABLE_FIELDS, where);
    const bare = bareContextVariableName(cv.name);
    if (bare === undefined) {
      throw cltError('cltContextVariableMissingName', [caseNumber]);
    }
    // "ChannelType" and "$Context.ChannelType" name the same variable (Core `ConversationContextVariables`).
    if (seen.has(bare)) {
      throw cltError('cltContextVariableDuplicate', [caseNumber, display(bare)]);
    }
    seen.add(bare);
    // YAML reads unquoted numbers and booleans as non-strings (`02134` becomes 2134), so require a string.
    if (typeof cv.value !== 'string') {
      throw cltError('cltContextVariableInvalidValue', [caseNumber, display(bare), display(cv.value)]);
    }
  });
};

const validateConnections = (connections: unknown, caseNumber: number): void => {
  if (connections === undefined) {
    return;
  }
  const where = `\`connections\` in test case ${caseNumber}`;
  if (!isRecord(connections)) {
    throw shapeError(where, 'a mapping', connections, 'surfaceType: Messaging');
  }
  rejectUnknownFields(connections, CONNECTIONS_FIELDS, where);
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
    throw shapeError(`\`scorers\` in test case ${caseNumber}`, 'a list', scorers, '- name: task_resolution');
  }
  scorers.forEach((scorer: unknown, idx) => {
    const where = `scorer ${idx + 1} in test case ${caseNumber}`;
    if (!isRecord(scorer)) {
      throw shapeError(where, 'a mapping', scorer, '- name: task_resolution');
    }
    rejectUnknownFields(scorer, SCORER_FIELDS, where);
    if (!isNonBlankString(scorer.name)) {
      throw cltError('cltScorerMissingName', [caseNumber]);
    }
    const name = scorer.name;
    if (scorer.expected !== undefined && typeof scorer.expected !== 'string') {
      throw cltError('cltScorerExpectedNotString', [display(name), caseNumber, display(scorer.expected)]);
    }
    if (!isCltScorerName(name)) {
      cltWarning('cltUnknownScorer', [
        display(name),
        caseNumber,
        TARGET_PHRASES[target],
        withUiLabels(cltScorersFor(target)),
      ]);
      return;
    }
    // Check availability before `expected`, so an unusable scorer isn't first told to add a value.
    const entry = CltScorerCatalog[name];
    if (entry.targets.length === 0) {
      throw cltError('cltScorerNotAvailable', [name, caseNumber, entry.uiLabel]);
    }
    if (!entry.targets.includes(target)) {
      cltWarning('cltScorerWrongTarget', [
        name,
        caseNumber,
        TARGET_PHRASES[target],
        entry.targets.map((t) => TARGET_PHRASES[t]).join(' or '),
      ]);
    }
    if (entry.needsExpected && !isNonBlankString(scorer.expected)) {
      throw cltError('cltScorerMissingExpected', [name, caseNumber]);
    }
  });
};

const rejectUnknownFields = (value: Record<string, unknown>, allowed: string[], where: string): void => {
  const unknownField = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownField !== undefined) {
    throw cltError('cltUnknownField', [display(unknownField), where, allowed.join(', ')]);
  }
};

/** Error for a value with the wrong YAML shape, for example a bare string where a `- name: ...` entry belongs. */
const shapeError = (where: string, expected: string, value: unknown, example: string): SfError =>
  cltError('cltInvalidShape', [where, expected, describeShape(value), example]);

const describeShape = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'empty';
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (typeof value === 'object') {
    return 'a mapping';
  }
  return `the ${typeof value === 'string' ? 'text' : typeof value} ${display(value)}`;
};

const rejectNonString = (value: Record<string, unknown>, field: string): void => {
  if (value[field] !== undefined && typeof value[field] !== 'string') {
    throw cltError('cltFieldNotString', [field, display(value[field])]);
  }
};

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
    throw cltError('cltAgentNotResolved', [display(spec.subjectName)]);
  }
  return { agentId: agent.agentId, agentVersionId: agent.agentVersionId };
};

const toTestCaseInput = (testCase: CltTestCase, idx: number): ConversationTestCaseInput => ({
  number: idx + 1,
  conversationGoal: testCase.conversationGoal,
  ...(testCase.contextVariables?.length
    ? {
        contextVariables: testCase.contextVariables.map((cv) => ({
          variableName: cv.name.trim(),
          variableValue: cv.value,
        })),
      }
    : {}),
  ...(testCase.connections
    ? { connections: { surfaceConfig: { surfaceType: testCase.connections.surfaceType } } }
    : {}),
  ...(testCase.scorers?.length
    ? {
        // Known scorers that take no expected value omit it, as the NGT converter does. An unknown
        // scorer gets `expected` as written, so Core decides.
        scorers: testCase.scorers.map((scorer) => ({
          name: scorer.name,
          ...(scorer.expected !== undefined && (!isCltScorerName(scorer.name) || CltScorerCatalog[scorer.name].needsExpected)
            ? { expectedValue: scorer.expected }
            : {}),
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
  String(persona).trim().toUpperCase();

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

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_DISPLAY_LENGTH = 200;

/**
 * Renders a spec value for an error message. Non-strings (numbers, objects from bad YAML) are shown as JSON.
 * Control characters are escaped, so a spec can't hide terminal escape sequences in an error, and long values
 * are cut short.
 */
const display = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
  const safe = text.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return safe.length > MAX_DISPLAY_LENGTH ? `${safe.slice(0, MAX_DISPLAY_LENGTH)}...` : safe;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonBlankString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const cltError = (key: string, tokens: Array<string | number> = []): SfError =>
  new SfError(messages.getMessage(key, tokens), key);

const cltWarning = (key: string, tokens: Array<string | number> = []): void => {
  void Lifecycle.getInstance().emitWarning(messages.getMessage(key, tokens));
};
