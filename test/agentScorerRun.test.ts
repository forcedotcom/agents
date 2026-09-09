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
import { type Connection } from '@salesforce/core';
import { normalizeSession, runScorer } from '../src/agentScorer';
import { generate } from '../src/agentScorers/engines/generations';
import { promptTemplateEngine } from '../src/agentScorers/engines/promptTemplateEngine';
import type { SessionView, ScorerSpec, ValueMap } from '../src/agentScorer';

/** Build a minimal-but-typed SessionView, letting a test override just the timestamps it cares about. */
function makeSession(overrides: {
  startTimestamp?: string;
  msgTimestamp?: string;
  stepStart?: string;
  runStart?: string;
}): SessionView {
  return {
    sessionState: {
      sessionId: 's1',
      startTimestamp: overrides.startTimestamp ?? '2026-01-01T00:00:00+0000',
      channel: 'web',
    },
    actors: [{ id: 'a1', participantObject: 'User', role: 'user' }],
    metrics: { durationMs: 1000, turns: 1 },
    runs: [
      {
        runId: 'r1',
        topicName: 'topic',
        startTimestamp: overrides.runStart ?? '2026-01-01T00:00:00+0000',
        endTimestamp: '2026-01-01T00:00:01+0000',
        durationMs: 1000,
        messages: [
          {
            message: 'hi',
            timestamp: overrides.msgTimestamp ?? '2026-01-01T00:00:00+0000',
            actorRole: 'user',
            actorId: 'a1',
            type: 'text',
          },
        ],
        agentLoop: {
          steps: [
            {
              stepId: 'st1',
              type: 'reasoning',
              name: 'think',
              startTimestamp: overrides.stepStart ?? '2026-01-01T00:00:00+0000',
              endTimestamp: '2026-01-01T00:00:01+0000',
              durationMs: 1000,
            },
          ],
        },
      },
    ],
  };
}

/** A fake Connection whose `request` returns a canned generations payload; records the version used in the URL. */
function fakeConnection(response: unknown): Connection {
  return {
    version: '64.0',
    request: () => Promise.resolve(response),
  } as unknown as Connection;
}

/** A fake Connection that also captures the request body, so a test can inspect the valueMap that was sent. */
function capturingConnection(response: unknown): { connection: Connection; valueMap: () => ValueMap } {
  let capturedBody: string | undefined;
  const connection = {
    version: '64.0',
    request: (req: { body?: string }) => {
      capturedBody = req.body;
      return Promise.resolve(response);
    },
  } as unknown as Connection;
  return {
    connection,
    valueMap: () => (JSON.parse(capturedBody ?? '{}') as { inputParams: { valueMap: ValueMap } }).inputParams.valueMap,
  };
}

