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

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLBuilder } from 'fast-xml-parser';

// Enum value sets are declared as `const` arrays so both this package and consumers (e.g. the CLI's
// interactive prompt options/validators) can share a single source of truth; the union types are derived
// from them so the two never drift apart.
export const SCORER_DATA_TYPES = ['Text', 'Number', 'LightningType'] as const;
export const SCORER_TYPES = ['Predefined', 'OpenEnded'] as const;
export const SCORER_SEMANTIC_TYPES = ['Dimension', 'Measurement'] as const;
export const SCORER_INPUT_SCOPES = ['Session', 'Intent'] as const;
export const SCORER_ENGINE_TYPES = ['Manual', 'PromptTemplate'] as const;
export const SCORER_STATUSES = ['Draft', 'Available'] as const;
export const SCORER_OUTCOME_TYPES = ['Pass', 'Fail', 'NotApplicable'] as const;

export type ScorerDataType = (typeof SCORER_DATA_TYPES)[number];
export type ScorerType = (typeof SCORER_TYPES)[number];
export type ScorerSemanticType = (typeof SCORER_SEMANTIC_TYPES)[number];
export type ScorerInputScope = (typeof SCORER_INPUT_SCOPES)[number];
export type ScorerEngineType = (typeof SCORER_ENGINE_TYPES)[number];
export type ScorerStatus = (typeof SCORER_STATUSES)[number];
export type ScorerOutcomeType = (typeof SCORER_OUTCOME_TYPES)[number];

// NOTE: The JSDoc on the scorer authoring types below (OutputEnumValue, ValueSpecification, AgentAssociation,
// ScorerSpec) is the single source of truth for the spec JSON Schema surfaced by
// `sf agent scorer create --spec-schema`. That schema is generated from these types (scripts/gen-scorer-schema.mjs
// → src/scorerSpecSchema.generated.ts), so field descriptions and constraints (@pattern, @minLength, @minimum,
// @maximum, @exclusiveMinimum, @default) live here only. To add or change a field, edit the type.

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
   * Whether this is the fallback value. Exactly one value must be the fallback for Text scorers.
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

/** Defines the numeric scale. The number of generated values ((max - min) / step + 1) must not exceed 101. */
export type ValueSpecification = {
  /** Minimum value of the scale. */
  min: number;
  /** Maximum value of the scale. Must be greater than min. */
  max: number;
  /**
   * Step size between values.
   *
   * @exclusiveMinimum 0
   */
  step: number;
  /** Optional threshold value (must be between min and max). */
  threshold?: number;
};

export type NumberSpecification = {
  valueSpecification: ValueSpecification;
};

/** Associates the scorer with an agent in the org. */
export type AgentAssociation = {
  /** API name of the agent to associate with this scorer. */
  agentApiName: string;
  /** Whether scoring is active for this agent association. */
  isActive: boolean;
  /**
   * Fraction of sessions to score (0.0 to 1.0). Only relevant when isActive is true.
   *
   * @minimum 0
   * @maximum 1
   * @default 1
   */
  samplingRate?: number;
  /** Override input scope for this specific agent association. */
  inputScope?: ScorerInputScope;
};

/** YAML spec file for creating an agent scorer definition via `sf agent scorer create --spec <file>`. */
export type ScorerSpec = {
  /**
   * API name of the scorer definition. Max 35 characters, must start with a letter, only alphanumerics and underscores.
   *
   * @pattern ^[A-Za-z][A-Za-z0-9_]{0,34}$
   * @maxLength 35
   */
  apiName: string;
  /**
   * Data type produced by the scorer. Use 'Text' for categorical labels, 'Number' for numeric scales,
   * 'LightningType' for open-ended evaluations.
   */
  dataType: ScorerDataType;
  /** Set to 'OpenEnded' when dataType is 'LightningType' for free-form evaluation. */
  scorerType?: ScorerType;
  /** Required when dataType is 'LightningType'. Specifies the lightning type for open-ended values. */
  lightningType?: SupportedLightningType;
  /**
   * How this scorer is used in analytics. 'Dimension' for categorical grouping, 'Measurement' for numeric
   * aggregation.
   */
  semanticType?: ScorerSemanticType;
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
   * Initial status of the scorer version.
   *
   * @default Draft
   */
  status?: ScorerStatus;
  agentAssociation: AgentAssociation;
  /**
   * Output value definitions. Required for 'Text' dataType. For 'Text' scorers, exactly one value must have
   * isFallback: true.
   */
  outputEnumValues?: OutputEnumValue[];
  /** Required when dataType is 'Number'. Defines the numeric scale. */
  specification?: NumberSpecification;
};

