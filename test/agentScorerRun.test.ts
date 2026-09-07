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
import { normalizeSession } from '../src/agentScorer';
import { generate } from '../src/agentScorers/engines/generations';
import type { SessionView } from '../src/agentScorer';

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
});
