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

import {
  type ScorerSpec,
  MAX_ENUM_VALUES,
  SCORER_API_NAME_MAX_LENGTH,
  SCORER_API_NAME_PATTERN,
  SCORER_ENGINE_TYPES,
  SUPPORTED_LIGHTNING_TYPES,
} from './types';

/** Single source of truth for scorer API-name validity, shared by validateScorerSpec and CLI prompts. */
export function isValidScorerApiName(apiName: string): boolean {
  return apiName.length > 0 && apiName.length <= SCORER_API_NAME_MAX_LENGTH && SCORER_API_NAME_PATTERN.test(apiName);
}

export function labelToApiName(label: string): string {
  return label.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
}

export function validateScorerSpec(spec: ScorerSpec): void {
  // Guard presence before pattern-checking: a spec that omits apiName (or gives a non-string) would otherwise
  // throw a raw TypeError from `isValidScorerApiName` (`undefined.length`) instead of an actionable message.
  if (typeof spec.apiName !== 'string' || !isValidScorerApiName(spec.apiName)) {
    throw new Error(
      'API name must start with a letter, contain only alphanumerics/underscores, and be at most 35 characters.'
    );
  }

  if (!spec.lightningType) {
    throw new Error('lightningType is required.');
  }
  if (!SUPPORTED_LIGHTNING_TYPES.includes(spec.lightningType)) {
    throw new Error(`Unsupported lightningType '${spec.lightningType}'. Must be one of: ${SUPPORTED_LIGHTNING_TYPES.join(', ')}`);
  }

  // engineType is required and case-sensitive downstream (xml.ts keys the `PromptTemplate` engineRef off an
  // exact match, and agentScorer.ts only generates a template for it), so a missing or mis-cased value would
  // otherwise scaffold a silently-broken definition that fails only at deploy. Mirror the lightningType check.
  if (!spec.engineType) {
    throw new Error('engineType is required.');
  }
  if (!(SCORER_ENGINE_TYPES as readonly string[]).includes(spec.engineType)) {
    throw new Error(`Unsupported engineType '${spec.engineType}'. Must be one of: ${SCORER_ENGINE_TYPES.join(', ')}`);
  }

  if (spec.outputEnumValues) {
    if (spec.outputEnumValues.length > MAX_ENUM_VALUES) {
      throw new Error(`Too many outputEnumValues: ${spec.outputEnumValues.length} (max ${MAX_ENUM_VALUES}).`);
    }
    const fallbackCount = spec.outputEnumValues.filter((v) => v.isFallback).length;
    if (fallbackCount > 1) {
      throw new Error(`At most one outputEnumValue can be the fallback, but found ${fallbackCount}.`);
    }
  }

  // agentAssociation is schema-required; guard its presence (and a non-empty agentApiName) before dereferencing
  // samplingRate, so a spec omitting or misspelling it (e.g. `agentAssociations`) fails with a clear message
  // rather than a raw `TypeError: Cannot read properties of undefined (reading 'samplingRate')`.
  if (spec.agentAssociation == null) {
    throw new Error('agentAssociation is required.');
  }
  if (typeof spec.agentAssociation.agentApiName !== 'string' || spec.agentAssociation.agentApiName.length === 0) {
    throw new Error('agentAssociation.agentApiName is required.');
  }

  if (spec.agentAssociation.samplingRate != null && (spec.agentAssociation.samplingRate < 0 || spec.agentAssociation.samplingRate > 1)) {
    throw new Error(`samplingRate must be between 0 and 1, but got ${spec.agentAssociation.samplingRate}.`);
  }
}