export type ScorerCreateResult = {
  path: string;
  apiName: string;
  contents: string;
  promptTemplatePath?: string;
  promptTemplateContents?: string;
};

export const MAX_ENUM_VALUES = 101;

/** Maximum length of a scorer API name. */
export const SCORER_API_NAME_MAX_LENGTH = 35;

/** A scorer API name must start with a letter and contain only alphanumerics and underscores. */
export const SCORER_API_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Single source of truth for scorer API-name validity, shared by validateScorerSpec and CLI prompts. */
export function isValidScorerApiName(apiName: string): boolean {
  return apiName.length > 0 && apiName.length <= SCORER_API_NAME_MAX_LENGTH && SCORER_API_NAME_PATTERN.test(apiName);
}

/** Number of discrete values a numeric scorer's [min, max] range yields at the given step. */
export function scorerEnumValueCount(min: number, max: number, step: number): number {
  return Math.floor((max - min) / step) + 1;
}

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

export function labelToApiName(label: string): string {
  return label.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
}

export function validateScorerSpec(spec: ScorerSpec): void {
  if (!isValidScorerApiName(spec.apiName)) {
    throw new Error('API name must start with a letter, contain only alphanumerics/underscores, and be at most 35 characters.');
  }

  if (spec.dataType === 'Text' && !spec.outputEnumValues?.length) {
    throw new Error('outputEnumValues is required when dataType is \'Text\'.');
  }

  if (spec.dataType === 'Text' && spec.outputEnumValues) {
    const fallbackCount = spec.outputEnumValues.filter((v) => v.isFallback).length;
    if (fallbackCount !== 1) {
      throw new Error(`Text scorers must have exactly 1 fallback value, but found ${fallbackCount}.`);
    }
  }

  if (spec.agentAssociation.samplingRate != null && (spec.agentAssociation.samplingRate < 0 || spec.agentAssociation.samplingRate > 1)) {
    throw new Error(`samplingRate must be between 0 and 1, but got ${spec.agentAssociation.samplingRate}.`);
  }

  if (spec.dataType === 'Number' && !spec.specification) {
    throw new Error("specification is required when dataType is 'Number'.");
  }

  if (spec.dataType === 'Number' && spec.outputEnumValues) {
    throw new Error("outputEnumValues cannot be provided when dataType is 'Number'. Use specification instead.");
  }

  // Cap the enum list for every type that carries one (Text / LightningType / OpenEnded). Number generates its
  // enum from the range and is bounded separately below; the same MAX_ENUM_VALUES ceiling applies to both.
  if (spec.outputEnumValues && spec.outputEnumValues.length > MAX_ENUM_VALUES) {
    throw new Error(`Too many outputEnumValues: ${spec.outputEnumValues.length} (max ${MAX_ENUM_VALUES}).`);
  }

  if (spec.dataType === 'Number' && spec.specification) {
    const { min, max, step, threshold } = spec.specification.valueSpecification;
    if (min >= max) {
      throw new Error(`Minimum value (${min}) must be less than maximum value (${max}).`);
    }
    if (step <= 0) {
      throw new Error('Step must be a positive number.');
    }
    const numValues = scorerEnumValueCount(min, max, step);
    if (numValues > MAX_ENUM_VALUES) {
      throw new Error(`Step too small: would generate ${numValues} values (max ${MAX_ENUM_VALUES}).`);
    }
    if (threshold != null && (threshold < min || threshold > max)) {
      throw new Error(`Threshold (${threshold}) must be within the range [${min}, ${max}].`);
    }
  }

  if (spec.dataType === 'LightningType' && !spec.lightningType) {
    throw new Error("lightningType is required when dataType is 'LightningType'.");
  }

  if (spec.dataType === 'LightningType' && spec.lightningType && !SUPPORTED_LIGHTNING_TYPES.includes(spec.lightningType)) {
    throw new Error(`Unsupported lightningType '${spec.lightningType}'. Must be one of: ${SUPPORTED_LIGHTNING_TYPES.join(', ')}`);
  }
}

function getPromptTemplateType(spec: Pick<ScorerSpec, 'scorerType' | 'dataType'>): string {
  if (spec.scorerType === 'OpenEnded') {
    return 'agentforce_session_tracing__scorerOpenEnded';
  }
  // A numeric scorer is a measurement; this is driven by the data type, not semanticType.
  if (spec.dataType === 'Number') {
    return 'agentforce_session_tracing__scorerMeasurement';
  }
  return 'agentforce_session_tracing__scorerMultilabel';
}

