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

export function generateNumberEnumValues(spec: ValueSpecification): OutputEnumValue[] {
  const values: OutputEnumValue[] = [];
  const epsilon = 1e-9;
  let current = spec.min;

  while (current <= spec.max + epsilon) {
    const rounded = Math.round(current * 1e9) / 1e9;
    values.push({
      value: String(rounded),
      outcomeType: 'NotApplicable',
      isFallback: false,
      isSystemFallback: false,
    });
    current += spec.step;
  }

  return values;
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

  if (spec.dataType === 'Number' && spec.specification) {
    const { min, max, step } = spec.specification.valueSpecification;
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
  }

  if (spec.dataType === 'LightningType' && !spec.lightningType) {
    throw new Error("lightningType is required when dataType is 'LightningType'.");
  }

  if (spec.dataType === 'LightningType' && spec.lightningType && !SUPPORTED_LIGHTNING_TYPES.includes(spec.lightningType as SupportedLightningType)) {
    throw new Error(`Unsupported lightningType '${spec.lightningType}'. Must be one of: ${SUPPORTED_LIGHTNING_TYPES.join(', ')}`);
  }
}

function getPromptTemplateType(spec: ScorerSpec): string {
  if (spec.scorerType === 'OpenEnded') {
    return 'agentforce_session_tracing__scorerOpenEnded';
  }
  if (spec.semanticType === 'Measurement') {
    return 'agentforce_session_tracing__scorerMeasurement';
  }
  return 'agentforce_session_tracing__scorerMultilabel';
}

/**
 * Default OpenEnded prompt template bodies mirrored from the NGT (core) scorer prompt resource files
 * under agentforce-session-tracing-impl/.../evals/prompt/scorer-open-*. New scorers are always authored
 * OpenEnded (see the agentforce-observe scorer skill), so these are the defaults that actually ship;
 * the legacy Predefined branches below are kept only for on-disk Text/Number specs.
 *
 * Core resolves the {{EVAL_CONTEXT_LINES}} placeholder to an empty string when a scorer has no name or
 * description yet, so the bodies below reproduce that empty-context form -- exactly what the NGT UI shows
 * for a freshly created scorer. The transcript is referenced as {!$Input:Session}: core pipes its Session
 * input through a getSession data action and references {!$SalesforceDataAction:getSession.chatTranscript},
 * but this CLI references the Session input directly (same meaning, and consistent with the inputs
 * buildPromptTemplateXml declares).
 */

/**
 * Shared tail of every OpenEnded scorer prompt: the "Provide the reasoning..." lead-in, the JSON output
 * contract, and the transcript footer -- byte-for-byte identical across the core scorer-open-* resources
 * apart from the per-type placeholders factored out below. `outputKey` is the output field name ("value"
 * for free-form data types, "label" for labeled/boolean ones); the placeholders are the angle-bracket
 * hints. Insignificant trailing whitespace present in the core resources is intentionally dropped.
 */
function openEndedResultBlock(
  outputKey: 'value' | 'label',
  outputPlaceholder: string,
  explanationPlaceholder: string
): string[] {
  return [
    'Provide the reasoning for your evaluation under "explanation".',
    '',
    'Return a single JSON object, in the following format:',
    '{',
    '  "outputs": [',
    '    {',
    `      "${outputKey}": "${outputPlaceholder}"`,
    '    }',
    '  ],',
    `  "explanation": "${explanationPlaceholder}"`,
    '}',
    '',
    'Do not include markdown formatting, code fences, comments or text beyond the JSON object.',
    '',
    'Conversation Transcript:',
    '{!$Input:Session}',
  ];
}

// scorer-open-boolean-content
const OPEN_BOOLEAN_PROMPT = [
  "You are evaluating an AI agent's conversations.",
  "Your task is to read a conversation transcript between an AI Agent and a user, and determine [EDIT: Describe what should be labeled. For example, whether the AI agent fully resolved the user's issue].",
  'Provide a clear explanation for your choice.',
  '',
  'Scorer Context:',
  '',
  'Allowed Labels:',
  '"true", "false".',
  '',
  'Labeling Instructions:',
  '',
  'If [EDIT: Add the qualities a conversation with the label "true" should have], label the conversation with "true".',
  'If [EDIT: Add the qualities a conversation with the label "false" should have], label the conversation with "false".',
  '',
  'Return exactly one value from the Allowed Labels list under "label".',
  '',
  ...openEndedResultBlock('label', '<either true or false>', '<reason the label applies>'),
].join('\n');

