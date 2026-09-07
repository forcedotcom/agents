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
 * Build-time codegen: derive JSON Schemas from TypeScript types so the types (and their JSDoc) are the single
 * source of truth. The outputs are git-ignored and regenerated on every `compile` (wireit `gen:scorer-schema`),
 * then imported by their wrapper modules:
 *   - `ScorerSpec`  → src/agentScorers/scorerSpecSchema.generated.ts  (imported by src/agentScorers/scorerSpecSchema.ts)
 *   - `SessionView` → src/agentScorers/sessionViewSchema.generated.ts (imported by src/agentScorers/sessionViewSchema.ts)
 *
 * To add or change a field, edit the type in src/agentScorers/types.ts — nothing here needs to change.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGenerator } from 'ts-json-schema-generator';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const typesPath = join(root, 'src', 'agentScorers', 'types.ts');
const tsconfig = join(root, 'tsconfig.json');

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

/** Generate a JSON Schema for `type` and write it to `outFile` as an exported `constName`. */
function generate({ type, constName, outFile }) {
  const schema = createGenerator({
    path: typesPath,
    tsconfig,
    type,
    jsDoc: 'extended',
    skipTypeCheck: true,
    topRef: true,
    additionalProperties: false,
  }).createSchema(type);

  const body = `/* eslint-disable */
// GENERATED FILE — DO NOT EDIT. Regenerate with \`yarn gen:scorer-schema\` (runs automatically on \`compile\`).
// Source of truth: the \`${type}\` type in src/agentScorers/types.ts.
export const ${constName}: Record<string, unknown> = ${JSON.stringify(schema, null, 2)};
`;

  writeFileSync(outFile, `${header}${body}`);
  // eslint-disable-next-line no-console
  console.log(`Generated ${outFile}`);
}

generate({
  type: 'ScorerSpec',
  constName: 'SCORER_SPEC_JSON_SCHEMA',
  outFile: join(root, 'src', 'agentScorers', 'scorerSpecSchema.generated.ts'),
});

generate({
  type: 'SessionView',
  constName: 'SESSION_VIEW_JSON_SCHEMA',
  outFile: join(root, 'src', 'agentScorers', 'sessionViewSchema.generated.ts'),
});
