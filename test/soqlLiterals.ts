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
import { expect } from 'chai';

/**
 * A model of how SOQL reads quoted strings, taken from the SOQL and SOSL Reference ("Quoted String
 * Escape Sequences" and "Reserved Characters"): a literal sits between single quotes, the escape
 * character is the backslash, `\\`, `\'`, `\"`, the control-character escapes and `\uXXXX` are
 * valid, and a backslash anywhere else is an error.
 *
 * It models that lexical rule only, not SOQL as a whole. It lets a test check where a value ends
 * up in a query without copying the expected escape text from the code under test.
 */
export type SoqlLex = { literals: string[]; error?: string };

const CONTROL_ESCAPES = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['b', '\b'],
  ['f', '\f'],
]);
const LITERAL_ESCAPES = new Set(['\\', "'", '"']);
const LIKE_ESCAPES = new Set(['_', '%']);

function readLiteral(soql: string, start: number): { value: string; next: number } | { error: string } {
  let value = '';
  let i = start + 1;
  while (i < soql.length) {
    const c = soql.charAt(i);
    if (c === "'") return { value, next: i + 1 };
    if (c !== '\\') {
      value += c;
      i += 1;
      continue;
    }
    const e = soql.charAt(i + 1);
    const control = CONTROL_ESCAPES.get(e.toLowerCase());
    if (e === 'u') {
      const hex = soql.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { error: 'invalid \\u escape' };
      value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else if (control !== undefined) {
      value += control;
      i += 2;
    } else if (LITERAL_ESCAPES.has(e)) {
      value += e;
      i += 2;
    } else if (LIKE_ESCAPES.has(e)) {
      value += `\\${e}`;
      i += 2;
    } else {
      return { error: `invalid escape sequence \\${e}` };
    }
  }
  return { error: 'unterminated string literal' };
}

/** Read the string literals of a SOQL text, or report why it does not lex. */
export function lexSoql(soql: string): SoqlLex {
  const literals: string[] = [];
  let i = 0;
  while (i < soql.length) {
    const c = soql.charAt(i);
    if (c === '\\') return { literals, error: 'backslash outside a string literal' };
    if (c !== "'") {
      i += 1;
      continue;
    }
    const read = readLiteral(soql, i);
    if ('error' in read) return { literals, error: read.error };
    literals.push(read.value);
    i = read.next;
  }
  return { literals };
}

/** Assert that `soql` lexes cleanly and that `value` is the only string literal in it, read back unchanged. */
export function expectOnlyLiteral(soql: string, value: string): void {
  const lexed = lexSoql(soql);
  expect(lexed.error, `SOQL does not lex (${lexed.error ?? ''}): ${soql}`).to.equal(undefined);
  expect(lexed.literals, `the value left its string literal in: ${soql}`).to.deep.equal([value]);
}

/** Values that try to leave a quoted SOQL literal, plus a few harmless ones that must pass through. */
export const HOSTILE_VALUES = [
  "x' OR Type != '",
  "O'Malley",
  "'",
  "''",
  '\\',
  'abc\\',
  "\\' OR Type != \\'",
  "\\\\' OR Type != '",
  '\\u0027 OR Type != \\u0027',
  'line1\nline2',
  '100%_done',
  'ünïcödé',
];

/**
 * What each call site is checked with: one quote breakout and one trailing backslash. That is enough to show
 * that the site goes through `escapeSoqlString`; the helper's own tests run all of HOSTILE_VALUES.
 */
export const SITE_VALUES = ["x' OR Type != '", 'abc\\'];
