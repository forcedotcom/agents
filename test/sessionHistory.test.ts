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

import { join } from 'node:path';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import {
  initializeTurnIndex,
  logTurnToHistory,
  updateTurnWithTrace,
  addPlanIdToMetadata,
  writeMetaFileToHistory,
  type TranscriptEntry,
  type TurnIndex,
} from '../src/utils';
import type { PreviewMetadata } from '../src/types';

describe('Session History - Turn Index and PlanIds', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let testHistoryDir: string;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://api.salesforce.com';
    $$.SANDBOXES.CONNECTION.restore();

    // Create test history directory
    testHistoryDir = join('tmp', 'test-session-history', Date.now().toString());
    await mkdir(testHistoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(join('tmp', 'test-session-history'), { recursive: true, force: true });
  });

  describe('Turn Index Creation', () => {
    it('should create turn-index.json with proper structure', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await initializeTurnIndex(testHistoryDir, sessionId, agentId);

      const indexPath = join(testHistoryDir, 'turn-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index).to.have.property('version', '1.0');
      expect(index).to.have.property('sessionId', sessionId);
      expect(index).to.have.property('agentId', agentId);
      expect(index).to.have.property('created');
      expect(index).to.have.property('turns');
      expect(index.turns).to.be.an('array').with.lengthOf(0);
    });

    it('should append turns to the index', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await initializeTurnIndex(testHistoryDir, sessionId, agentId);

      const userEntry: TranscriptEntry = {
        timestamp: '2026-04-02T10:00:00.000Z',
        agentId,
        sessionId,
        role: 'user',
        text: 'How do I create an account?',
      };

      await logTurnToHistory(userEntry, 1, testHistoryDir);

      const indexPath = join(testHistoryDir, 'turn-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index.turns).to.have.lengthOf(1);
      expect(index.turns[0]).to.deep.include({
        turn: 1,
        timestamp: userEntry.timestamp,
        role: 'user',
        summary: 'How do I create an account?',
        summaryTruncated: false,
        multiModal: null,
        traceFile: null,
        planId: null,
      });
    });

    it('should truncate long summaries', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await initializeTurnIndex(testHistoryDir, sessionId, agentId);

      const longText = 'a'.repeat(150);
      const userEntry: TranscriptEntry = {
        timestamp: '2026-04-02T10:00:00.000Z',
        agentId,
        sessionId,
        role: 'user',
        text: longText,
      };

      await logTurnToHistory(userEntry, 1, testHistoryDir);

      const indexPath = join(testHistoryDir, 'turn-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index.turns[0].summary).to.have.lengthOf(103); // 100 chars + '...'
      expect(index.turns[0].summary).to.match(/\.\.\.$/);
      expect(index.turns[0].summaryTruncated).to.be.true;
    });

    it('should update turn with trace file reference', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await initializeTurnIndex(testHistoryDir, sessionId, agentId);

      const agentEntry: TranscriptEntry = {
        timestamp: '2026-04-02T10:00:00.000Z',
        agentId,
        sessionId,
        role: 'agent',
        text: 'I can help you create an account.',
      };

      await logTurnToHistory(agentEntry, 1, testHistoryDir);

      const planId = 'plan-uuid-123';
      await updateTurnWithTrace(testHistoryDir, 1, planId);

      const indexPath = join(testHistoryDir, 'turn-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index.turns[0].traceFile).to.equal(`traces/${planId}.json`);
      expect(index.turns[0].planId).to.equal(planId);
    });

    it('should handle multiple conversation turns', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await initializeTurnIndex(testHistoryDir, sessionId, agentId);

      // Turn 1: Agent greeting
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:00.000Z',
          agentId,
          sessionId,
          role: 'agent',
          text: 'Hello! How can I help?',
        },
        1,
        testHistoryDir
      );

      // Turn 2: User message
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:05.000Z',
          agentId,
          sessionId,
          role: 'user',
          text: 'Create an account',
        },
        2,
        testHistoryDir
      );

      // Turn 3: Agent response
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:10.000Z',
          agentId,
          sessionId,
          role: 'agent',
          text: 'I will create an account for you.',
        },
        3,
        testHistoryDir
      );

      // Update turn 3 with trace
      await updateTurnWithTrace(testHistoryDir, 3, 'plan-abc-123');

      const indexPath = join(testHistoryDir, 'turn-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index.turns).to.have.lengthOf(3);
      expect(index.turns[0].role).to.equal('agent');
      expect(index.turns[0].traceFile).to.be.null;
      expect(index.turns[1].role).to.equal('user');
      expect(index.turns[1].traceFile).to.be.null;
      expect(index.turns[2].role).to.equal('agent');
      expect(index.turns[2].traceFile).to.equal('traces/plan-abc-123.json');
      expect(index.turns[2].planId).to.equal('plan-abc-123');
    });
  });

  describe('Metadata PlanIds Population', () => {
    it('should add planIds to metadata file', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      // Write initial metadata
      await writeMetaFileToHistory(testHistoryDir, {
        sessionId,
        agentId,
        startTime: '2026-04-02T10:00:00.000Z',
        planIds: [],
      });

      // Add first plan ID
      await addPlanIdToMetadata(testHistoryDir, 'plan-abc-123');

      const metadataPath = join(testHistoryDir, 'metadata.json');
      let content = await readFile(metadataPath, 'utf-8');
      let metadata = JSON.parse(content) as PreviewMetadata;

      expect(metadata.planIds).to.deep.equal(['plan-abc-123']);

      // Add second plan ID
      await addPlanIdToMetadata(testHistoryDir, 'plan-def-456');

      content = await readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(content) as PreviewMetadata;

      expect(metadata.planIds).to.deep.equal(['plan-abc-123', 'plan-def-456']);
    });

    it('should not add duplicate planIds', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await writeMetaFileToHistory(testHistoryDir, {
        sessionId,
        agentId,
        startTime: '2026-04-02T10:00:00.000Z',
        planIds: [],
      });

      await addPlanIdToMetadata(testHistoryDir, 'plan-abc-123');
      await addPlanIdToMetadata(testHistoryDir, 'plan-abc-123');

      const metadataPath = join(testHistoryDir, 'metadata.json');
      const content = await readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(content) as PreviewMetadata;

      expect(metadata.planIds).to.deep.equal(['plan-abc-123']);
    });

    it('should handle missing metadata file gracefully', async () => {
      // Should not throw error
      await addPlanIdToMetadata(testHistoryDir, 'plan-abc-123');
    });
  });

  describe('Session File Simulation', () => {
    it('should simulate a complete session with proper file writes', async () => {
      const sessionId = 'sim-session-123';
      const agentId = 'SimAgent';

      // Initialize session
      await initializeTurnIndex(testHistoryDir, sessionId, agentId);
      await writeMetaFileToHistory(testHistoryDir, {
        sessionId,
        agentId,
        startTime: '2026-04-02T10:00:00.000Z',
        planIds: [],
      });

      // Turn 1: Agent greeting
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:00.000Z',
          agentId,
          sessionId,
          role: 'agent',
          text: 'Hello! How can I help you today?',
        },
        1,
        testHistoryDir
      );

      // Turn 2: User asks question
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:05.000Z',
          agentId,
          sessionId,
          role: 'user',
          text: 'Create an account for me',
        },
        2,
        testHistoryDir
      );

      // Turn 3: Agent responds with plan
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:10.000Z',
          agentId,
          sessionId,
          role: 'agent',
          text: 'I will create an account for you right away.',
        },
        3,
        testHistoryDir
      );

      const planId1 = 'plan-create-account-123';
      await updateTurnWithTrace(testHistoryDir, 3, planId1);
      await addPlanIdToMetadata(testHistoryDir, planId1);

      // Turn 4: User asks another question
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:15.000Z',
          agentId,
          sessionId,
          role: 'user',
          text: 'What is the account ID?',
        },
        4,
        testHistoryDir
      );

      // Turn 5: Agent responds with second plan
      await logTurnToHistory(
        {
          timestamp: '2026-04-02T10:00:20.000Z',
          agentId,
          sessionId,
          role: 'agent',
          text: 'The account ID is ACC-12345',
        },
        5,
        testHistoryDir
      );

      const planId2 = 'plan-get-account-456';
      await updateTurnWithTrace(testHistoryDir, 5, planId2);
      await addPlanIdToMetadata(testHistoryDir, planId2);

      // Verify metadata.json
      const metadataPath = join(testHistoryDir, 'metadata.json');
      const metadataContent = await readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent) as PreviewMetadata;

      expect(metadata.sessionId).to.equal(sessionId);
      expect(metadata.agentId).to.equal(agentId);
      expect(metadata.planIds).to.deep.equal([planId1, planId2]);

      // Verify turn-index.json
      const indexPath = join(testHistoryDir, 'turn-index.json');
      const indexContent = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(indexContent) as TurnIndex;

      expect(index.turns).to.have.lengthOf(5);

      // Verify turn 1 (agent greeting)
      expect(index.turns[0]).to.deep.include({
        turn: 1,
        role: 'agent',
        summary: 'Hello! How can I help you today?',
        summaryTruncated: false,
        traceFile: null,
        planId: null,
      });

      // Verify turn 2 (user message)
      expect(index.turns[1]).to.deep.include({
        turn: 2,
        role: 'user',
        summary: 'Create an account for me',
        summaryTruncated: false,
        traceFile: null,
        planId: null,
      });

      // Verify turn 3 (agent response with plan)
      expect(index.turns[2]).to.deep.include({
        turn: 3,
        role: 'agent',
        summary: 'I will create an account for you right away.',
        summaryTruncated: false,
        traceFile: `traces/${planId1}.json`,
        planId: planId1,
      });

      // Verify turn 4 (user message)
      expect(index.turns[3]).to.deep.include({
        turn: 4,
        role: 'user',
        summary: 'What is the account ID?',
        summaryTruncated: false,
        traceFile: null,
        planId: null,
      });

      // Verify turn 5 (agent response with plan)
      expect(index.turns[4]).to.deep.include({
        turn: 5,
        role: 'agent',
        summary: 'The account ID is ACC-12345',
        summaryTruncated: false,
        traceFile: `traces/${planId2}.json`,
        planId: planId2,
      });

      // Verify transcript.jsonl exists and has correct number of entries
      const transcriptPath = join(testHistoryDir, 'transcript.jsonl');
      const transcriptContent = await readFile(transcriptPath, 'utf-8');
      const transcriptLines = transcriptContent.trim().split('\n');
      expect(transcriptLines).to.have.lengthOf(5);
    });
  });

  describe('Transcript Correlation', () => {
    it('should correlate turn numbers with transcript.jsonl lines', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await initializeTurnIndex(testHistoryDir, sessionId, agentId);

      // Write multiple turns
      const entries: TranscriptEntry[] = [
        {
          timestamp: '2026-04-02T10:00:00.000Z',
          agentId,
          sessionId,
          role: 'agent',
          text: 'Hello!',
        },
        {
          timestamp: '2026-04-02T10:00:05.000Z',
          agentId,
          sessionId,
          role: 'user',
          text: 'Hi there',
        },
        {
          timestamp: '2026-04-02T10:00:10.000Z',
          agentId,
          sessionId,
          role: 'agent',
          text: 'How can I help?',
        },
      ];

      for (let i = 0; i < entries.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        await logTurnToHistory(entries[i], i + 1, testHistoryDir);
      }

      // Read transcript.jsonl
      const transcriptPath = join(testHistoryDir, 'transcript.jsonl');
      const transcriptContent = await readFile(transcriptPath, 'utf-8');
      const transcriptLines = transcriptContent.trim().split('\n');

      // Read turn-index.json
      const indexPath = join(testHistoryDir, 'turn-index.json');
      const indexContent = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(indexContent) as TurnIndex;

      // Verify correlation
      expect(transcriptLines).to.have.lengthOf(3);
      expect(index.turns).to.have.lengthOf(3);

      for (let i = 0; i < entries.length; i++) {
        const transcriptEntry = JSON.parse(transcriptLines[i]) as TranscriptEntry;
        const turnEntry = index.turns[i];

        expect(turnEntry.turn).to.equal(i + 1);
        expect(turnEntry.timestamp).to.equal(transcriptEntry.timestamp);
        expect(turnEntry.role).to.equal(transcriptEntry.role);
        expect(turnEntry.summary).to.equal(transcriptEntry.text);
      }
    });
  });

  describe('Error Handling - Defensive Operations', () => {
    it('should auto-initialize turn-index.json if it does not exist when logging a turn', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      // Do NOT call initializeTurnIndex - simulate calling sendMessage before start()
      const userEntry: TranscriptEntry = {
        timestamp: '2026-04-02T10:00:00.000Z',
        agentId,
        sessionId,
        role: 'user',
        text: 'Hello',
      };

      // This should not throw - it should create the index automatically
      await logTurnToHistory(userEntry, 1, testHistoryDir);

      // Verify the index was created
      const indexPath = join(testHistoryDir, 'turn-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index.sessionId).to.equal(sessionId);
      expect(index.agentId).to.equal(agentId);
      expect(index.turns).to.have.lengthOf(1);
      expect(index.turns[0].role).to.equal('user');
    });

    it('should handle corrupted turn-index.json by reinitializing', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      // Write corrupted JSON
      const indexPath = join(testHistoryDir, 'turn-index.json');
      await writeFile(indexPath, '{ corrupted json content', 'utf-8');

      const userEntry: TranscriptEntry = {
        timestamp: '2026-04-02T10:00:00.000Z',
        agentId,
        sessionId,
        role: 'user',
        text: 'Hello',
      };

      // This should not throw - it should reinitialize the index
      await logTurnToHistory(userEntry, 1, testHistoryDir);

      // Verify the index was recreated
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index.sessionId).to.equal(sessionId);
      expect(index.agentId).to.equal(agentId);
      expect(index.turns).to.have.lengthOf(1);
    });

    it('should handle missing turn-index.json gracefully when updating trace', async () => {
      // Do NOT create the index file - simulate calling updateTurnWithTrace without initialization
      // This should not throw - it should return early
      await updateTurnWithTrace(testHistoryDir, 1, 'plan-123');

      // Verify no file was created
      const indexPath = join(testHistoryDir, 'turn-index.json');
      const { existsSync } = await import('node:fs');
      expect(existsSync(indexPath)).to.be.false;
    });

    it('should handle corrupted turn-index.json gracefully when updating trace', async () => {
      const indexPath = join(testHistoryDir, 'turn-index.json');
      await writeFile(indexPath, '{ corrupted json', 'utf-8');

      // This should not throw - it should return early
      await updateTurnWithTrace(testHistoryDir, 1, 'plan-123');

      // Verify the file was not modified (still corrupted)
      const content = await readFile(indexPath, 'utf-8');
      expect(content).to.equal('{ corrupted json');
    });

    it('should not update trace file if turn does not exist', async () => {
      const sessionId = 'test-session-123';
      const agentId = 'TestAgent';

      await initializeTurnIndex(testHistoryDir, sessionId, agentId);

      // Try to update a non-existent turn
      await updateTurnWithTrace(testHistoryDir, 999, 'plan-123');

      // Verify the index was not modified
      const indexPath = join(testHistoryDir, 'turn-index.json');
      const content = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as TurnIndex;

      expect(index.turns).to.have.lengthOf(0);
    });
  });
});