/**
 * The default scorer prompt is a single generic skeleton whose type-specific parts are substituted in:
 *
 *  - {!$Instructions}     the per-scorer evaluation guidance (or the DEFAULT_INSTRUCTIONS placeholder).
 *  - {!$ScoringGuidance}  type-specific mechanics that the platform does NOT already know from the prompt
 *                         template type: the numeric range (measurement), how to pick a label and fall back
 *                         (multilabel / openended with predefined values), and -- for openended, whose value
 *                         type is dynamic -- the JSON schema the scored value must conform to.
 *
 * We deliberately do NOT restate the output envelope: the prompt template type (multilabel / measurement /
 * openended) already fixes it on the platform (see the GenAiPromptTemplateOutput Apex classes), so embedding
 * it here would only duplicate -- and risk drifting from -- that contract. The transcript, allowed labels,
 * fallback label, and numeric range are referenced as {!$Input:...} inputs, matching the inputs
 * buildPromptTemplateXml declares (so every declared required input is referenced).
 */
const DEFAULT_INSTRUCTIONS =
  '[EDIT: Describe how to evaluate the conversation and what determines the result.]';

const SCORER_PROMPT = [
  'You are evaluating an AI agent conversation.',
  'Read the conversation transcript between an AI Agent and a user and evaluate it as instructed below.',
  '',
  'Scoring instructions:',
  '{!$Instructions}',
  '{!$ScoringGuidance}',
  'Provide the reasoning for your evaluation under "explanation".',
  '',
  'Conversation Transcript:',
  '{!$Input:Session}',
].join('\n');

type JsonSchema = {
  type: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
};

/** The subset of a spec the default-prompt builders read. (semanticType is not read: template selection is
 * driven by scorerType/dataType, see getPromptTemplateType.) */
type PromptContentSpec = Pick<
  ScorerSpec,
  'dataType' | 'scorerType' | 'lightningType' | 'outputEnumValues' | 'specification' | 'instructions'
>;

/**
 * JSON Schema for a built-in Lightning Type. This is the single lookup that maps a type to its output
 * shape; custom types (retrieved from the org) can be added here as a follow-up without touching the prompt
 * template. Types not in the table fall back to a plain string.
 */
function lightningTypeSchema(lightningType: string | undefined): JsonSchema {
  switch (lightningType) {
    case 'lightning__numberType':
      return { type: 'number' };
    case 'lightning__integerType':
      return { type: 'integer' };
    case 'lightning__booleanType':
      return { type: 'boolean' };
    case 'lightning__dateType':
      return { type: 'string', format: 'date' };
    case 'lightning__dateTimeType':
    case 'lightning__dateTimeStringType':
      return { type: 'string', format: 'date-time' };
    case 'lightning__urlType':
      return { type: 'string', format: 'uri' };
    case 'lightning__objectType':
      return { type: 'object' };
    case 'lightning__listType':
      return { type: 'array' };
    case 'lightning__textType':
    case 'lightning__multilineTextType':
    case 'lightning__richTextType':
    default:
      return { type: 'string' };
  }
}

/**
 * Value-level JSON schema for a single scored value: Number scorers carry their min/max/step and LightningType
 * scorers map through lightningTypeSchema. Used by scoringGuidance to describe the openended value type, which
 * is dynamic and therefore not captured by the prompt template's fixed output schema.
 */
function valueSchema(spec: Pick<ScorerSpec, 'dataType' | 'lightningType' | 'specification'>): JsonSchema {
  if (spec.dataType === 'Number') {
    const base: JsonSchema = { type: 'number' };
    const vs = spec.specification?.valueSpecification;
    if (vs) {
      base.minimum = vs.min;
      base.maximum = vs.max;
      base.multipleOf = vs.step;
    }
    return base;
  }
  if (spec.dataType === 'Text') {
    return { type: 'string' };
  }
  return lightningTypeSchema(spec.lightningType);
}

/**
 * Multilabel guidance: the "output" array member holds the chosen labels. Referenced as {!$Input:...} inputs.
 */
const MULTILABEL_GUIDANCE = [
  'Choose one or more labels for the "output" array from the allowed labels:',
  '{!$Input:AllowedLabels}',
  'If none of the allowed labels apply, use the fallback label instead:',
  '{!$Input:FallbackLabel}',
];

