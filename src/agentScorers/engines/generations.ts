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

import { type Connection } from '@salesforce/core';
import { type ScorerResult, type ValueMap } from '../types';

type GenerationsResponse = { generations?: Array<{ text?: string }> };
type GenerationsError = Array<{ message?: string }>;

/**
 * Invoke a deployed prompt template against one set of inputs and return the model's generation. This is the
 * "prompt builder generate" step — a POST to the prompt-templates generations endpoint.
 *
 * `isPreview: false` requests a real model call (not a dry-run preview).
 */
export async function generate(connection: Connection, apiName: string, valueMap: ValueMap): Promise<ScorerResult> {
  const body = {
    isPreview: false,
    inputParams: { valueMap },
    additionalConfig: {
      numGenerations: 1,
      enablePiiMasking: false,
      applicationName: 'PromptBuilderPreview',
    },
  };
  const url = `/services/data/v${String(connection.version)}/einstein/prompt-templates/${apiName}/generations`;

  let resp: unknown;
  try {
    resp = await connection.request<unknown>({
      method: 'POST',
      url,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // API errors come back as an array of {errorCode, message}.
  if (Array.isArray(resp)) {
    return { ok: false, error: (resp as GenerationsError)[0]?.message ?? 'generations API error' };
  }

  // Guard against a null/empty/malformed body: `resp.generations` and `gens[0].text` must not be dereferenced
  // on anything but a real object, or a null/empty response throws instead of returning {ok:false}.
  const gens = resp !== null && typeof resp === 'object' ? (resp as GenerationsResponse).generations ?? [] : [];
  const firstGen: { text?: string } | undefined = gens[0];
  if (!gens.length || firstGen === null || typeof firstGen !== 'object') {
    return { ok: false, error: 'no generations returned (is the template deployed & published?)' };
  }

  const text = firstGen.text ?? '';
  // Scorer templates emit JSON in one of two shapes:
  //   legacy:     {"output": <number|["Label"]>, "explanation": "..."}
  //   open-ended: {"outputs": [{"label": "...", "value": <n|"..">, "isPassed": bool}], "explanation": "..."}
  try {
    const parsed: unknown = JSON.parse(text);
    // A bare scalar or array (e.g. `9`, `["A","B"]`) is the score itself, not the envelope object; only the
    // latter carries `output`/`outputs`.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: true, output: coerceOutput(parsed), raw: text };
    }
    const obj = parsed as {
      output?: ScorerResult['output'];
      outputs?: Array<{ label?: string | null; value?: number | string | null }>;
      explanation?: string;
    };
    return { ok: true, output: extractOutput(obj), explanation: obj.explanation, raw: text };
  } catch {
    // Fall back to the raw text; the caller's coercion handles loose formats.
    return { ok: true, output: text, raw: text };
  }
}

/** Coerce a bare (non-envelope) parsed JSON value into the ScorerResult['output'] shape. */
function coerceOutput(value: unknown): ScorerResult['output'] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

/**
 * Normalize the two template response shapes into a single `output`. The open-ended `outputs[]` shape carries
 * the score in each entry's `value` (or `label` when there's no value); a single entry collapses to a scalar,
 * multiple entries to a string array. Falls back to the legacy top-level `output`.
 */
function extractOutput(obj: {
  output?: ScorerResult['output'];
  outputs?: Array<{ label?: string | null; value?: number | string | null }>;
}): ScorerResult['output'] {
  if (Array.isArray(obj.outputs)) {
    const picked = obj.outputs
      .map((o) => (o.value ?? o.label))
      .filter((v): v is number | string => v !== null && v !== undefined);
    if (picked.length === 1) return picked[0];
    if (picked.length > 1) return picked.map(String);
  }
  return obj.output;
}