describe('normalizeSession', () => {
  it("rewrites a `Z` offset to +0000 without changing the instant", () => {
    const out = normalizeSession(makeSession({ startTimestamp: '2026-01-01T12:00:00Z' }));
    expect(out.sessionState.startTimestamp).to.equal('2026-01-01T12:00:00+0000');
  });

  it('strips the colon out of a ±HH:MM offset', () => {
    const out = normalizeSession(makeSession({ startTimestamp: '2026-01-01T12:00:00+00:00' }));
    expect(out.sessionState.startTimestamp).to.equal('2026-01-01T12:00:00+0000');
  });

  it('pads fractional seconds to exactly 3 digits', () => {
    const out = normalizeSession(makeSession({ startTimestamp: '2026-01-01T12:00:00.84+00:00' }));
    expect(out.sessionState.startTimestamp).to.equal('2026-01-01T12:00:00.840+0000');
  });

  it('truncates over-long fractional seconds to 3 digits', () => {
    const out = normalizeSession(makeSession({ startTimestamp: '2026-01-01T12:00:00.123456Z' }));
    expect(out.sessionState.startTimestamp).to.equal('2026-01-01T12:00:00.123+0000');
  });

  it('normalizes timestamps nested in runs, messages, and steps', () => {
    const out = normalizeSession(
      makeSession({
        runStart: '2026-01-01T00:00:00-05:00',
        msgTimestamp: '2026-01-01T00:00:00.5Z',
        stepStart: '2026-01-01T00:00:00+00:00',
      })
    );
    expect(out.runs[0].startTimestamp).to.equal('2026-01-01T00:00:00-0500');
    expect(out.runs[0].messages[0].timestamp).to.equal('2026-01-01T00:00:00.500+0000');
    expect(out.runs[0].agentLoop.steps[0].startTimestamp).to.equal('2026-01-01T00:00:00+0000');
  });

  it('leaves non-timestamp string fields untouched', () => {
    const out = normalizeSession(makeSession({}));
    expect(out.sessionState.channel).to.equal('web');
    expect(out.runs[0].topicName).to.equal('topic');
  });

  it('leaves an already-normalized timestamp unchanged (idempotent)', () => {
    const once = normalizeSession(makeSession({ startTimestamp: '2026-01-01T12:00:00.840+0000' }));
    const twice = normalizeSession(once);
    expect(twice.sessionState.startTimestamp).to.equal('2026-01-01T12:00:00.840+0000');
  });

  it('does not mutate the input session', () => {
    const input = makeSession({ startTimestamp: '2026-01-01T12:00:00Z' });
    normalizeSession(input);
    expect(input.sessionState.startTimestamp).to.equal('2026-01-01T12:00:00Z');
  });

  it('throws a clear, descriptive Error instead of a raw RangeError on pathologically deep input', () => {
    // Build a chain of 300 nested objects — deeper than any real STDM session, deep enough to hit the guard.
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 300; i++) {
      deep = { nested: deep };
    }
    const input = { ...makeSession({}), extra: deep } as unknown as SessionView;
    expect(() => normalizeSession(input)).to.throw(Error, /nested more than \d+ levels deep/);
  });

  it('round-trips a field literally named "__proto__" as ordinary data instead of dropping it', () => {
    // A computed key forces a real own property named "__proto__" (an object literal with a *literal* __proto__
    // key would instead set the new object's prototype, which isn't the case this guards against).
    const protoKey = '__proto__';
    const extra: Record<string, unknown> = { [protoKey]: { nested: 'x' } };
    const input = { ...makeSession({}), extra } as unknown as SessionView;

    const out = normalizeSession(input) as unknown as { extra: Record<string, unknown> };

    expect(Object.getOwnPropertyDescriptor(out.extra, '__proto__')?.value).to.deep.equal({ nested: 'x' });
  });
});

