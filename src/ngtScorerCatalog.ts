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
 * Known scorer names for the NGT (Agentforce Studio) test runner — used for IDE
 * autocomplete and the per-scorer metadata in {@link NgtScorerCatalog}.
 *
 * The `(string & NonNullable<unknown>)` branch keeps this open: arbitrary names from a future Core
 * release pass type-checks. Validation is non-strict on purpose — `validateNgtSpec`
 * emits a lifecycle warning for unknown names, and Core's MD validator
 * (`AITestingOOTBEvaluations.resolveByKeyOrName`) is the authoritative runtime gate.
 *
 * Update when Core ships a new OOTB scorer.
 *
 * Future direction: when `AiTestingDefinition` lands in `@salesforce/types`
 * (currently only `AiEvaluationDefinition` is published; see forcedotcom/wsdl
 * `src/metadata.ts`), the XML types should be swapped for generated ones. The
 * scorer name list itself isn't enum-typed in the WSDL though, so this catalog
 * stays the source of truth for the `needsExpected` and `grade` metadata even
 * after that swap.
 */
export type NgtScorerName =
  | KnownNgtScorerName
  | (string & NonNullable<unknown>);

/** The closed set used for catalog lookups and autocomplete. */
export type KnownNgtScorerName =
  | 'topic_sequence_match'
  | 'action_sequence_match'
  | 'agent_handoff_match'
  | 'bot_response_rating'
  | 'response_match'
  | 'coherence'
  | 'conciseness'
  | 'factuality'
  | 'completeness'
  | 'task_resolution'
  | 'output_latency_milliseconds';

/** Grading scheme a scorer reports back. Used for downstream rendering / threshold logic. */
export type NgtScorerGrade = 'PASS_FAIL' | 'LLM_PASS_FAIL' | 'LLM_0_100' | 'LLM_0_5' | 'NUMERIC';

/** Catalog row describing a single scorer. */
export type NgtScorerEntry = {
  needsExpected: boolean;
  grade: NgtScorerGrade;
  requiresConversationHistory?: true;
};

/* eslint-disable camelcase */
export const NgtScorerCatalog: Readonly<Record<KnownNgtScorerName, NgtScorerEntry>> = {
  topic_sequence_match: { needsExpected: true, grade: 'PASS_FAIL' },
  action_sequence_match: { needsExpected: true, grade: 'PASS_FAIL' },
  agent_handoff_match: { needsExpected: true, grade: 'PASS_FAIL' },
  bot_response_rating: { needsExpected: true, grade: 'LLM_PASS_FAIL' },
  response_match: { needsExpected: true, grade: 'LLM_PASS_FAIL' },
  coherence: { needsExpected: false, grade: 'LLM_0_100' },
  conciseness: { needsExpected: false, grade: 'LLM_0_100' },
  factuality: { needsExpected: false, grade: 'LLM_0_100' },
  completeness: { needsExpected: false, grade: 'LLM_0_100' },
  task_resolution: { needsExpected: false, grade: 'LLM_0_5', requiresConversationHistory: true },
  output_latency_milliseconds: { needsExpected: false, grade: 'NUMERIC' },
} as const;
/* eslint-enable camelcase */

export const isNgtScorerName = (s: string): s is KnownNgtScorerName =>
  Object.prototype.hasOwnProperty.call(NgtScorerCatalog, s);
