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

// The schema object is generated from the `ScorerSpec` type at build time (see scripts/gen-scorer-schema.mjs)
// and is git-ignored. Editing scorer fields happens in `ScorerSpec` (src/agentScorer.ts) — the single source
// of truth — never here or in the generated file.
import { SCORER_SPEC_JSON_SCHEMA } from './scorerSpecSchema.generated';

export { SCORER_SPEC_JSON_SCHEMA };

/**
 * Returns the JSON Schema (draft-07) for the scorer YAML spec file, derived from the {@link ScorerSpec} type.
 *
 * Consumers (e.g. `sf agent scorer create --spec-schema`) can surface this to help authors write a valid spec.
 * Returns the same object reference on every call — treat it as read-only.
 */
export function scorerSpecJsonSchema(): Record<string, unknown> {
  return SCORER_SPEC_JSON_SCHEMA;
}