// scorer-open-date-content
const OPEN_DATE_PROMPT = [
  "You are evaluating an AI agent's conversations.",
  'Your task is to read a conversation transcript between an AI Agent and a user, and identify [EDIT: Describe what should be tagged. For example, the confirmed date of a new order].',
  'Provide a clear explanation for your choice.',
  '',
  'Scorer Context:',
  '',
  'Tagging Instructions:',
  '',
  'Tag the conversation when [EDIT: Describe the conditions that qualify for a tag. For example, if the AI agent confirms the date of a new order].',
  'Do not tag the conversation when [EDIT: Describe the conditions that do not qualify for a tag. For example, if a date is discussed but not confirmed by the AI agent].',
  '',
  'Return the relevant date under "value" in "yyyy-mm-dd" format.',
  '',
  ...openEndedResultBlock('value', '<a date in yyyy-mm-dd format>', '<reason the date applies>'),
].join('\n');

// scorer-open-url-content
const OPEN_URL_PROMPT = [
  "You are evaluating an AI agent's conversations.",
  'Your task is to read a conversation transcript between an AI Agent and a user, and identify [EDIT: Describe what should be tagged. For example, every link shared by the AI agent].',
  'Provide a clear explanation for your choice.',
  '',
  'Scorer Context:',
  '',
  'Tagging Instructions:',
  '',
  'Tag the conversation when [EDIT: Describe the conditions that qualify for a tag. For example, the AI agent shares a link].',
  'Do not tag the conversation when [EDIT: Describe the conditions that do not qualify for a tag. For example, only the user shares a link].',
  '',
  'Return the relevant link as a valid URL under "value". If the link is not already in valid URL format, convert it to a valid URL without changing its intended destination.',
  '',
  ...openEndedResultBlock('value', '<a valid URL>', '<reason the URL applies>'),
].join('\n');

// scorer-open-number-content (no predefined labels)
const OPEN_NUMBER_PROMPT = [
  'You are evaluating an AI agent conversation.',
  'Your task is to read the conversation transcript between an AI Agent and a user, then assign a single rating.',
  'Provide a clear explanation for your rating.',
  '',
  'The rating should be based on the following scoring parameters:',
  '',
  'Rating Instructions:',
  'Select a single numerical value. You must provide both a rating and an explanation.',
  '',
  'Use the following criteria when assigning the rating:',
  '[EDIT: Describe the factors that should affect the rating and explain how they should influence the score. For example, assign a higher rating when the user expresses positive sentiment.]',
  '',
  'Return the rating under "value".',
  '',
  ...openEndedResultBlock('value', '<a single numerical value>', '<reason why this rating applies>'),
].join('\n');

// scorer-open-number-labeled-content (predefined labels)
const OPEN_NUMBER_LABELED_PROMPT = [
  'You are evaluating an AI agent conversation.',
  'Your task is to read the conversation transcript between an AI Agent and a user,',
  'then assign a single rating from the allowed rating scale parameters below.',
  'Provide a clear explanation for your rating.',
  '',
  'The rating should be based on the following scoring parameters:',
  '',
  'Rating Scale Parameters:',
  'Minimum Value: [Min]',
  'Maximum Value: [Max]',
  'Increment Step: [Step]',
  'Values range between the [Min] and [Max] values increasing in increments of [Step] value.',
  'Allowed Rating Values: {!$Input:AllowedLabels}.',
  '',
  'Rating Instructions:',
  'Select exactly one value from the allowed ratings. You must provide both a rating and an explanation for every score.',
  '',
  'Rate the conversation as 1 if [EDIT: Add the qualities a conversation rated 1 should have.].',
  'Rate the conversation as 2 if [EDIT: Add the qualities a conversation rated 2 should have.].',
  'Rate the conversation as 3 if [EDIT: Add the qualities a conversation rated 3 should have.]....',
  '',
  'Return the rating under "label".',
  '',
  ...openEndedResultBlock('label', '<a single value from the allowed ratings>', '<reason the rating applies>'),
].join('\n');

// scorer-open-text-content (no predefined labels)
const OPEN_TEXT_PROMPT = [
  "You are evaluating an AI agent's conversations.",
  'Your task is to read a conversation transcript between an AI Agent and a user, and identify [EDIT: Describe what should be tagged. For example, product names mentioned by the AI agent].',
  'Provide a clear explanation for your choice.',
  '',
  'Scorer Context:',
  '',
  'Tagging Instructions:',
  '',
  'Tag the conversation when [EDIT: Describe the conditions that qualify for a tag. For example, if the AI agent mentions a product name].',
  'Do not tag the conversation when [EDIT: Describe the conditions that do not qualify for a tag. For example, if a product name is mentioned only by the user].',
  '',
  'Return the tag under "value".',
  '',
  ...openEndedResultBlock('value', '<applicable tag>', '<reason the tag applies>'),
].join('\n');