/**
 * Open-ended label guidance: each item in the "outputs" array has a "label" member set from the allowed labels.
 */
const OPEN_ENDED_LABEL_GUIDANCE = [
  'For each item in the "outputs" array, set its "label" member to one of the allowed labels:',
  '{!$Input:AllowedLabels}',
  'If none of the allowed labels apply, set "label" to the fallback label instead:',
  '{!$Input:FallbackLabel}',
];

/**
 * Type-specific scoring mechanics -- only what the prompt template type does NOT already fix. The output
 * envelope itself is defined by the template (multilabel / measurement / openended), so this adds just:
 *  - measurement: the numeric range (via the AllowedRange input);
 *  - multilabel: which labels to choose for the "output" array and the fallback (via AllowedLabels / FallbackLabel);
 *  - openended: the "label" member guidance when predefined labels exist, plus the "value" member's JSON schema.
 * Guidance names the output-schema members ("output", "label", "value") so both humans and the model can tell
 * which field each instruction applies to. Always returns a non-empty block.
 */
function scoringGuidance(spec: PromptContentSpec): string {
  const templateType = getPromptTemplateType(spec);

  if (templateType === 'agentforce_session_tracing__scorerMeasurement') {
    return ['Set the "output" number to a score within the allowed range:', '{!$Input:AllowedRange}'].join('\n');
  }

  if (templateType === 'agentforce_session_tracing__scorerOpenEnded') {
    const lines: string[] = [];
    // Labels are optional for openended; describe the "label" member only when the scorer defines them.
    if (spec.outputEnumValues?.length) {
      lines.push(...OPEN_ENDED_LABEL_GUIDANCE);
    }
    // The "value" member's type is dynamic, so the template's fixed schema can't capture it -- describe it here.
    lines.push('Set each item\'s "value" member to conform to this JSON schema:', JSON.stringify(valueSchema(spec)));
    return lines.join('\n');
  }

  // Multilabel always carries predefined labels.
  return MULTILABEL_GUIDANCE.join('\n');
}

export function buildDefaultPromptContent(spec: PromptContentSpec): string {
  // scoringGuidance always returns a non-empty block (every template type has something type-specific to say).
  const guidance = scoringGuidance(spec);
  // Use function replacers so `$` sequences in the substituted text aren't interpreted as replacement patterns.
  return SCORER_PROMPT.replace('{!$Instructions}', () => spec.instructions ?? DEFAULT_INSTRUCTIONS).replace(
    '{!$ScoringGuidance}',
    () => `\n${guidance}\n`
  );
}

export function buildScorerXml(spec: ScorerSpec): string {
  const engine: Record<string, unknown> = {};
  if (spec.engineType === 'PromptTemplate') {
    engine.engineRef = spec.promptTemplateName ?? spec.apiName;
  }
  engine.engineType = spec.engineType;

  const agentAssociationXml: Record<string, unknown> = {
    agentApiName: spec.agentAssociation.agentApiName,
    ...(spec.agentAssociation.inputScope ? { inputScope: spec.agentAssociation.inputScope } : {}),
    isActive: spec.agentAssociation.isActive,
    samplingRate: spec.agentAssociation.samplingRate ?? 1.0,
  };

  const scorerVersion: Record<string, unknown> = {
    agentAssociation: agentAssociationXml,
    ...(spec.description ? { description: spec.description } : {}),
    engine,
    label: spec.label,
  };

  if (spec.dataType === 'Number' && spec.specification) {
    const numSpec = spec.specification.valueSpecification;
    scorerVersion.specification = {
      valueSpecification: {
        min: numSpec.min,
        max: numSpec.max,
        step: numSpec.step,
        ...(numSpec.threshold != null ? { threshold: numSpec.threshold } : {}),
      },
    };
  } else if (spec.outputEnumValues) {
    scorerVersion.outputEnumValue = spec.outputEnumValues.map((v) => ({
      isFallback: v.isFallback ?? false,
      isSystemFallback: v.isSystemFallback ?? false,
      outcomeType: v.outcomeType,
      value: v.value,
    }));
  }

  scorerVersion.status = spec.status ?? 'Draft';
  scorerVersion.versionNumber = 1;

  const definition: Record<string, unknown> = {
    '@_xmlns': 'http://soap.sforce.com/2006/04/metadata',
    dataType: spec.dataType,
    inputScope: spec.inputScope ?? 'Session',
  };

  if (spec.lightningType) {
    definition.lightningType = spec.lightningType;
  }
  if (spec.scorerType) {
    definition.scorerType = spec.scorerType;
  }
  if (spec.semanticType) {
    definition.semanticType = spec.semanticType;
  }

  definition.scorerVersion = scorerVersion;

  const xmlObj = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    AiAgentScorerDefinition: definition,
  };

  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    indentBy: '    ',
    suppressBooleanAttributes: false,
  });

  return builder.build(xmlObj);
}