describe('generate output extraction', () => {
  const valueMap = { 'Input:Session': { value: {} } };

  it('collapses a single-entry outputs[] to a scalar value', async () => {
    const text = JSON.stringify({ outputs: [{ label: 'score', value: '9' }], explanation: 'good' });
    const res = await generate(fakeConnection({ generations: [{ text }] }), 'T', valueMap);
    expect(res).to.deep.include({ ok: true, output: '9', explanation: 'good' });
  });

  it('falls back to the label when an outputs[] entry has no value', async () => {
    const text = JSON.stringify({ outputs: [{ label: 'Escalated', value: null }] });
    const res = await generate(fakeConnection({ generations: [{ text }] }), 'T', valueMap);
    expect(res.output).to.equal('Escalated');
  });

  it('maps a multi-entry outputs[] to a string array', async () => {
    const text = JSON.stringify({ outputs: [{ label: 'a', value: 'Yes' }, { label: 'b', value: 2 }] });
    const res = await generate(fakeConnection({ generations: [{ text }] }), 'T', valueMap);
    expect(res.output).to.deep.equal(['Yes', '2']);
  });

  it('prefers the enum label over a free-form value when preferLabel is set', async () => {
    // A text scorer's `value` often just echoes the value's JSON schema; the chosen label is the real score.
    const text = JSON.stringify({ outputs: [{ label: 'Low', value: '{"type":"string"}' }], explanation: 'smooth' });
    const res = await generate(fakeConnection({ generations: [{ text }] }), 'T', valueMap, { preferLabel: true });
    expect(res).to.deep.include({ ok: true, output: 'Low', explanation: 'smooth' });
  });

  it('falls back to the value when preferLabel is set but the label is blank/absent', async () => {
    const text = JSON.stringify({ outputs: [{ label: '   ', value: '7' }] });
    const res = await generate(fakeConnection({ generations: [{ text }] }), 'T', valueMap, { preferLabel: true });
    expect(res.output).to.equal('7');
  });

  it('maps a multi-entry outputs[] to the labels when preferLabel is set', async () => {
    const text = JSON.stringify({ outputs: [{ label: 'Low', value: 'x' }, { label: 'High', value: 'y' }] });
    const res = await generate(fakeConnection({ generations: [{ text }] }), 'T', valueMap, { preferLabel: true });
    expect(res.output).to.deep.equal(['Low', 'High']);
  });

  it('reads the legacy top-level output field', async () => {
    const text = JSON.stringify({ output: 7, explanation: 'legacy' });
    const res = await generate(fakeConnection({ generations: [{ text }] }), 'T', valueMap);
    expect(res).to.deep.include({ ok: true, output: 7, explanation: 'legacy' });
  });

  it('returns the raw text when the generation is not JSON', async () => {
    const res = await generate(fakeConnection({ generations: [{ text: 'not json' }] }), 'T', valueMap);
    expect(res).to.deep.include({ ok: true, output: 'not json' });
  });

  it('surfaces an API error array as a failed result', async () => {
    const res = await generate(fakeConnection([{ message: 'boom' }]), 'T', valueMap);
    expect(res).to.deep.equal({ ok: false, error: 'boom' });
  });

  it('fails clearly when no generations come back', async () => {
    const res = await generate(fakeConnection({ generations: [] }), 'T', valueMap);
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/no generations/i);
  });

  it('surfaces a bare JSON string scalar as output rather than treating it as an envelope', async () => {
    const res = await generate(fakeConnection({ generations: [{ text: '"7"' }] }), 'T', valueMap);
    expect(res).to.deep.include({ ok: true, output: '7' });
  });

  it('surfaces a bare JSON number scalar as output rather than treating it as an envelope', async () => {
    const res = await generate(fakeConnection({ generations: [{ text: '9' }] }), 'T', valueMap);
    expect(res).to.deep.include({ ok: true, output: 9 });
  });

  it('surfaces a bare JSON array as a string[] output rather than treating it as an envelope', async () => {
    const res = await generate(fakeConnection({ generations: [{ text: '["A","B"]' }] }), 'T', valueMap);
    expect(res.output).to.deep.equal(['A', 'B']);
  });

  it('fails cleanly (does not throw) when the response body is null', async () => {
    const res = await generate(fakeConnection(null), 'T', valueMap);
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/no generations/i);
  });

  it('fails cleanly (does not throw) when the first generation element is not an object', async () => {
    const res = await generate(fakeConnection({ generations: [null] }), 'T', valueMap);
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/no generations/i);
  });

  it('fails cleanly when the request itself rejects', async () => {
    const connection = {
      version: '64.0',
      request: () => Promise.reject(new Error('network down')),
    } as unknown as Connection;
    const res = await generate(connection, 'T', valueMap);
    expect(res).to.deep.equal({ ok: false, error: 'network down' });
  });

  it("falls back to 'generations API error' when the error array entry has no message", async () => {
    const res = await generate(fakeConnection([{}]), 'T', valueMap);
    expect(res).to.deep.equal({ ok: false, error: 'generations API error' });
  });

  it("falls back to 'generations API error' for an empty error array", async () => {
    const res = await generate(fakeConnection([]), 'T', valueMap);
    expect(res).to.deep.equal({ ok: false, error: 'generations API error' });
  });
});

