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

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/explicit-function-return-type, camelcase */

import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { AgentObserve } from '../src/agentObserve';
import type { SimilarityStrategy, SimilarSessionResult } from '../src/agentObserveTypes';

describe('AgentObserve', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let queries: string[];

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    await $$.stubAuths(testOrg);
    connection = await testOrg.getConnection();
    queries = [];
  });

  afterEach(() => {
    $$.restore();
  });

  function mockQuery(responses: Record<string, any>): void {
    $$.fakeConnectionRequest = (req: any) => {
      const url = typeof req === 'string' ? req : req.url;
      queries.push(url);
      const decodedUrl = decodeURIComponent(url);

      for (const [pattern, response] of Object.entries(responses)) {
        if (decodedUrl.includes(pattern)) {
          return Promise.resolve(response);
        }
      }
      return Promise.resolve({ totalSize: 0, records: [] });
    };
  }

  describe('findSimilarSessions', () => {
    const SESSION_ID = 'session-001';
    const FROM_TIME = '2026-01-01T00:00:00Z';
    const TO_TIME = '2026-07-01T00:00:00Z';

    it('throws SessionNotFound when session does not exist', async () => {
      mockQuery({
        'AiAgentSession__dlm': { totalSize: 0, records: [] },
      });

      try {
        await AgentObserve.findSimilarSessions(connection, 'service', SESSION_ID, FROM_TIME, TO_TIME);
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.name).to.equal('SessionNotFound');
      }
    });

    it('returns empty array when session has no tags', async () => {
      mockQuery({
        'AiAgentSession__dlm': { totalSize: 1, records: [{ ssot__Id__c: SESSION_ID }] },
        'AiAgentTagAssociation__dlm WHERE ssot__AiAgentSessionId__c': { totalSize: 0, records: [] },
      });

      const result = await AgentObserve.findSimilarSessions(connection, 'service', SESSION_ID, FROM_TIME, TO_TIME);
      expect(result).to.deep.equal([]);
    });

    it('finds similar sessions by shared tags with normalized scores', async () => {
      mockQuery({
        'AiAgentSession__dlm': { totalSize: 1, records: [{ ssot__Id__c: SESSION_ID }] },
        'AiAgentTagAssociation__dlm WHERE ssot__AiAgentSessionId__c': {
          totalSize: 2,
          records: [
            { ssot__AiAgentTagId__c: 'tag-A', ssot__AiAgentSessionId__c: SESSION_ID },
            { ssot__AiAgentTagId__c: 'tag-B', ssot__AiAgentSessionId__c: SESSION_ID },
          ],
        },
        'AiAgentTag__dlm': {
          totalSize: 2,
          records: [
            { ssot__Id__c: 'tag-A', ssot__Value__c: 'Billing Errors', ssot__AiAgentTagDefinitionId__c: 'def-1' },
            { ssot__Id__c: 'tag-B', ssot__Value__c: 'High', ssot__AiAgentTagDefinitionId__c: 'def-2' },
          ],
        },
        'AiAgentTagDefinition__dlm': {
          totalSize: 2,
          records: [
            { ssot__Id__c: 'def-1', ssot__Name__c: 'Optimization Request Category' },
            { ssot__Id__c: 'def-2', ssot__Name__c: 'Sentiment Score' },
          ],
        },
        'AiAgentTagAssociation__dlm WHERE ssot__AiAgentTagId__c': {
          totalSize: 4,
          records: [
            { ssot__AiAgentSessionId__c: 'session-002', ssot__AiAgentTagId__c: 'tag-A' },
            { ssot__AiAgentSessionId__c: 'session-002', ssot__AiAgentTagId__c: 'tag-B' },
            { ssot__AiAgentSessionId__c: 'session-003', ssot__AiAgentTagId__c: 'tag-A' },
            { ssot__AiAgentSessionId__c: SESSION_ID, ssot__AiAgentTagId__c: 'tag-A' },
          ],
        },
      });

      const result = await AgentObserve.findSimilarSessions(connection, 'service', SESSION_ID, FROM_TIME, TO_TIME);

      expect(result).to.have.lengthOf(2);
      // session-002 matches both tags (score=2), session-003 matches one (score=1)
      expect(result[0].sessionId).to.equal('session-002');
      expect(result[0].score).to.equal(1); // normalized: 2/2 = 1
      expect(result[0].matchedDimensions).to.include('Optimization Request Category');
      expect(result[0].matchedDimensions).to.include('Sentiment Score');

      expect(result[1].sessionId).to.equal('session-003');
      expect(result[1].score).to.equal(0.5); // normalized: 1/2 = 0.5
      expect(result[1].matchedDimensions).to.deep.equal(['Optimization Request Category']);
    });

    it('respects custom weights', async () => {
      mockQuery({
        'AiAgentSession__dlm': { totalSize: 1, records: [{ ssot__Id__c: SESSION_ID }] },
        'AiAgentTagAssociation__dlm WHERE ssot__AiAgentSessionId__c': {
          totalSize: 2,
          records: [
            { ssot__AiAgentTagId__c: 'tag-A', ssot__AiAgentSessionId__c: SESSION_ID },
            { ssot__AiAgentTagId__c: 'tag-B', ssot__AiAgentSessionId__c: SESSION_ID },
          ],
        },
        'AiAgentTag__dlm': {
          totalSize: 2,
          records: [
            { ssot__Id__c: 'tag-A', ssot__Value__c: 'Billing', ssot__AiAgentTagDefinitionId__c: 'def-1' },
            { ssot__Id__c: 'tag-B', ssot__Value__c: 'Positive', ssot__AiAgentTagDefinitionId__c: 'def-2' },
          ],
        },
        'AiAgentTagDefinition__dlm': {
          totalSize: 2,
          records: [
            { ssot__Id__c: 'def-1', ssot__Name__c: 'Optimization Request Category' },
            { ssot__Id__c: 'def-2', ssot__Name__c: 'Sentiment' },
          ],
        },
        'AiAgentTagAssociation__dlm WHERE ssot__AiAgentTagId__c': {
          totalSize: 2,
          records: [
            { ssot__AiAgentSessionId__c: 'session-A', ssot__AiAgentTagId__c: 'tag-A' },
            { ssot__AiAgentSessionId__c: 'session-B', ssot__AiAgentTagId__c: 'tag-B' },
          ],
        },
      });

      const result = await AgentObserve.findSimilarSessions(connection, 'service', SESSION_ID, FROM_TIME, TO_TIME, {
        weights: [
          { name: 'Optimization Request Category', weight: 5 },
          { name: 'Sentiment', weight: 1 },
        ],
      });

      expect(result).to.have.lengthOf(2);
      // session-A matches intent (weight=5), session-B matches sentiment (weight=1)
      expect(result[0].sessionId).to.equal('session-A');
      expect(result[0].score).to.equal(1); // 5/5 normalized
      expect(result[1].sessionId).to.equal('session-B');
      expect(result[1].score).to.be.closeTo(0.2, 0.001); // 1/5 normalized
    });

    it('respects limit option', async () => {
      mockQuery({
        'AiAgentSession__dlm': { totalSize: 1, records: [{ ssot__Id__c: SESSION_ID }] },
        'AiAgentTagAssociation__dlm WHERE ssot__AiAgentSessionId__c': {
          totalSize: 1,
          records: [{ ssot__AiAgentTagId__c: 'tag-A', ssot__AiAgentSessionId__c: SESSION_ID }],
        },
        'AiAgentTag__dlm': {
          totalSize: 1,
          records: [{ ssot__Id__c: 'tag-A', ssot__Value__c: 'Billing', ssot__AiAgentTagDefinitionId__c: 'def-1' }],
        },
        'AiAgentTagDefinition__dlm': {
          totalSize: 1,
          records: [{ ssot__Id__c: 'def-1', ssot__Name__c: 'Intent' }],
        },
        'AiAgentTagAssociation__dlm WHERE ssot__AiAgentTagId__c': {
          totalSize: 3,
          records: [
            { ssot__AiAgentSessionId__c: 'session-X', ssot__AiAgentTagId__c: 'tag-A' },
            { ssot__AiAgentSessionId__c: 'session-Y', ssot__AiAgentTagId__c: 'tag-A' },
            { ssot__AiAgentSessionId__c: 'session-Z', ssot__AiAgentTagId__c: 'tag-A' },
          ],
        },
      });

      const result = await AgentObserve.findSimilarSessions(connection, 'service', SESSION_ID, FROM_TIME, TO_TIME, {
        limit: 2,
      });

      expect(result).to.have.lengthOf(2);
    });
  });

  describe('getModelName', () => {
    it('returns service SDM model name', () => {
      expect(AgentObserve.getModelName('service')).to.equal('Service_Agent_Analytics_Extension_861');
    });

    it('returns employee SDM model name', () => {
      expect(AgentObserve.getModelName('employee')).to.equal('Employee_Agent_Analytics_Extension_861');
    });
  });

  describe('getAgentTagDefinitions', () => {
    it('returns tag definitions scoped to agent', async () => {
      mockQuery({
        'AiAgentTagDefinitionAssociation__dlm': {
          totalSize: 2,
          records: [
            { ssot__AiAgentTagDefinitionId__c: 'def-1' },
            { ssot__AiAgentTagDefinitionId__c: 'def-2' },
          ],
        },
        'AiAgentTagDefinition__dlm': {
          totalSize: 2,
          records: [
            { ssot__Id__c: 'def-1', ssot__Name__c: 'Optimization Request Category' },
            { ssot__Id__c: 'def-2', ssot__Name__c: 'Sentiment Score' },
          ],
        },
      });

      const result = await AgentObserve.getAgentTagDefinitions(connection, 'Customer_Support_Agent');
      expect(result).to.have.lengthOf(2);
      expect(result[0].name).to.equal('Optimization Request Category');
    });
  });

  describe('strategy pattern', () => {
    it('throws UnknownStrategy for unregistered strategy', async () => {
      mockQuery({
        'AiAgentSession__dlm': { totalSize: 1, records: [{ ssot__Id__c: 'session-001' }] },
      });

      try {
        await AgentObserve.findSimilarSessions(connection, 'service', 'session-001', '2026-01-01', '2026-07-01', {
          strategy: 'nonexistent',
        });
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.name).to.equal('UnknownStrategy');
        expect(e.message).to.include('nonexistent');
        expect(e.message).to.include('tag-overlap');
      }
    });

    it('lists registered strategies', () => {
      const names = AgentObserve.getStrategyNames();
      expect(names).to.include('tag-overlap');
    });

    it('accepts and uses a custom registered strategy', async () => {
      const customStrategy: SimilarityStrategy = {
        name: 'custom-test',
        execute(): Promise<SimilarSessionResult[]> {
          return Promise.resolve([{ sessionId: 'custom-result', score: 1.0, matchedDimensions: ['custom'] }]);
        },
      };

      AgentObserve.registerStrategy(customStrategy);
      expect(AgentObserve.getStrategyNames()).to.include('custom-test');

      mockQuery({
        'AiAgentSession__dlm': { totalSize: 1, records: [{ ssot__Id__c: 'session-001' }] },
      });

      const result = await AgentObserve.findSimilarSessions(connection, 'service', 'session-001', '2026-01-01', '2026-07-01', {
        strategy: 'custom-test',
      });

      expect(result).to.have.lengthOf(1);
      expect(result[0].sessionId).to.equal('custom-result');
      expect(result[0].matchedDimensions).to.deep.equal(['custom']);
    });
  });
});
