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
import { getHttpStatusCode } from '../../utils';
import { type ScorerResult, type ValueMap } from '../types';

type GenerationsResponse = { generations?: Array<{ text?: string }> };
type GenerationsError = Array<{ errorCode?: string; message?: string }>;

/** A normalized view of a failed generations attempt, from either a thrown error or an API error array. */
type FailureSignal = { statusCode?: number; code?: string; message: string; retryAfterMs?: number };

/** The outcome of one generations POST, before the retry loop decides whether to try again. */
type Attempt = { kind: 'ok'; text: string } | { kind: 'empty' } | { kind: 'failure'; signal: FailureSignal };

/** Retry defaults: a small, bounded number of tries so a genuinely-down gateway still fails reasonably fast. */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
/** Cap on an honored `Retry-After`, so a hostile/huge value can't stall a run. */
const MAX_RETRY_AFTER_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter (`random in [0, base * 2^attempt]`) so concurrent runs de-synchronize. */
function backoffDelayMs(baseDelayMs: number, attempt: number): number {
  return Math.round(Math.random() * baseDelayMs * 2 ** attempt);
}

/** Best-effort read of a `Retry-After` hint (HTTP spec: seconds) from an error/response; capped, else undefined. */
function retryAfterMs(err: unknown): number | undefined {
  const e = err as { retryAfter?: unknown; response?: { headers?: Record<string, unknown> } };
  const raw = e?.retryAfter ?? e?.response?.headers?.['retry-after'] ?? e?.response?.headers?.['Retry-After'];
  const secs = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * Classify a generations failure so callers can tell the causes apart (and so the retry loop knows what is
 * transient). `throttled` and `unavailable` are transient gateway conditions worth retrying; `error` is not.
 * We look at both the HTTP status and the Salesforce error code/message text, because the org's shared LLM
 * gateway surfaces overload as a numeric 429/5xx *or* as a semantic code like REQUEST_LIMIT_EXCEEDED.
 */
export function classifyFailure(sig: FailureSignal): 'throttled' | 'unavailable' | 'error' {
  const text = `${sig.code ?? ''} ${sig.message}`;
  if (sig.statusCode === 429 || /too many requests|rate.?limit|request_limit_exceeded|throttl/i.test(text)) {
    return 'throttled';
  }
  if (
    (sig.statusCode !== undefined && sig.statusCode >= 500 && sig.statusCode <= 599) ||
    /service.?unavailable|temporarily unavailable|gateway.?time.?out|bad.?gateway/i.test(text)
  ) {
    return 'unavailable';
  }
  return 'error';
}

/** Turn a classified failure into a disambiguated, actionable message (the four causes used to collapse to one). */
function failureMessage(sig: FailureSignal): string {
  const status = sig.statusCode !== undefined ? ` (HTTP ${sig.statusCode})` : '';
  const kind = classifyFailure(sig);
  if (kind === 'throttled') {
    return `LLM gateway throttled${status}: ${sig.message}. Space out scorer runs and retry — a burst of runs can throttle the org's shared LLM gateway for every scorer at once.`;
  }
  if (kind === 'unavailable') {
    return `LLM gateway unavailable${status}: ${sig.message}. This is usually transient — retry shortly.`;
  }
  return sig.statusCode !== undefined ? `generations request failed${status}: ${sig.message}` : sig.message;
}

/**
 * Invoke a deployed prompt template against one set of inputs and return the model's generation. This is the
 * "prompt builder generate" step — a POST to the prompt-templates generations endpoint.
 *
 * `isPreview: false` requests a real model call (not a dry-run preview).
 *
 * Transient gateway failures (throttle/unavailable) are retried with bounded, jittered backoff — a burst of
 * scorer runs can throttle the org's shared LLM gateway, and a single retry-less POST would then fail the run
 * outright. A genuine error (4xx, template misconfig, empty completion) fails fast without wasting retries.
 */
export async function generate(
  connection: Connection,
  apiName: string,
  valueMap: ValueMap,
  options: { preferLabel?: boolean; retry?: { maxAttempts?: number; baseDelayMs?: number } } = {}
): Promise<ScorerResult> {
  const body = JSON.stringify({
    isPreview: false,
    inputParams: { valueMap },
    additionalConfig: {
      numGenerations: 1,
      enablePiiMasking: false,
      applicationName: 'PromptBuilderPreview',
    },
  });
  const url = `/services/data/v${String(connection.version)}/einstein/prompt-templates/${apiName}/generations`;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let signal: FailureSignal | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await attemptGenerate(connection, url, body);
    if (outcome.kind === 'ok') return parseGeneration(outcome.text, options.preferLabel ?? false);
    if (outcome.kind === 'empty') return { ok: false, error: emptyGenerationsMessage(apiName) };

    signal = outcome.signal;
    const kind = classifyFailure(signal);
    // Only transient gateway conditions are worth retrying; everything else fails fast.
    const transient = kind === 'throttled' || kind === 'unavailable';
    if (!transient || attempt === maxAttempts - 1) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(signal.retryAfterMs ?? backoffDelayMs(baseDelayMs, attempt));
  }
  return { ok: false, error: failureMessage(signal as FailureSignal) };
}