describe('generate error disambiguation (R1)', () => {
  const valueMap = { 'Input:Session': { value: {} } };

  /** A connection whose request rejects with an error carrying the given extra props (e.g. statusCode). */
  function rejectingConnection(error: Error): Connection {
    return { version: '64.0', request: () => Promise.reject(error) } as unknown as Connection;
  }

  // maxAttempts: 1 keeps these focused on the *message* (retry behavior is covered by the R2 suite below).
  const noRetry = { retry: { maxAttempts: 1 } };

  it('flags an HTTP 429 as a gateway throttle (transient), not a template problem', async () => {
    const res = await generate(rejectingConnection(Object.assign(new Error('rate limited'), { statusCode: 429 })), 'T', valueMap, noRetry);
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/throttled/i);
    expect(res.error).to.include('429');
    expect(res.error).to.not.match(/deployed & published/i);
  });

  it('flags an HTTP 503 as the gateway being unavailable (transient)', async () => {
    const res = await generate(rejectingConnection(Object.assign(new Error('service down'), { statusCode: 503 })), 'T', valueMap, noRetry);
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/unavailable/i);
    expect(res.error).to.include('503');
  });

  it('reads ERROR_HTTP_429 from the error name/errorCode (the sf-core error shape)', async () => {
    const res = await generate(rejectingConnection(Object.assign(new Error('too many'), { name: 'ERROR_HTTP_429' })), 'T', valueMap, noRetry);
    expect(res.error).to.match(/throttled/i);
  });

  it('recognizes a semantic REQUEST_LIMIT_EXCEEDED error code in an API error array as a throttle', async () => {
    const res = await generate(
      fakeConnection([{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }]),
      'T',
      valueMap,
      noRetry
    );
    expect(res.error).to.match(/throttled/i);
  });

  it('names the template and enumerates the causes when a 200 returns no completion', async () => {
    const res = await generate(fakeConnection({ generations: [] }), 'My_Scorer', valueMap);
    expect(res.ok).to.equal(false);
    expect(res.error).to.include("'My_Scorer'");
    // The four historically-conflated causes are all named so the reader can tell them apart.
    expect(res.error).to.match(/deployed & published/i);
    expect(res.error).to.match(/model is not enabled/i);
    expect(res.error).to.match(/same-content versions/i);
    expect(res.error).to.match(/throttled/i);
  });
});

describe('generate retry/backoff (R2)', () => {
  const valueMap = { 'Input:Session': { value: {} } };
  const OK_PAYLOAD = { generations: [{ text: JSON.stringify({ output: 'Good', explanation: 'ok' }) }] };
  // baseDelayMs: 0 makes jittered backoff resolve immediately, so these run without real waits.
  const fast = (maxAttempts: number) => ({ retry: { maxAttempts, baseDelayMs: 0 } });

  type Step = '429' | '503' | 'boom' | { ok: unknown };

  /** A connection that walks `steps` per call (repeating the last), so a test can script fail-then-succeed. */
  function scriptedConnection(steps: Step[]): { connection: Connection; calls: () => number } {
    let i = 0;
    const connection = {
      version: '64.0',
      request: () => {
        const step = steps[Math.min(i, steps.length - 1)];
        i++;
        if (step === '429') return Promise.reject(Object.assign(new Error('rate limited'), { statusCode: 429 }));
        if (step === '503') return Promise.reject(Object.assign(new Error('gateway down'), { statusCode: 503 }));
        if (step === 'boom') return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
        return Promise.resolve(step.ok);
      },
    } as unknown as Connection;
    return { connection, calls: () => i };
  }

  it('retries a transient throttle and succeeds once the gateway recovers', async () => {
    const { connection, calls } = scriptedConnection(['429', '429', { ok: OK_PAYLOAD }]);
    const res = await generate(connection, 'T', valueMap, fast(3));
    expect(res).to.deep.include({ ok: true, output: 'Good' });
    expect(calls()).to.equal(3);
  });

  it('does not retry a non-transient error (fails fast on the first attempt)', async () => {
    const { connection, calls } = scriptedConnection(['boom']);
    const res = await generate(connection, 'T', valueMap, fast(3));
    expect(res.ok).to.equal(false);
    expect(calls()).to.equal(1);
  });

  it('gives up after maxAttempts on a persistent throttle and returns the throttled message', async () => {
    const { connection, calls } = scriptedConnection(['429']);
    const res = await generate(connection, 'T', valueMap, fast(3));
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/throttled/i);
    expect(calls()).to.equal(3);
  });

  it('honors a lower maxAttempts cap for a persistent unavailable gateway', async () => {
    const { connection, calls } = scriptedConnection(['503']);
    const res = await generate(connection, 'T', valueMap, fast(2));
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/unavailable/i);
    expect(calls()).to.equal(2);
  });

  it('does not retry an empty (200, no completion) response — that is a template problem, not transient', async () => {
    const { connection, calls } = scriptedConnection([{ ok: { generations: [] } }]);
    const res = await generate(connection, 'T', valueMap, fast(3));
    expect(res.ok).to.equal(false);
    expect(res.error).to.match(/no generations/i);
    expect(calls()).to.equal(1);
  });
});