export function buildPromptTemplateXml(apiName: string, promptContent: string, spec: ScorerSpec): string {
  const templateType = getPromptTemplateType(spec);

  const isOpenEnded = spec.scorerType === 'OpenEnded';
  const isMeasurement = templateType === 'agentforce_session_tracing__scorerMeasurement';

  const inputs: Array<{ apiName: string; definition: string; referenceName: string; required: boolean }> = [
    {
      apiName: 'Session',
      definition: 'lightningtype://propertyType/agentforce_session_tracing__stdmDetailViewType',
      referenceName: 'Input:Session',
      required: true,
    },
  ];

  if (isMeasurement) {
    inputs.push({
      apiName: 'AllowedRange',
      definition: 'primitive://String',
      referenceName: 'Input:AllowedRange',
      required: true,
    });
  } else {
    // Labels are required for multilabel but optional for OpenEnded (a scorer may define none). We always
    // declare the inputs so the template shape is stable; for OpenEnded they are required: false, so it is
    // fine that the generated prompt references them only when the scorer actually has predefined labels.
    inputs.push(
      {
        apiName: 'AllowedLabels',
        definition: 'primitive://String',
        referenceName: 'Input:AllowedLabels',
        required: !isOpenEnded,
      },
      {
        apiName: 'FallbackLabel',
        definition: 'primitive://String',
        referenceName: 'Input:FallbackLabel',
        required: !isOpenEnded,
      }
    );
  }

  const versionIdentifier = createHash('sha256').update(promptContent).digest('base64') + '_1';

  const xmlObj = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    GenAiPromptTemplate: {
      '@_xmlns': 'http://soap.sforce.com/2006/04/metadata',
      activeVersionIdentifier: versionIdentifier,
      developerName: apiName,
      masterLabel: apiName,
      overridable: false,
      templateVersions: {
        content: promptContent,
        inputs,
        // default scaffolding; users can override by editing the prompt template after generation
        primaryModel: 'sfdc_ai__DefaultOpenAIGPT4OmniMini',
        status: 'Published',
        versionIdentifier,
      },
      type: templateType,
      visibility: 'Global',
    },
  };

  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    indentBy: '    ',
    suppressBooleanAttributes: false,
  });

  return builder.build(xmlObj);
}

/**
 * Generates scorer definition metadata files from a spec.
 *
 * Returns the XML contents and file paths. If `write` is true (default),
 * the files are written to disk.
 */
export async function createScorerDefinition(
  spec: ScorerSpec,
  options: { outputDir: string; write?: boolean }
): Promise<ScorerCreateResult> {
  validateScorerSpec(spec);

  const scorerXml = buildScorerXml(spec);
  const scorerDir = join(options.outputDir, 'aiAgentScorerDefinitions');
  const scorerFileName = `${spec.apiName}.aiAgentScorerDefinition-meta.xml`;
  const scorerPath = join(scorerDir, scorerFileName);

  let promptTemplatePath: string | undefined;
  let promptTemplateXml: string | undefined;

  const promptDir = join(options.outputDir, 'genAiPromptTemplates');

  if (spec.engineType === 'PromptTemplate' && !spec.promptTemplateName) {
    const content = spec.promptContent ?? buildDefaultPromptContent(spec);
    promptTemplateXml = buildPromptTemplateXml(spec.apiName, content, spec);
    const promptFileName = `${spec.apiName}.genAiPromptTemplate-meta.xml`;
    promptTemplatePath = join(promptDir, promptFileName);
  }

  if (options.write !== false) {
    await mkdir(scorerDir, { recursive: true });
    await writeFile(scorerPath, scorerXml);

    if (promptTemplateXml && promptTemplatePath) {
      await mkdir(promptDir, { recursive: true });
      await writeFile(promptTemplatePath, promptTemplateXml);
    }
  }

  return {
    path: scorerPath,
    apiName: spec.apiName,
    contents: scorerXml,
    promptTemplatePath,
    promptTemplateContents: promptTemplateXml,
  };
}
