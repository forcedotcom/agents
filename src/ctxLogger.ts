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

import { Logger } from '@salesforce/core';

/**
 * Render structured log fields as a `key=value, key=value` string for the `msg-ctx`
 * logging convention (a static message prefix, then ` | `, then this rendering). The
 * same field names are used here as in the structured fields object. This produces a
 * best-effort, human-readable breadcrumb; the structured fields object remains the
 * authoritative, machine-parseable source of truth.
 *
 * Rendering rules:
 * - Non-primitive values (e.g. Error objects) and null/undefined/empty-string/empty-array
 * are omitted — they add no readable signal. Log a primitive projection instead (e.g.
 * `errName`/`errMsg` rather than the whole error).
 * - Arrays are joined with `;` and Dates rendered as ISO.
 * - Control characters (CR/LF/tab) are collapsed to a single space so a field value can
 * never inject a second apparent log line (CWE-117 log forging).
 * - A rendered value containing the pair separator `,` or the message separator `|` is
 * quoted so the pair stays unambiguous to a reader (the intra-array `;` is expected and
 * does not trigger quoting).
 */
const renderLogCtx = (fields: Record<string, unknown>): string =>
  Object.entries(fields)
    .filter(
      ([, v]) =>
        v != null &&
        v !== '' &&
        (typeof v !== 'object' || (Array.isArray(v) && v.length > 0) || v instanceof Date)
    )
    .map(([k, v]) => {
      const raw = Array.isArray(v) ? v.join(';') : v instanceof Date ? v.toISOString() : String(v);
      const sanitized = raw.replace(/[\r\n\t]+/g, ' ');
      const rendered = /[,|]/.test(sanitized) ? `"${sanitized}"` : sanitized;
      return `${k}=${rendered}`;
    })
    .join(', ');

/**
 * Build a `msg-ctx` log message: the static `message` prefix followed by ` | ` and the
 * rendered context. When no field renders to context, the bare message is returned so
 * there is no dangling ` | `. Prefer a {@link CtxLogger} instance, whose level methods
 * render and log in one call so the fields object is passed exactly once and cannot drift
 * from the message.
 */
export const msgCtx = (message: string, fields: Record<string, unknown>): string => {
  const ctx = renderLogCtx(fields);
  return ctx ? `${message} | ${ctx}` : message;
};

/**
 * A thin wrapper around a `@salesforce/core` {@link Logger} that emits `msg-ctx` log lines.
 *
 * Each level method renders `fields` into the message prefix AND passes the same `fields`
 * object as the logger's structured-fields argument, so the human-readable rendering and
 * the structured source-of-truth are guaranteed identical — eliminating the drift that a
 * manual `logger.debug(msgCtx(m, ctx), ctx)` two-arg call risks.
 *
 * Construct one per component with {@link CtxLogger.child}, mirroring `Logger.childFromRoot`,
 * then call it like an ordinary logger:
 *
 * ```ts
 * const logger = CtxLogger.child('AgentPublisher');
 * logger.debug('Publishing agent', { developerName });
 * logger.warn('Failed to trigger indexing', { libraryId, errName, errMsg });
 * ```
 */
export class CtxLogger {
  public constructor(private readonly logger: Logger) {}

  /** Create a `CtxLogger` backed by a named child of the root logger. */
  public static child(name: string): CtxLogger {
    return new CtxLogger(Logger.childFromRoot(name));
  }

  public trace(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.trace(msgCtx(message, fields), fields);
  }

  public debug(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.debug(msgCtx(message, fields), fields);
  }

  public info(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.info(msgCtx(message, fields), fields);
  }

  public warn(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.warn(msgCtx(message, fields), fields);
  }

  public error(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.error(msgCtx(message, fields), fields);
  }
}
