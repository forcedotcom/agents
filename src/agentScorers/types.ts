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

// Shared declarations for the agent scorer authoring feature: the authoring model and its vocabulary. The logic
// modules (validate, promptContent, xml) and the public entry (../agentScorer) import their types from here.
//
// NOTE: The JSDoc on the authoring types below (OutputEnumValue, AgentAssociation, ScorerSpec) is the single
// source of truth for the spec JSON Schema surfaced by `sf agent scorer generate-metadata-file --spec-schema`. That schema is
// generated from these types (scripts/gen-scorer-schema.mjs → src/scorerSpecSchema.generated.ts), so field
// descriptions and constraints (@pattern, @minLength, @maxLength, @minimum, @maximum, @default) live here only.
// To add or change a field, edit the type.

// Enum value sets are declared as `const` arrays so both this package and consumers (e.g. the CLI's
// interactive prompt options/validators) can share a single source of truth; the union types are derived
// from them so the two never drift apart.
export const SCORER_INPUT_SCOPES = ['Session', 'Intent'] as const;
export const SCORER_ENGINE_TYPES = ['Manual', 'PromptTemplate'] as const;
// Statuses a *new* scorer version may be authored with (via `create`):
//   - Draft: the scorer is still being developed and tuned (the authoring inner loop). It can be run ad-hoc to
//     evaluate agents, but it cannot be activated for automatic production scoring.
//   - Available: the scorer is validated and ready. Like Draft it can be run ad-hoc, and additionally it
//     becomes eligible for automatic production scoring once an agentAssociation sets isActive: true.
// `Archived` (no longer in use) is deliberately excluded: it is a terminal state reached only by a later
// status transition, never an initial one.
export const SCORER_STATUSES = ['Draft', 'Available'] as const;
export const SCORER_OUTCOME_TYPES = ['Pass', 'Fail', 'NotApplicable'] as const;

// Full lifecycle status set a *stored* scorer version may carry: Draft (under development), Available (ready
// to use), and Archived (no longer in use). Authoring is limited to SCORER_STATUSES; `Archived` is recognized
// when parsing/selecting an existing scorer's versions — an archived version cannot be run, and a version can
// be moved to it via a status transition.
export const SCORER_VERSION_STATUSES = ['Draft', 'Available', 'Archived'] as const;

export type ScorerInputScope = (typeof SCORER_INPUT_SCOPES)[number];
export type ScorerEngineType = (typeof SCORER_ENGINE_TYPES)[number];
export type ScorerStatus = (typeof SCORER_STATUSES)[number];
export type ScorerVersionStatus = (typeof SCORER_VERSION_STATUSES)[number];
export type ScorerOutcomeType = (typeof SCORER_OUTCOME_TYPES)[number];

export const SUPPORTED_LIGHTNING_TYPES = [
  'lightning__textType',
  'lightning__multilineTextType',
  'lightning__richTextType',
  'lightning__numberType',
  'lightning__integerType',
  'lightning__booleanType',
  'lightning__dateType',
  'lightning__dateTimeType',
  'lightning__dateTimeStringType',
  'lightning__urlType',
  'lightning__objectType',
  'lightning__listType',
] as const;

export type SupportedLightningType = (typeof SUPPORTED_LIGHTNING_TYPES)[number];

export const MAX_ENUM_VALUES = 101;

/** Maximum length of a scorer API name. */
export const SCORER_API_NAME_MAX_LENGTH = 35;

/** A scorer API name must start with a letter and contain only alphanumerics and underscores. */
export const SCORER_API_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The scorer prompt-template type. It fixes the model output envelope on the platform (see the
 * GenAiPromptTemplateOutput Apex class) and the set of `Input:*` merge fields the template declares. Shared by
 * the prompt-content builder, the XML builders, and the run-time engine.
 */
export const SCORER_PROMPT_TEMPLATE_TYPE = 'agentforce_session_tracing__scorerOpenEnded' as const;

// --- Authoring model ------------------------------------------------------------------------------------

/** A possible output value for the scorer. */
export type OutputEnumValue = {
  /**
   * The output label (e.g., 'Good', 'Bad', 'N/A').
   *
   * @minLength 1
   */
  value: string;
  /** Maps this value to a pass/fail outcome for reporting. */
  outcomeType: ScorerOutcomeType;
  /**
   * Whether this is the label to fall back to when none of the others apply. At most one value may be the
   * fallback.
   *
   * @default false
   */
  isFallback?: boolean;
  /**
   * Whether this is a system-generated fallback. Typically false for user-defined scorers.
   *
   * @default false
   */
  isSystemFallback?: boolean;
};