/** One generations POST, normalized into an {@link Attempt} — it never throws for an HTTP/API-shaped failure. */
async function attemptGenerate(connection: Connection, url: string, body: string): Promise<Attempt> {
  let resp: unknown;
  try {
    resp = await connection.request<unknown>({
      method: 'POST',
      url,
      body,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return {
      kind: 'failure',
      signal: { statusCode: getHttpStatusCode(err), message: (err as Error).message, retryAfterMs: retryAfterMs(err) },
    };
  }

  // API errors come back as an array of {errorCode, message}.
  if (Array.isArray(resp)) {
    const first = (resp as GenerationsError)[0];
    return {
      kind: 'failure',
      signal: { statusCode: getHttpStatusCode(first), code: first?.errorCode, message: first?.message ?? 'generations API error' },
    };
  }

  // Guard against a null/empty/malformed body: `resp.generations` and `gens[0].text` must not be dereferenced
  // on anything but a real object, or a null/empty response throws instead of returning {ok:false}.
  const gens = resp !== null && typeof resp === 'object' ? (resp as GenerationsResponse).generations ?? [] : [];
  const firstGen: { text?: string } | undefined = gens[0];
  if (!gens.length || firstGen === null || typeof firstGen !== 'object') {
    return { kind: 'empty' };
  }
  // A present-but-blank completion (no `text`, or whitespace only — e.g. a content-filtered / safety-refused
  // response) carries no score. Treat it the same as an absent generation so the run fails, rather than letting
  // `parseGeneration('')` fall through to a passing empty score.
  const text = firstGen.text;
  if (typeof text !== 'string' || text.trim() === '') {
    return { kind: 'empty' };
  }
  return { kind: 'ok', text };
}

/**
 * A 200 with no completion has several distinct causes that used to hide behind one string. We can't tell them
 * apart from the (empty) body alone, so we name the template and enumerate the likely culprits. Not retried:
 * most causes are genuine template problems, and blindly retrying a real bug just wastes time (and can worsen a
 * throttle) — the message tells the reader to retry when a throttle is the actual cause.
 */
function emptyGenerationsMessage(apiName: string): string {
  return `no generations returned for template '${apiName}'. Likely causes: the template is not deployed & published; its configured model is not enabled in this org; the template has multiple same-content versions (which collide in the serving layer); or the org's shared LLM gateway is throttled. If other scorers are failing at the same time, it's the gateway — space out runs and retry.`;
}

/**
 * A well-formed but score-less envelope: the request succeeded and the JSON parsed, but it carried an empty or
 * all-null `outputs[]` and no legacy `output`. Distinct from a blank completion (see emptyGenerationsMessage) —
 * here the model responded with structure but no score — so it points at the prompt/rubric rather than the
 * template/gateway.
 */
function noUsableScoreMessage(): string {
  return 'the model returned no usable score: the response had an empty or all-null "outputs" array and no "output" value. Check the scorer prompt/rubric so the model emits a label or value, then retry.';
}

/** Parse a successful generation's text into a ScorerResult, tolerating both envelope shapes and bare scalars. */
function parseGeneration(text: string, preferLabel: boolean): ScorerResult {
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
    const output = extractOutput(obj, preferLabel);
    // A parseable envelope that carries no score (empty/all-null `outputs[]` and no legacy `output`) is a failed
    // evaluation, not a passing empty one — mirror the empty-completion guard so `run` reports ok:false rather
    // than "Outcome: ok" with no Output line, which a scripted loop would mistake for a pass.
    if (output === undefined || output === null) {
      return { ok: false, error: noUsableScoreMessage(), explanation: obj.explanation, raw: text };
    }
    return { ok: true, output, explanation: obj.explanation, raw: text };
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
 * Normalize the two template response shapes into a single `output`.
 *
 * Each open-ended `outputs[]` entry carries both a categorical `label` and a typed `value`, and which one is
 * the score depends on the scorer. A scorer with predefined labels (`preferLabel`) is classified by its
 * `label` — its `value` is free-form and, for a text scorer, often just echoes the value's JSON schema
 * (e.g. `{"type":"string"}`) — so the label wins. A typed scorer (number/boolean/…) emits no label and
 * carries its score in `value`. A single entry collapses to a scalar, multiple entries to a string array.
 * Falls back to the legacy top-level `output`.
 */
function extractOutput(
  obj: {
    output?: ScorerResult['output'];
    outputs?: Array<{ label?: string | null; value?: number | string | null }>;
  },
  preferLabel: boolean
): ScorerResult['output'] {
  if (Array.isArray(obj.outputs)) {
    const picked = obj.outputs
      .map((o) => pickEntryScore(o, preferLabel))
      .filter((v): v is number | string => v !== null && v !== undefined);
    if (picked.length === 1) return picked[0];
    if (picked.length > 1) return picked.map(String);
  }
  return obj.output;
}

/**
 * The score of one `outputs[]` entry. For a label scorer the categorical `label` is authoritative and the
 * `value` is only a fallback (used when the model omits the label); for a typed scorer the `value` is the
 * score and the `label` the fallback. A blank/whitespace-only label counts as absent.
 */
function pickEntryScore(
  o: { label?: string | null; value?: number | string | null },
  preferLabel: boolean
): number | string | null | undefined {
  if (preferLabel && typeof o.label === 'string' && o.label.trim() !== '') return o.label;
  return o.value ?? o.label;
}
