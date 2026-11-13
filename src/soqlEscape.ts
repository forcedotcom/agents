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
 * Escape a value so it can be placed between single quotes in a SOQL string literal.
 *
 * The escape character in SOQL is the backslash: `\'` is a single quote and `\\` is a backslash
 * (SOQL and SOSL Reference, "Quoted String Escape Sequences"). Doubling the quote, as ANSI SQL
 * does, is not a SOQL escape. Backslashes are escaped in the same pass so that a value that
 * already contains `\` cannot cancel the escape added in front of a quote, and so that a value
 * ending in `\` cannot escape the closing quote.
 *
 * `%` and `_` are left alone on purpose: SOQL only accepts them escaped inside LIKE expressions.
 *
 * @param value the text to place inside a quoted SOQL literal
 * @returns the escaped text, without the surrounding quotes
 */
export function escapeSoqlString(value: string): string {
  return value.replace(/[\\']/g, '\\$&');
}
