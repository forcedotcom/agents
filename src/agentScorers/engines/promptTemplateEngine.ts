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
 * PromptTemplate engine — the one implemented today.
 *
 * Runs a scorer by invoking its deployed prompt template via the generations API, supplying the session plus
 * the allowed labels + fallback the template requires, all derived from the scorer definition.
 */
import { type ScorerSpec, type ScorerEngine, type EngineRunInput, type ScorerResult, type ValueMap } from '../types';
import { generate } from './generations';

/** Derive the prompt-template label inputs (beyond Input:Session) from the definition. */
function deriveInputs(spec: ScorerSpec): ValueMap {
  // Every non-system value is a selectable label; the user fallback is the isFallback one.
  const values = spec.outputEnumValues ?? [];
  const selectable = values.filter((v) => !v.isSystemFallback);
  const fallback = values.find((v) => v.isFallback && !v.isSystemFallback)?.value ?? selectable.at(-1)?.value ?? '';
  return {
    'Input:AllowedLabels': { value: selectable.map((v) => v.value).join(', ') },
    'Input:FallbackLabel': { value: fallback },
  };
}

export const promptTemplateEngine: ScorerEngine = {
  engineType: 'PromptTemplate',
  run({ spec, session, connection }: EngineRunInput): Promise<ScorerResult> {
    // Mirror buildScorerXml's engineRef: a referenced template if named, else the generated one (== apiName).
    const templateName = spec.promptTemplateName ?? spec.apiName;
    const valueMap: ValueMap = { 'Input:Session': { value: session }, ...deriveInputs(spec) };
    return generate(connection, templateName, valueMap);
  },
};
