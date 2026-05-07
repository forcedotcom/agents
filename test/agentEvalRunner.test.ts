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

/* eslint-disable camelcase */

import { expect } from 'chai';
import sinon from 'sinon';
import type { StreamPromise } from '@jsforce/jsforce-node/lib/util/promise';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Org } from '@salesforce/core';
import { resolveAgent, executeBatches, buildResultSummary } from '../src/agentEvalRunner';
import type { EvalApiResponse } from '../src/evalFormatter';

describe('agentEvalRunner', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let org: Org;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    await $$.stubAuths(testOrg);
    org = await Org.create({ aliasOrUsername: testOrg.username });
    // Restore the CONNECTION sandbox so we can re-stub request ourselves
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(() => {
    $$.restore();
  });

  // ─── resolveAgent ──────────────────────────────────────────────────────────

  describe('resolveAgent', () => {
    it('resolves agentId and versionId for a known agent', async () => {
      $$.SANDBOX.stub(org.getConnection(), 'query')
        .onFirstCall()
        .resolves({ records: [{ Id: 'bot-001' }], totalSize: 1, done: true })
        .onSecondCall()
        .resolves({ records: [{ Id: 'ver-001' }], totalSize: 1, done: true });

      const result = await resolveAgent(org, 'My_Agent');
      expect(result).to.deep.equal({ agentId: 'bot-001', versionId: 'ver-001' });
    });

    it('throws when BotDefinition is not found', async () => {
      $$.SANDBOX.stub(org.getConnection(), 'query').resolves({ records: [], totalSize: 0, done: true });

      try {
        await resolveAgent(org, 'Unknown_Agent');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).to.include("Agent 'Unknown_Agent' not found");
      }
    });

    it('throws when no version exists for the agent', async () => {
      $$.SANDBOX.stub(org.getConnection(), 'query')
        .onFirstCall()
        .resolves({ records: [{ Id: 'bot-001' }], totalSize: 1, done: true })
        .onSecondCall()
        .resolves({ records: [], totalSize: 0, done: true });

      try {
        await resolveAgent(org, 'My_Agent');
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).to.include("No published version found for agent 'My_Agent'");
      }
    });

    it('escapes single quotes in the agent name to prevent SOQL injection', async () => {
      const queryStub = $$.SANDBOX.stub(org.getConnection(), 'query').resolves({
        records: [],
        totalSize: 0,
        done: true,
      });

      try {
        await resolveAgent(org, "O'Malley_Agent");
      } catch {
        // expected to throw — we only care about what was queried
      }

      const soql = queryStub.firstCall.args[0];
      expect(soql).to.include("O''Malley_Agent");
      expect(soql).to.not.include("O'Malley_Agent");
    });
  });

  // ─── executeBatches ────────────────────────────────────────────────────────

  describe('executeBatches', () => {
    function stubRequest(): sinon.SinonStub {
      const stub = $$.SANDBOX.stub(org.getConnection(), 'request');
      stub.withArgs(sinon.match(/userinfo/)).resolves({ user_id: 'user-001' });
      stub
        .withArgs(sinon.match({ url: sinon.match('einstein/evaluation') }))
        .resolves({ results: [{ id: 'test-1', evaluation_results: [], errors: [] }] });
      return stub;
    }

    it('returns flattened results from a single batch', async () => {
      stubRequest();
      const batches = [[{ id: 'test-1', steps: [] }]];
      const results = await executeBatches(org, batches);

      expect(results).to.be.an('array');
      expect(results).to.have.length(1);
    });

    it('flattens results across multiple batches', async () => {
      const stub = $$.SANDBOX.stub(org.getConnection(), 'request');
      stub.withArgs(sinon.match(/userinfo/)).resolves({ user_id: 'user-001' });
      stub
        .withArgs(sinon.match({ url: sinon.match('einstein/evaluation') }))
        .resolves({ results: [{ id: 'batch-result', evaluation_results: [], errors: [] }] });

      const batches = [
        [{ id: 'test-1', steps: [] }],
        [{ id: 'test-2', steps: [] }],
        [{ id: 'test-3', steps: [] }],
      ];

      const results = await executeBatches(org, batches);
      expect(results).to.have.length(3);
    });

    it('calls the log callback when multiple batches exist', async () => {
      stubRequest();
      const log = sinon.spy();
      const batches = [
        [{ id: 'test-1', steps: [] }],
        [{ id: 'test-2', steps: [] }],
      ];

      await executeBatches(org, batches, log);
      expect(log.calledOnce).to.be.true;
    });

    it('does not call the log callback for a single batch', async () => {
      stubRequest();
      const log = sinon.spy();
      await executeBatches(org, [[{ id: 'test-1', steps: [] }]], log);
      expect(log.called).to.be.false;
    });

    it('returns empty array when API returns no results', async () => {
      const stub = $$.SANDBOX.stub(org.getConnection(), 'request');
      stub.withArgs(sinon.match(/userinfo/)).resolves({ user_id: 'user-001' });
      stub.withArgs(sinon.match({ url: sinon.match('einstein/evaluation') })).resolves({ results: [] });

      const results = await executeBatches(org, [[{ id: 'test-1', steps: [] }]]);
      expect(results).to.be.an('array').with.length(0);
    });

    it('throws when the eval API call fails', async () => {
      const stub = $$.SANDBOX.stub(org.getConnection(), 'request');
      stub.withArgs(sinon.match(/userinfo/)).resolves({ user_id: 'user-001' });
      stub
        .withArgs(sinon.match({ url: sinon.match('einstein/evaluation') }))
        .rejects(new Error('Network error'));

      try {
        await executeBatches(org, [[{ id: 'test-1', steps: [] }]]);
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).to.include('Network error');
      }
    });

    it('sends correct headers to the eval API', async () => {
      $$.SANDBOX.stub(org, 'getOrgId').returns('org-id-001');

      const callCapture: unknown[] = [];
      const stub = $$.SANDBOX.stub(org.getConnection(), 'request');
      stub.withArgs(sinon.match(/userinfo/)).resolves({ user_id: 'user-001' });
      stub.withArgs(sinon.match({ url: sinon.match('einstein/evaluation') })).callsFake((req: unknown) => {
        callCapture.push(req);
        // Promise.resolve satisfies the runtime contract; the StreamPromise static methods are unused here
        return Promise.resolve({ results: [] }) as unknown as StreamPromise<{ results: never[] }>;
      });

      await executeBatches(org, [[{ id: 'test-1', steps: [] }]]);

      expect(callCapture).to.have.length(1);
      const req = callCapture[0] as { headers: Record<string, string> };
      expect(req.headers['x-org-id']).to.equal('org-id-001');
      expect(req.headers['x-sfdc-user-id']).to.equal('user-001');
      expect(req.headers['x-client-feature-id']).to.equal('AIPlatformEvaluation');
    });
  });

  // ─── buildResultSummary ────────────────────────────────────────────────────

  describe('buildResultSummary', () => {
    it('counts passed and failed evaluations', () => {
      const response: EvalApiResponse = {
        results: [
          {
            id: 'test-1',
            evaluation_results: [
              { id: 'e1', is_pass: true },
              { id: 'e2', is_pass: true },
              { id: 'e3', is_pass: false },
            ],
            errors: [],
          },
        ],
      };

      const { summary } = buildResultSummary(response);
      expect(summary.passed).to.equal(2);
      expect(summary.failed).to.equal(1);
      expect(summary.errors).to.equal(0);
    });

    it('counts scored-only evaluations (score set, is_pass null)', () => {
      const response: EvalApiResponse = {
        results: [
          {
            id: 'test-1',
            evaluation_results: [
              { id: 'e1', score: 0.87, is_pass: null },
              { id: 'e2', score: 0.45, is_pass: null },
            ],
            errors: [],
          },
        ],
      };

      const { summary } = buildResultSummary(response);
      expect(summary.scored).to.equal(2);
      expect(summary.passed).to.equal(0);
      expect(summary.failed).to.equal(0);
    });

    it('counts execution errors', () => {
      const response: EvalApiResponse = {
        results: [
          {
            id: 'test-1',
            evaluation_results: [],
            errors: [{ id: 'step-1', error_message: 'Session failed' }],
          },
        ],
      };

      const { summary } = buildResultSummary(response);
      expect(summary.errors).to.equal(1);
    });

    it('marks test status as failed when there are evaluation failures', () => {
      const response: EvalApiResponse = {
        results: [
          {
            id: 'test-1',
            evaluation_results: [
              { id: 'e1', is_pass: true },
              { id: 'e2', is_pass: false },
            ],
            errors: [],
          },
        ],
      };

      const { testSummaries } = buildResultSummary(response);
      expect(testSummaries[0].status).to.equal('failed');
    });

    it('marks test status as failed when there are execution errors', () => {
      const response: EvalApiResponse = {
        results: [
          {
            id: 'test-1',
            evaluation_results: [],
            errors: [{ id: 'step-1', error_message: 'Crash' }],
          },
        ],
      };

      const { testSummaries } = buildResultSummary(response);
      expect(testSummaries[0].status).to.equal('failed');
    });

    it('marks test status as passed when all evaluations pass and no errors', () => {
      const response: EvalApiResponse = {
        results: [
          {
            id: 'test-1',
            evaluation_results: [{ id: 'e1', is_pass: true }],
            errors: [],
          },
        ],
      };

      const { testSummaries } = buildResultSummary(response);
      expect(testSummaries[0].status).to.equal('passed');
    });

    it('aggregates counts across multiple test results', () => {
      const response: EvalApiResponse = {
        results: [
          {
            id: 'test-1',
            evaluation_results: [{ id: 'e1', is_pass: true }],
            errors: [],
          },
          {
            id: 'test-2',
            evaluation_results: [{ id: 'e2', is_pass: false }],
            errors: [{ id: 'err-1', error_message: 'Fail' }],
          },
        ],
      };

      const { summary, testSummaries } = buildResultSummary(response);
      expect(summary.passed).to.equal(1);
      expect(summary.failed).to.equal(1);
      expect(summary.errors).to.equal(1);
      expect(testSummaries).to.have.length(2);
      expect(testSummaries[0].id).to.equal('test-1');
      expect(testSummaries[1].id).to.equal('test-2');
    });

    it('handles empty results gracefully', () => {
      const { summary, testSummaries } = buildResultSummary({ results: [] });
      expect(summary).to.deep.equal({ passed: 0, failed: 0, scored: 0, errors: 0 });
      expect(testSummaries).to.deep.equal([]);
    });

    it('handles undefined results gracefully', () => {
      const { summary } = buildResultSummary({});
      expect(summary).to.deep.equal({ passed: 0, failed: 0, scored: 0, errors: 0 });
    });
  });
});