describe('runScorer', () => {
  const baseSpec: ScorerSpec = {
    apiName: 'TestScorer',
    label: 'Test Scorer',
    lightningType: 'lightning__textType',
    engineType: 'Manual',
    agentAssociation: { agentApiName: 'Agent1', isActive: true },
  };

  it("throws for a 'Manual' engineType with a message mentioning no engine is implemented", () => {
    expect(() => runScorer(baseSpec, makeSession({}), fakeConnection({}))).to.throw(
      /no engine implemented for engineType 'Manual'/
    );
  });

  it("drives the PromptTemplate engine and returns its generations result", async () => {
    const text = JSON.stringify({ output: 'Good', explanation: 'looks fine' });
    const spec: ScorerSpec = { ...baseSpec, engineType: 'PromptTemplate' };
    const result = await runScorer(spec, makeSession({}), fakeConnection({ generations: [{ text }] }));
    expect(result).to.deep.include({ ok: true, output: 'Good', explanation: 'looks fine' });
  });

  it("reports the chosen label (not the free-form value) for a scorer with predefined labels", async () => {
    // The model classifies via `label`; its `value` echoes the value schema. Output must be the label.
    const text = JSON.stringify({ outputs: [{ label: 'Low', value: '{"type":"string"}' }], explanation: 'smooth' });
    const spec: ScorerSpec = {
      ...baseSpec,
      engineType: 'PromptTemplate',
      outputEnumValues: [
        { value: 'Low', outcomeType: 'Pass' },
        { value: 'High', outcomeType: 'Fail', isFallback: true },
      ],
    };
    const result = await runScorer(spec, makeSession({}), fakeConnection({ generations: [{ text }] }));
    expect(result).to.deep.include({ ok: true, output: 'Low', explanation: 'smooth' });
  });
});

describe('promptTemplateEngine deriveInputs (via run)', () => {
  const baseSpec: ScorerSpec = {
    apiName: 'TestScorer',
    label: 'Test Scorer',
    lightningType: 'lightning__textType',
    engineType: 'PromptTemplate',
    agentAssociation: { agentApiName: 'Agent1', isActive: true },
  };

  async function runWithOutputEnumValues(outputEnumValues: ScorerSpec['outputEnumValues']): Promise<ValueMap> {
    const { connection, valueMap } = capturingConnection({
      generations: [{ text: JSON.stringify({ output: 'x' }) }],
    });
    await promptTemplateEngine.run({ spec: { ...baseSpec, outputEnumValues }, session: makeSession({}), connection });
    return valueMap();
  }

  it('excludes any value with isSystemFallback: true from Input:AllowedLabels', async () => {
    const valueMap = await runWithOutputEnumValues([
      { value: 'Good', outcomeType: 'Pass' },
      { value: 'Bad', outcomeType: 'Fail', isFallback: true },
      { value: 'SystemDefault', outcomeType: 'NotApplicable', isSystemFallback: true },
    ]);
    expect(valueMap['Input:AllowedLabels'].value).to.equal('Good, Bad');
  });

  it('picks the explicit non-system isFallback value for Input:FallbackLabel', async () => {
    const valueMap = await runWithOutputEnumValues([
      { value: 'Good', outcomeType: 'Pass' },
      { value: 'Bad', outcomeType: 'Fail', isFallback: true },
      { value: 'SystemDefault', outcomeType: 'NotApplicable', isSystemFallback: true },
    ]);
    expect(valueMap['Input:FallbackLabel'].value).to.equal('Bad');
  });

  it('falls back to the last selectable value for Input:FallbackLabel when no explicit fallback exists', async () => {
    const valueMap = await runWithOutputEnumValues([
      { value: 'Good', outcomeType: 'Pass' },
      { value: 'Bad', outcomeType: 'Fail' },
    ]);
    expect(valueMap['Input:FallbackLabel'].value).to.equal('Bad');
  });
});
