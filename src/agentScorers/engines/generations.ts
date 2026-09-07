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

  let resp: GenerationsResponse | GenerationsError;
  try {
    resp = await connection.request<GenerationsResponse | GenerationsError>({
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
    return { ok: false, error: resp[0]?.message ?? 'generations API error' };
  }

  const gens = resp.generations ?? [];
  if (!gens.length) {
    return { ok: false, error: 'no generations returned (is the template deployed & published?)' };
  }

  const text = gens[0].text ?? '';
  // Scorer templates emit JSON: {"output": <number|["Label"]>, "explanation": "..."}
  try {
    const obj = JSON.parse(text) as { output?: ScorerResult['output']; explanation?: string };
    return { ok: true, output: obj.output, explanation: obj.explanation, raw: text };
  } catch {
    // Fall back to the raw text; the caller's coercion handles loose formats.
    return { ok: true, output: text, raw: text };
  }
}
