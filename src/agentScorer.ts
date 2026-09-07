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
 * Public entry point for the agent scorer feature. The two headline operations — `createScorerDefinition`
 * (generate scorer + prompt-template metadata from a typed `ScorerSpec`) and `runScorer` (run a scorer
 * against an STDM session and return its score) — are defined here, composed from the internal business logic
 * in ./agentScorers (the model/types, validation, prompt/XML builders, and the run-time engines).
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Connection } from '@salesforce/core';
import { type ScorerSpec, type ScorerCreateResult, type ScorerResult, type SessionView } from './agentScorers/types';
import { validateScorerSpec } from './agentScorers/validate';
import { buildDefaultPromptContent } from './agentScorers/promptContent';
import { buildScorerXml, buildPromptTemplateXml, parseScorerXml } from './agentScorers/xml';
import { normalizeSession } from './agentScorers/session';
import { getEngine, supportedEngineTypes } from './agentScorers/engines/registry';

// Re-export the scorer feature's public surface so consumers import everything from this one root module.
export * from './agentScorers/types';
export { isValidScorerApiName, labelToApiName, validateScorerSpec } from './agentScorers/validate';
export { buildDefaultPromptContent } from './agentScorers/promptContent';
export { buildScorerXml, buildPromptTemplateXml, parseScorerXml } from './agentScorers/xml';
export { normalizeSession } from './agentScorers/session';
export { registerEngine, getEngine, supportedEngineTypes } from './agentScorers/engines/registry';

/** File-name suffix of a scorer definition in project metadata. */
const SCORER_METADATA_SUFFIX = '.aiAgentScorerDefinition-meta.xml';

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
    promptTemplateXml = buildPromptTemplateXml(spec.apiName, content);
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

/** Recursively look for a file named `fileName` under `dir`, returning its full path or undefined. */
async function findScorerFile(dir: string, fileName: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined; // directory missing or unreadable — treat as "not here"
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      const found = await findScorerFile(full, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return undefined;
}

/**
 * Resolve a scorer authored into local project metadata to its typed spec, by API name.
 *
 * Searches the given directories (a project's package directories) for the scorer's
 * `<apiName>.aiAgentScorerDefinition-meta.xml` file and parses it. This is how a caller turns a bare API name
 * into the `ScorerSpec` that `runScorer` needs.
 *
 * @throws if no matching scorer definition exists under any of the directories.
 */
export async function loadScorerSpec(options: { apiName: string; directories: string[] }): Promise<ScorerSpec> {
  const { apiName, directories } = options;
  const fileName = `${apiName}${SCORER_METADATA_SUFFIX}`;
  for (const dir of directories) {
    // eslint-disable-next-line no-await-in-loop
    const found = await findScorerFile(dir, fileName);
    if (found) {
      // eslint-disable-next-line no-await-in-loop
      return parseScorerXml(await readFile(found, 'utf8'), apiName);
    }
  }
  throw new Error(
    `No scorer named '${apiName}' was found in this project. Expected a '${fileName}' file under one of: ${directories.join(
      ', '
    )}. Author it first with \`sf agent scorer create\`.`
  );
}

/**
 * Run a scorer against one STDM session and return its score.
 *
 * Takes the typed scorer definition directly, so it does no metadata fetching or XML parsing: the caller
 * supplies a `ScorerSpec` (authored locally, or retrieved and deserialized) and this dispatches to the engine
 * registered for the scorer's engineType.
 *
 * @param spec       The typed scorer definition. Its engineType selects the engine.
 * @param session    The STDM session detail view to score.
 * @param connection Connection to the org the scorer runs against.
 * @throws if the scorer's engineType has no registered engine (e.g. 'Manual').
 */
export function runScorer(spec: ScorerSpec, session: SessionView, connection: Connection): Promise<ScorerResult> {
  const engine = getEngine(spec.engineType);
  if (!engine) {
    throw new Error(
      `Running scorer '${spec.apiName}' is not available: no engine implemented for engineType '${spec.engineType}'. ` +
        `Supported: ${supportedEngineTypes().join(', ')}.`
    );
  }
  // Normalize timestamps to the format the platform's Input:Session validation accepts, so real STDM data
  // (which uses `+00:00` / `Z` / variable fractional precision) can be scored without hand-editing.
  return engine.run({ spec, session: normalizeSession(session), connection });
}
