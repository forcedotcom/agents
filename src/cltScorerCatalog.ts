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

/**
 * Where a CLT spec is headed. Limits and the allowed scorers differ:
 * - `ephemeral`: `conversation-tests/ephemeral-run`, run without saving.
 * - `saved`: `conversation-test-suites/create-and-run`, saved as a suite and then run.
 *
 * Add a value here for a new endpoint (for example generate-and-run), then add it to `targets` on each
 * scorer it supports.
 */
export type CltRunTarget = 'ephemeral' | 'saved';

/**
 * Scorer name in a conversation-level test (CLT) spec.
 *
 * The `(string & NonNullable<unknown>)` branch keeps this open, as `NgtScorerName` does: a scorer from a
 * newer Core release type-checks and is sent as written. `validateCltSpec` warns about names it doesn't
 * know, and Core is the gate.
 */
export type CltScorerName = KnownCltScorerName | (string & NonNullable<unknown>);

/**
 * Scorers the CLI knows for conversation-level tests (CLT), keyed by the API key the CLI sends.
 *
 * Matches the Testing Center wizard rather than everything Core's create-and-run accepts: the server
 * list is `SFEvaluationServiceUtilImpl.getAllSelectableMetrics()` (Aura `getAllAvailableMetrics`), and the
 * wizard keeps the conversation-only evaluations plus `conversationAssertions()` for CONVERSATION_LEVEL.
 * Create-and-run also accepts the turn-level quality scorers (coherence, latency, ...), but the UI never
 * offers them for CLT, so the CLI warns about them.
 *
 * - `needsExpected` is Core's `requiresReferenceColumn()` (the scorer is rejected without `expectedValue`).
 * - `targets` lists the endpoints that score it correctly (see `CltRunTarget`). An empty list means
 * the scorer is in the wizard but no endpoint scores it correctly yet, so the CLI rejects it everywhere.
 * A scorer whose `targets` don't include the run's target gets a warning.
 * - `uiLabel` is the wizard label, so users can map what they see in the UI to the YAML key.
 *
 * Org gates still apply on the server: `acceptance_criteria` needs
 * `com.salesforce.agentforce.testing.center.acceptanceCriteria`, and `displayed_actions_assertion` needs
 * scoring for CLT enabled. The CLI can't read gates, so a closed gate surfaces as Core's error.
 *
 * `agent_handoff_match` is in the wizard but has no targets: Core accepts it, but neither endpoint scores
 * it correctly in 264. ephemeral-run reads a `handoffAgent` field that Platform Metabolism never writes, so
 * it always fails, and create-and-run doesn't save the expected agent. Because the verdict is quietly wrong,
 * it's the one scorer the CLI rejects. Turn it on when Core fixes them.
 *
 * No Connect API returns this list today; update it when the wizard's CLT scorer list changes.
 */
export type KnownCltScorerName =
  | 'task_resolution'
  | 'acceptance_criteria'
  | 'topic_sequence_match'
  | 'action_sequence_match'
  | 'agent_handoff_match'
  | 'displayed_actions_assertion';

/** Catalog row describing a single CLT scorer. */
export type CltScorerEntry = {
  needsExpected: boolean;
  /** Endpoints that score it correctly. Empty: not available from the CLI yet. */
  targets: readonly CltRunTarget[];
  /** Label shown in the Testing Center wizard. */
  uiLabel: string;
};

/* eslint-disable camelcase */
export const CltScorerCatalog: Readonly<Record<KnownCltScorerName, CltScorerEntry>> = {
  task_resolution: { needsExpected: false, targets: ['ephemeral', 'saved'], uiLabel: 'Task Resolution' },
  acceptance_criteria: { needsExpected: true, targets: ['ephemeral', 'saved'], uiLabel: 'Success Criteria' },
  topic_sequence_match: { needsExpected: true, targets: ['ephemeral', 'saved'], uiLabel: 'Subagents Assertion' },
  action_sequence_match: { needsExpected: true, targets: ['ephemeral', 'saved'], uiLabel: 'Action Assertion' },
  agent_handoff_match: { needsExpected: true, targets: [], uiLabel: 'Agent Handoff' },
  displayed_actions_assertion: { needsExpected: true, targets: ['saved'], uiLabel: 'Displayed Actions' },
} as const;
/* eslint-enable camelcase */

/** True when the CLI knows `s` (it's in `CltScorerCatalog`). */
export const isCltScorerName = (s: string): s is KnownCltScorerName =>
  Object.prototype.hasOwnProperty.call(CltScorerCatalog, s);

/** Scorer names that `target` scores correctly, in catalog order. */
export const cltScorersFor = (target: CltRunTarget): KnownCltScorerName[] =>
  (Object.keys(CltScorerCatalog) as KnownCltScorerName[]).filter((name) => CltScorerCatalog[name].targets.includes(target));
