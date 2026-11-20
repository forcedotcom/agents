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
 * Scorers accepted by conversation-level tests (CLT), keyed by the API key the CLI sends.
 *
 * Mirrors Core's `AITestingOOTBEvaluations` entries that support `ColumnType.AGENT_TEST`:
 * - `needsExpected` is `requiresReferenceColumn()` (Core rejects the scorer without `expectedValue`).
 * - `ephemeral` is membership in `RunEphemeralConversationTestResource.SUPPORTED_SCORERS`.
 *
 * A run without saving accepts only those five; a saved suite (create-and-run) accepts all of them.
 *
 * The `(string & NonNullable<unknown>)` branch keeps the name type open so a scorer from a future Core
 * release still type-checks. `validateCltSpec` warns on unknown names; Core is the runtime gate.
 *
 * Update when Core adds an AGENT_TEST scorer.
 */
export type CltScorerName = KnownCltScorerName | (string & NonNullable<unknown>);

/** The closed set used for catalog lookups and autocomplete. */
export type KnownCltScorerName =
  | 'task_resolution'
  | 'acceptance_criteria'
  | 'topic_sequence_match'
  | 'action_sequence_match'
  | 'agent_handoff_match'
  | 'displayed_actions_assertion'
  | 'response_match'
  | 'bot_response_rating'
  | 'custom_llm_evaluation'
  | 'coherence'
  | 'conciseness'
  | 'factuality'
  | 'completeness'
  | 'instruction_following'
  | 'instruction_adherence'
  | 'expression_eval'
  | 'output_latency_milliseconds';

/** Catalog row describing a single CLT scorer. */
export type CltScorerEntry = {
  needsExpected: boolean;
  /** True when a run without saving (ephemeral-run) accepts the scorer. */
  ephemeral: boolean;
};

/* eslint-disable camelcase */
export const CltScorerCatalog: Readonly<Record<KnownCltScorerName, CltScorerEntry>> = {
  task_resolution: { needsExpected: false, ephemeral: true },
  acceptance_criteria: { needsExpected: true, ephemeral: true },
  topic_sequence_match: { needsExpected: true, ephemeral: true },
  action_sequence_match: { needsExpected: true, ephemeral: true },
  agent_handoff_match: { needsExpected: true, ephemeral: true },
  displayed_actions_assertion: { needsExpected: true, ephemeral: false },
  response_match: { needsExpected: true, ephemeral: false },
  bot_response_rating: { needsExpected: true, ephemeral: false },
  custom_llm_evaluation: { needsExpected: true, ephemeral: false },
  coherence: { needsExpected: false, ephemeral: false },
  conciseness: { needsExpected: false, ephemeral: false },
  factuality: { needsExpected: false, ephemeral: false },
  completeness: { needsExpected: false, ephemeral: false },
  instruction_following: { needsExpected: false, ephemeral: false },
  instruction_adherence: { needsExpected: false, ephemeral: false },
  expression_eval: { needsExpected: false, ephemeral: false },
  output_latency_milliseconds: { needsExpected: false, ephemeral: false },
} as const;
/* eslint-enable camelcase */

export const isCltScorerName = (s: string): s is KnownCltScorerName =>
  Object.prototype.hasOwnProperty.call(CltScorerCatalog, s);
