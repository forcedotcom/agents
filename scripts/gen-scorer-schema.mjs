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
 * Build-time codegen: derive the scorer YAML spec JSON Schema from the `ScorerSpec` TypeScript type so the
 * type (and its JSDoc) is the single source of truth. The output is git-ignored and regenerated on every
 * `compile` (wireit `gen:scorer-schema`), then imported by src/scorerSpecSchema.ts.
 *
 * To add or change a scorer field, edit `ScorerSpec` in src/agentScorer.ts — nothing here needs to change.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGenerator } from 'ts-json-schema-generator';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'src', 'scorerSpecSchema.generated.ts');

const schema = createGenerator({
  path: join(root, 'src', 'agentScorer.ts'),
  tsconfig: join(root, 'tsconfig.json'),
  type: 'ScorerSpec',
  jsDoc: 'extended',
  skipTypeCheck: true,
  topRef: true,
  additionalProperties: false,
}).createSchema('ScorerSpec');

const header = `/*
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
`;

const body = `/* eslint-disable */
// GENERATED FILE — DO NOT EDIT. Regenerate with \`yarn gen:scorer-schema\` (runs automatically on \`compile\`).
// Source of truth: the \`ScorerSpec\` type in src/agentScorer.ts.
export const SCORER_SPEC_JSON_SCHEMA: Record<string, unknown> = ${JSON.stringify(schema, null, 2)};
`;

writeFileSync(outFile, `${header}${body}`);
// eslint-disable-next-line no-console
console.log(`Generated ${outFile}`);
