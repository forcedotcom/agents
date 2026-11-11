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

// The schema object is generated from the `SessionView` type at build time (see scripts/gen-scorer-schema.mjs)
// and is git-ignored. Editing session fields happens in `SessionView` (src/agentScorers/types.ts) — the single
// source of truth — never here or in the generated file.
import { SESSION_VIEW_JSON_SCHEMA } from './sessionViewSchema.generated';

export { SESSION_VIEW_JSON_SCHEMA };

/**
 * Returns the JSON Schema (draft-07) for the STDM session detail view, derived from the {@link SessionView} type.
 *
 * This is the shape of the `Input:Session` value a scorer runs against. Consumers (e.g. `sf agent scorer run`)
 * can surface it to help authors hand-construct a valid session JSON. Returns the same object reference on every
 * call — treat it as read-only.
 */
export function sessionViewJsonSchema(): Record<string, unknown> {
  return SESSION_VIEW_JSON_SCHEMA;
}
