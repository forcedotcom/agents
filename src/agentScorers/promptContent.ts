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

import { type ScorerSpec } from './types';

/*
 * The default scorer prompt is a single generic skeleton whose scorer-specific parts are substituted in:
 *
 *  - {!$Instructions}     the per-scorer evaluation guidance (or the DEFAULT_INSTRUCTIONS placeholder).
 *  - {!$ScoringGuidance}  mechanics the platform does NOT already know from the prompt template type: how to
 *                         pick a label and fall back (when the scorer defines predefined labels), and how to
 *                         fill the value member -- mirror the chosen label for an enum scorer, or (for a typed
 *                         scorer, whose value type is dynamic) conform to the value's JSON schema.
 *
 * We deliberately do NOT restate the output envelope: the open-ended prompt template type already fixes it on
 * the platform (see the GenAiPromptTemplateOutput Apex class), so embedding it here would only duplicate -- and
 * risk drifting from -- that contract. The transcript, allowed labels, and fallback label are referenced as
 * {!$Input:...} inputs, matching the inputs buildPromptTemplateXml declares.
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
};

/** The subset of a spec the default-prompt builder reads. */
type PromptContentSpec = Pick<ScorerSpec, 'lightningType' | 'outputEnumValues' | 'instructions'>;

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
    case undefined:
    default:
      return { type: 'string' };
  }
}

/**
 * Open-ended label guidance: each item in the "outputs" array has a "label" member set from the allowed labels.
 */
const OPEN_ENDED_LABEL_GUIDANCE = [
  'For each item in the "outputs" array, set its "label" member to one of the allowed labels:',
  '{!$Input:AllowedLabels}',
  'If none of the allowed labels apply, set "label" to the fallback label instead:',
  '{!$Input:FallbackLabel}',
];

/*
 * Scoring mechanics -- only what the open-ended prompt template type does NOT already fix. The output envelope
 * itself is defined by the template, so this describes just the two members whose contents are scorer-specific:
 *
 *  - An enum scorer (predefined labels) is classified by its "label"; the "value" member is redundant, so we
 *    tell the model to mirror the chosen label into it. Do NOT hand such a scorer the value's JSON schema:
 *    the model (esp. GPT-4o-mini) copies a schema like {"type":"string"} into "value" verbatim, which then
 *    surfaces as the run's output instead of the label.
 *  - A typed scorer (no labels) carries its score in "value"; its type is dynamic, so we give the JSON schema
 *    the value must conform to (the template's fixed schema can't capture it).
 *
 * Guidance names the members ("label", "value") so both humans and the model can tell which instruction
 * applies to which field. Always returns a non-empty block.
 */
function scoringGuidance(spec: PromptContentSpec): string {
  // Labels are optional; describe the "label" member (and mirror it into "value") only when defined.
  if (spec.outputEnumValues?.length) {
    return [...OPEN_ENDED_LABEL_GUIDANCE, 'Set each item\'s "value" member to the same label you chose.'].join('\n');
  }
  return [
    'Set each item\'s "value" member to conform to this JSON schema:',
    JSON.stringify(lightningTypeSchema(spec.lightningType)),
  ].join('\n');
}

export function buildDefaultPromptContent(spec: PromptContentSpec): string {
  // scoringGuidance always returns a non-empty block (the "value" member schema is always described).
  const guidance = scoringGuidance(spec);
  // Use function replacers so `$` sequences in the substituted text aren't interpreted as replacement patterns.
  return SCORER_PROMPT.replace('{!$Instructions}', () => spec.instructions ?? DEFAULT_INSTRUCTIONS).replace(
    '{!$ScoringGuidance}',
    () => `\n${guidance}\n`
  );
}
