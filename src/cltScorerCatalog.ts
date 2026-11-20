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
 * Scorers offered for conversation-level tests (CLT), keyed by the API key the CLI sends.
 *
 * Matches the Testing Center wizard rather than everything Core's create-and-run accepts: the server
 * list is `SFEvaluationServiceUtilImpl.getAllSelectableMetrics()` (Aura `getAllAvailableMetrics`), and the
 * wizard keeps the conversation-only evaluations plus `conversationAssertions()` for CONVERSATION_LEVEL.
 * Create-and-run also accepts the turn-level quality scorers (coherence, latency, ...), but the UI never
 * offers them for CLT, so the CLI doesn't either.
 *
 * - `needsExpected` is Core's `requiresReferenceColumn()` (the scorer is rejected without `expectedValue`).
 * - `ephemeral` is membership in `RunEphemeralConversationTestResource.SUPPORTED_SCORERS`.
 * - `uiLabel` is the wizard label, so users can map what they see in the UI to the YAML key.
 *
 * Org gates still apply on the server: `acceptance_criteria` needs
 * `com.salesforce.agentforce.testing.center.acceptanceCriteria`, and `displayed_actions_assertion` needs
 * scoring for CLT enabled. The CLI can't read gates, so a closed gate surfaces as Core's error.
 *
 * No Connect API returns this list today; update it when the wizard's CLT scorer list changes.
 */
export type CltScorerName =
  | 'task_resolution'
  | 'acceptance_criteria'
  | 'topic_sequence_match'
  | 'action_sequence_match'
  | 'agent_handoff_match'
  | 'displayed_actions_assertion';

/** Catalog row describing a single CLT scorer. */
export type CltScorerEntry = {
  needsExpected: boolean;
  /** True when a run without saving (ephemeral-run) accepts the scorer. */
  ephemeral: boolean;
  /** Label shown in the Testing Center wizard. */
  uiLabel: string;
};

/* eslint-disable camelcase */
export const CltScorerCatalog: Readonly<Record<CltScorerName, CltScorerEntry>> = {
  task_resolution: { needsExpected: false, ephemeral: true, uiLabel: 'Task Resolution' },
  acceptance_criteria: { needsExpected: true, ephemeral: true, uiLabel: 'Success Criteria' },
  topic_sequence_match: { needsExpected: true, ephemeral: true, uiLabel: 'Subagents Assertion' },
  action_sequence_match: { needsExpected: true, ephemeral: true, uiLabel: 'Action Assertion' },
  agent_handoff_match: { needsExpected: true, ephemeral: true, uiLabel: 'Agent Handoff' },
  displayed_actions_assertion: { needsExpected: true, ephemeral: false, uiLabel: 'Displayed Actions' },
} as const;
/* eslint-enable camelcase */

export const isCltScorerName = (s: string): s is CltScorerName =>
  Object.prototype.hasOwnProperty.call(CltScorerCatalog, s);
