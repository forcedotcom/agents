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

  it('forwards to the matching level as one merging object: fields top-level plus the rendered msg', () => {
    const { calls, ctx } = makeLogger();
    const fields = { url: 'x?a=1,b=2', statusCode: 404 };

    ctx.warn('Request failed', fields);

    expect(calls).to.have.lengthOf(1);
    expect(calls[0].level).to.equal('warn');
    // A single merging object is passed — not a (message, fields) pair — so the sf-core logger
    // does not collapse it into a numeric-keyed array (see CtxLogger.emit / OBS-1).
    expect(calls[0].args).to.have.lengthOf(1);
    // Each field is a top-level key, and the msg-ctx rendering is under `msg`.
    expect(calls[0].args[0]).to.deep.equal({
      url: 'x?a=1,b=2',
      statusCode: 404,
      msg: 'Request failed | url="x?a=1,b=2", statusCode=404',
    });
  });

  it('routes each level to its own underlying method', () => {
    const { calls, ctx } = makeLogger();
    ctx.trace('t');
    ctx.debug('d');
    ctx.info('i');
    ctx.error('e');
    expect(calls.map((c) => c.level)).to.deep.equal(['trace', 'debug', 'info', 'error']);
  });

  it('logs the bare message under `msg` when fields are omitted', () => {
    const { calls, ctx } = makeLogger();
    ctx.debug('No context here');
    expect(calls[0].args).to.have.lengthOf(1);
    expect(calls[0].args[0]).to.deep.equal({ msg: 'No context here' });
  });

  it('does not let a field named `msg` clobber the rendered message', () => {
    const { calls, ctx } = makeLogger();
    ctx.debug('Real message', { msg: 'attacker-supplied', id: 7 });
    // `msg` is written last, so the rendered msg-ctx string wins over any `msg` field.
    expect(calls[0].args[0]).to.deep.equal({ id: 7, msg: 'Real message | msg=attacker-supplied, id=7' });
  });

  // Regression guard for OBS-1: the fake-logger tests above assert the call *shape*, but the
  // bug was in how @salesforce/core's Logger + pino serialize that call. This drives a real
  // Logger end-to-end and inspects the emitted record.
  it('emits a real record with `msg` set and every field as a top-level key (OBS-1)', () => {
    const root = new Logger({ name: 'ctxLoggerTest', useMemoryLogger: true });
    const child = root.child('Component');
    child.setLevel(Logger.getLevelByName('trace'));

    // sf-core's memory logger buffers into a shared global root, so isolate this call's output.
    const before = root.getBufferedRecords().length;
    new CtxLogger(child).warn('Request failed', { url: 'x?a=1,b=2', statusCode: 404 });
    const records = root.getBufferedRecords().slice(before) as Array<Record<string, unknown>>;

    expect(records).to.have.lengthOf(1);
    const record = records[0];
    // The human-readable msg-ctx string lands under `msg`, not a numeric key.
    expect(record.msg).to.equal('Request failed | url="x?a=1,b=2", statusCode=404');
    // Fields are top-level and searchable, not nested under "0"/"1".
    expect(record.url).to.equal('x?a=1,b=2');
    expect(record.statusCode).to.equal(404);
    expect(record).to.not.have.property('0');
    expect(record).to.not.have.property('1');
  });
});
