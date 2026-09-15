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

import { type SessionView } from './types';

// The platform validates every timestamp in the Input:Session against a strict regex:
//   YYYY-MM-DDTHH:MM:SS(.mmm)?±HHMM
// i.e. the UTC offset must be ±HHMM with no colon, and fractional seconds must be exactly 3 digits or absent.
// Real STDM / Data Cloud data (and captured session fixtures) routinely use `+00:00`, `Z`, or 1-2 fractional
// digits, which the platform rejects with a wall of cryptic per-field regex errors. This normalizer reshapes
// each timestamp to the accepted format WITHOUT changing the instant, so callers can pass real data verbatim.
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2}:?\d{2}|Z)$/;

function normalizeTimestamp(value: string): string {
  const m = TIMESTAMP_RE.exec(value);
  if (!m) return value; // not a shape we recognize — leave it for the platform to validate
  const [, base, frac, offset] = m;
  const normOffset = offset === 'Z' ? '+0000' : offset.replace(':', '');
  if (frac === undefined) return `${base}${normOffset}`;
  return `${base}.${`${frac}000`.slice(0, 3)}${normOffset}`;
}

// Guards against pathological (deeply nested or cyclic-looking) input blowing the call stack with a raw,
// confusing RangeError; real STDM sessions never nest anywhere near this deep.
const MAX_NORMALIZE_DEPTH = 200;

/** Recursively normalize every timestamp string (any key ending in "timestamp") to the platform's format. */
function normalizeTimestampsDeep(node: unknown, depth = 0): unknown {
  if (depth > MAX_NORMALIZE_DEPTH) {
    throw new Error(
      `Session data is nested more than ${MAX_NORMALIZE_DEPTH} levels deep; refusing to normalize it.`
    );
  }
  if (Array.isArray(node)) {
    return node.map((el) => normalizeTimestampsDeep(el, depth + 1));
  }
  if (node !== null && typeof node === 'object') {
    // Object.create(null) has no Object.prototype, so a field literally named "__proto__" is assigned as an
    // ordinary own data property instead of being silently swallowed by the prototype setter.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, val] of Object.entries(node)) {
      out[key] =
        typeof val === 'string' && key.toLowerCase().endsWith('timestamp')
          ? normalizeTimestamp(val)
          : normalizeTimestampsDeep(val, depth + 1);
    }
    return out;
  }
  return node;
}

/**
 * Return a copy of the session with all timestamps normalized to the format the platform's Input:Session
 * validation accepts (±HHMM offset, 3-or-0 fractional digits). Same instant, accepted shape — so real STDM
 * data can be scored without hand-editing. The input is not mutated.
 */
export function normalizeSession(session: SessionView): SessionView {
  return normalizeTimestampsDeep(session) as SessionView;
}
