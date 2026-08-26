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
import { Logger } from '@salesforce/core';
import { CtxLogger, msgCtx } from '../src/ctxLogger';

describe('msgCtx', () => {
  it('appends rendered context after " | " and keeps the static prefix', () => {
    expect(msgCtx('Retry limit exceeded', { retryCount: 3, maxRetries: 3 })).to.equal(
      'Retry limit exceeded | retryCount=3, maxRetries=3'
    );
  });

  it('returns the bare message when no field renders to context', () => {
    expect(msgCtx('Nothing to see', { err: new Error('boom'), missing: undefined, empty: '' })).to.equal(
      'Nothing to see'
    );
  });

  it('omits null, undefined, empty strings, empty arrays, and non-primitive objects', () => {
    expect(msgCtx('m', { a: [], b: '', c: null, d: undefined, e: { nested: 1 }, f: 1 })).to.equal('m | f=1');
  });

  it('joins arrays with ";" and renders Dates as ISO', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    expect(msgCtx('m', { items: ['a', 'b'], when })).to.equal('m | items=a;b, when=2026-01-02T03:04:05.000Z');
  });

  it('collapses CR/LF/tab so a value cannot forge a second log line (CWE-117)', () => {
    const rendered = msgCtx('m', { agentName: 'Acme\n2026 INFO forged' });
    expect(rendered).to.not.match(/[\r\n\t]/);
    expect(rendered).to.equal('m | agentName=Acme 2026 INFO forged');
  });

  it('quotes values that contain a separator so the pair stays unambiguous', () => {
    expect(msgCtx('m', { url: 'x?a=1,b=2' })).to.equal('m | url="x?a=1,b=2"');
  });
});

describe('CtxLogger', () => {
  type Call = { level: string; args: unknown[] };

  const makeLogger = (): { calls: Call[]; ctx: CtxLogger } => {
    const calls: Call[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]): void => {
        calls.push({ level, args });
      };
    const fake = {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    return { calls, ctx: new CtxLogger(fake as unknown as Logger) };
  };

  it('forwards to the matching level with the rendered message and the same fields object', () => {
    const { calls, ctx } = makeLogger();
    const fields = { url: 'x?a=1,b=2', statusCode: 404 };

    ctx.warn('Request failed', fields);

    expect(calls).to.have.lengthOf(1);
    expect(calls[0].level).to.equal('warn');
    // First arg is the rendered msg-ctx string...
    expect(calls[0].args[0]).to.equal('Request failed | url="x?a=1,b=2", statusCode=404');
    // ...and the SAME fields object is passed through as the structured source of truth.
    expect(calls[0].args[1]).to.equal(fields);
  });

  it('routes each level to its own underlying method', () => {
    const { calls, ctx } = makeLogger();
    ctx.trace('t');
    ctx.debug('d');
    ctx.info('i');
    ctx.error('e');
    expect(calls.map((c) => c.level)).to.deep.equal(['trace', 'debug', 'info', 'error']);
  });

  it('logs a bare message with an empty fields object when fields are omitted', () => {
    const { calls, ctx } = makeLogger();
    ctx.debug('No context here');
    expect(calls[0].args[0]).to.equal('No context here');
    expect(calls[0].args[1]).to.deep.equal({});
  });
});