// scorer-open-text-labeled-content (predefined labels).
// Note: "recieve" is a typo in the core resource file, preserved here for exact parity.
const OPEN_TEXT_LABELED_PROMPT = [
  "You are evaluating an AI agent's conversations.",
  'Your task is to read a conversation transcript between an AI Agent and a user, and identify which - if any - of the following labels apply: {!$Input:AllowedLabels}.',
  'Provide a clear explanation for your choice.',
  '',
  'Scorer Context:',
  '',
  'Allowed Labels:',
  '{!$Input:AllowedLabels}.',
  '',
  'Labeling Instructions:',
  'Evaluate each label independently and apply a label if its condition is met.',
  '',
  "If [EDIT: Define the required prerequisites for a conversation to recieve the label 'Strong'.], label the conversation as [Label, e.g. Strong].",
  "If [EDIT: Define the required prerequisites for a conversation to recieve the label 'Weak'.], label the conversation as [Label, e.g. Weak]...",
  '',
  '[EDIT: Remove the following line if no Fallback Label was set.]',
  'If no condition applies, return the following value under "label": {!$Input:FallbackLabel}.',
  '',
  ...openEndedResultBlock('label', '<applicable label from the Allowed Labels list>', '<reason the label applies>'),
].join('\n');

type OpenEndedCategory = 'text' | 'number' | 'boolean' | 'url' | 'date';

/**
 * Maps a scorer spec's data type / lightning type to the NGT OpenEnded prompt category. Core keys
 * OpenEnded prompts off SUPPORTED_OPEN_ENDED_LIGHTNING_TYPES (text, multilineText, number, boolean, url,
 * date); the extra CLI lightning types collapse to the closest category (integer -> number, richText ->
 * text, dateTime variants -> date, object/list -> text).
 */
function resolveOpenEndedCategory(spec: Pick<ScorerSpec, 'dataType' | 'lightningType'>): OpenEndedCategory {
  if (spec.dataType === 'Number') {
    return 'number';
  }
  if (spec.dataType === 'Text') {
    return 'text';
  }
  switch (spec.lightningType) {
    case 'lightning__booleanType':
      return 'boolean';
    case 'lightning__urlType':
      return 'url';
    case 'lightning__dateType':
    case 'lightning__dateTimeType':
    case 'lightning__dateTimeStringType':
      return 'date';
    case 'lightning__numberType':
    case 'lightning__integerType':
      return 'number';
    default:
      return 'text';
  }
}

export function buildDefaultPromptContent(
  spec: Pick<ScorerSpec, 'scorerType' | 'semanticType' | 'dataType' | 'lightningType' | 'outputEnumValues'>
): string {
  if (spec.scorerType === 'OpenEnded') {
    // Labeled variants are used when the scorer defines predefined values (constrained-plus-open).
    const usePredefinedLabels = (spec.outputEnumValues?.length ?? 0) > 0;
    switch (resolveOpenEndedCategory(spec)) {
      case 'boolean':
        return OPEN_BOOLEAN_PROMPT;
      case 'url':
        return OPEN_URL_PROMPT;
      case 'date':
        return OPEN_DATE_PROMPT;
      case 'number':
        return usePredefinedLabels ? OPEN_NUMBER_LABELED_PROMPT : OPEN_NUMBER_PROMPT;
      case 'text':
      default:
        return usePredefinedLabels ? OPEN_TEXT_LABELED_PROMPT : OPEN_TEXT_PROMPT;
    }
  }

  // Legacy Predefined scorers (Text/Number specs on disk); new scorers are always OpenEnded.
  if (spec.semanticType === 'Measurement') {
    return [
      'Analyze the following agent-user conversation and evaluate it based on your scoring criteria.',
      '',
      'Respond with ONLY a number within the allowed range: {!$Input:AllowedRange}',
      '',
      'session audit data:',
      '{!$Input:Session}',
    ].join('\n');
  }

  return [
    'Analyze the following agent-user conversation and evaluate it based on your scoring criteria.',
    '',
    'Respond with ONLY one of the allowed values: {!$Input:AllowedLabels}',
    'or fallback to: {!$Input:FallbackLabel}',
    '',
    'session audit data:',
    '{!$Input:Session}',
  ].join('\n');
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