/** Associates the scorer with an agent in the org. */
export type AgentAssociation = {
  /** API name of the agent to associate with this scorer. */
  agentApiName: string;
  /**
   * Whether this scorer runs automatically on the agent's production sessions.
   *
   * - false: the scorer never runs on its own. It can still be run ad-hoc against sessions on demand, regardless of whether the version's status is 'Draft' or 'Available'.
   * - true: the platform automatically scores the agent's incoming production sessions — no ad-hoc trigger needed — sampling them per `samplingRate`. This activation requires the scorer version's status to be 'Available'.
   *
   * Set this to true only once the scorer is validated and you want continuous, hands-off scoring in
   * production; keep it false while developing (status 'Draft') or when you only intend to score ad-hoc.
   */
  isActive: boolean;
  /**
   * Fraction of production sessions to score automatically, from 0.0 (none) to 1.0 (every session) — e.g. 0.1
   * scores roughly 10% of sessions. This is the sampling rate for automatic scoring only: it applies when
   * `isActive` is true and is ignored for ad-hoc runs.
   *
   * @minimum 0
   * @maximum 1
   * @default 1
   */
  samplingRate?: number;
  /** Override input scope for this specific agent association. */
  inputScope?: ScorerInputScope;
};

/** YAML spec file for creating an agent scorer definition via `sf agent scorer generate-metadata-file --spec <file>`. */
export type ScorerSpec = {
  /**
   * API name of the scorer definition. Max 35 characters, must start with a letter, only alphanumerics and underscores.
   *
   * @pattern ^[A-Za-z][A-Za-z0-9_]{0,34}$
   * @maxLength 35
   */
  apiName: string;
  /** The lightning type the scorer's value conforms to (e.g. 'lightning__textType', 'lightning__numberType'). */
  lightningType: SupportedLightningType;
  /**
   * Whether the scorer evaluates an entire session or a single intent within a session.
   *
   * @default Session
   */
  inputScope?: ScorerInputScope;
  /**
   * Display label for the scorer version.
   *
   * @minLength 1
   */
  label: string;
  /** Human-readable description of what this scorer evaluates. */
  description?: string;
  /** 'Manual' for human-evaluated scoring, 'PromptTemplate' for LLM-evaluated scoring. */
  engineType: ScorerEngineType;
  /**
   * Prompt text for PromptTemplate engine type. Use {!$Input:Session} to reference the session data,
   * {!$Input:AllowedLabels} for allowed output values, and {!$Input:FallbackLabel} for the fallback value.
   * Ignored when engineType is 'Manual'.
   */
  promptContent?: string;
  /**
   * API name of an existing prompt template to use instead of generating a new one. Mutually exclusive with
   * promptContent.
   */
  promptTemplateName?: string;
  /**
   * Per-scorer evaluation guidance substituted into the generated prompt. Used only when a prompt is generated
   * (PromptTemplate engine without promptTemplateName); ignored otherwise.
   */
  instructions?: string;
  /**
   * Lifecycle status of this scorer version, which controls whether and how it can be used:
   *
   * - 'Draft' (default): the scorer is still being developed and tuned — the authoring inner loop. Use this while iterating on the prompt/instructions. A Draft version can be run ad-hoc to evaluate agents, but it cannot be activated for automatic production scoring.
   * - 'Available': the scorer is validated and ready. It can be run ad-hoc, and it additionally becomes eligible for automatic production scoring once its agentAssociation sets isActive: true.
   *
   * Authoring is limited to 'Draft' and 'Available'. 'Archived' (no longer in use) is a terminal state reached
   * only by a later status transition on an existing version — it cannot be set when creating a version here.
   *
   * @default Draft
   */
  status?: ScorerStatus;
  agentAssociation: AgentAssociation;
  /**
   * Optional predefined labels the scorer may output. Provide them to constrain the model to a fixed label set;
   * omit for fully free-form output. When provided, at most one value may have isFallback: true.
   */
  outputEnumValues?: OutputEnumValue[];
  /**
   * The version number this spec was resolved from. Populated by `parseScorerXml`/`loadScorerSpec` when a
   * stored definition is read (so callers can report which version actually ran); it is not part of authoring
   * and is ignored by `buildScorerXml`.
   */
  scorerVersion?: number;
};

export type ScorerCreateResult = {
  path: string;
  apiName: string;
  contents: string;
  promptTemplatePath?: string;
  promptTemplateContents?: string;
};
