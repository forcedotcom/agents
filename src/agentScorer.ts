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

export type ScorerDataType = 'Text' | 'Number' | 'LightningType';
export type ScorerType = 'Predefined' | 'OpenEnded';
export type ScorerSemanticType = 'Dimension' | 'Measurement';
export type ScorerInputScope = 'Session' | 'Intent';
export type ScorerEngineType = 'Manual' | 'PromptTemplate';
export type ScorerStatus = 'Available' | 'Draft';
export type ScorerOutcomeType = 'Pass' | 'Fail' | 'NotApplicable';

export type OutputEnumValue = {
  value: string;
  outcomeType: ScorerOutcomeType;
  isFallback?: boolean;
  isSystemFallback?: boolean;
};

export type ValueSpecification = {
  min: number;
  max: number;
  step: number;
  threshold?: number;
};

export type NumberSpecification = {
  valueSpecification: ValueSpecification;
};

export type AgentAssociation = {
  agentApiName: string;
  isActive: boolean;
  samplingRate?: number;
  inputScope?: ScorerInputScope;
};

export type ScorerSpec = {
  apiName: string;
  dataType: ScorerDataType;
  scorerType?: ScorerType;
  lightningType?: string;
  semanticType?: ScorerSemanticType;
  inputScope?: ScorerInputScope;
  label: string;
  description?: string;
  engineType: ScorerEngineType;
  promptContent?: string;
  promptTemplateName?: string;
  instructions?: string;
  status?: ScorerStatus;
  agentAssociation: AgentAssociation;
  outputEnumValues?: OutputEnumValue[];
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
  if (!spec.apiName || spec.apiName.length > 35 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(spec.apiName)) {
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
    const numValues = Math.floor((max - min) / step) + 1;
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

  if (spec.dataType === 'LightningType' && spec.lightningType && !SUPPORTED_LIGHTNING_TYPES.includes(spec.lightningType as SupportedLightningType)) {
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

  return builder.build(xmlObj) as string;
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

  return builder.build(xmlObj) as string;
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
