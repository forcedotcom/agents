/*
 * Copyright 2025, Salesforce, Inc.
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
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import sinon from 'sinon';
import { AgentSimulate } from '../src/agentSimulate';
import { Agent } from '../src/agent';
import { readTranscriptEntries } from '../src/utils';
import { compileAgentScriptResponseSuccess } from './testData';

describe('AgentSimulate', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  const session = 'e17fe68d-8509-4da7-8715-f270da5d64be';
  const agentFileName = 'test-agent.agent';
  const agentFilePath = join(process.cwd(), 'test', 'fixtures', agentFileName);
  const agentApiName = agentFileName; // basename with extension

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = join('test', 'mocks');
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://api.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();

    // Create the test .agent file
    const fixturesDir = join(process.cwd(), 'test', 'fixtures');
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(agentFilePath, 'system:\n  instructions: "Test agent"');
  });

  afterEach(async () => {
    delete process.env.SF_MOCK_DIR;
    sinon.restore();
    // Clean up any transcript files created during tests
    try {
      const sfdxPath = join(process.cwd(), '.sfdx');
      await rm(sfdxPath, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, that's fine
    }
    // Clean up test fixture file
    try {
      await rm(agentFilePath, { force: true });
    } catch {
      // File doesn't exist, that's fine
    }
  });

  describe('transcript saving', () => {
    it('should save transcript entries and clear previous conversation on new session', async () => {
      // Mock the compile agent script call
      $$.SANDBOX.stub(Agent, 'compileAgentScript').resolves(compileAgentScriptResponseSuccess);

      // Set up mock directory for start
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentSimulate-Start');
      const agentSimulate = new AgentSimulate(connection, agentFilePath, true);

      // Start first session
      const firstResult = await agentSimulate.start();
      expect(firstResult.sessionId).to.equal(session);

      // Send a message (switch to send mock)
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentSimulate-Send');
      const agentSimulateForSend = new AgentSimulate(connection, agentFilePath, true);
      // Manually set the compiled agent so send() can work
      // @ts-expect-error - accessing private property for testing
      agentSimulateForSend.compiledAgent = agentSimulate.compiledAgent;
      const firstMessage = 'Hello, first message';
      await agentSimulateForSend.send(firstResult.sessionId, firstMessage);

      // Verify first session entries
      let entries = await readTranscriptEntries(agentApiName);
      expect(entries.length).to.be.greaterThan(0);
      expect(entries[0].sessionId).to.equal(session);

      // Find the user message entry
      const userEntry = entries.find((e) => e.role === 'user' && e.text === firstMessage);
      expect(userEntry).to.exist;
      expect(userEntry?.text).to.equal(firstMessage);

      // Start a new session (should clear the previous one)
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentSimulate-Start');
      const agentSimulateForSecondStart = new AgentSimulate(connection, agentFilePath, true);
      const secondResult = await agentSimulateForSecondStart.start();
      expect(secondResult.sessionId).to.equal(session);

      // Send a different message in the second session
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentSimulate-Send');
      const agentSimulateForSecondSend = new AgentSimulate(connection, agentFilePath, true);
      // Manually set the compiled agent so send() can work
      // @ts-expect-error - accessing private property for testing
      agentSimulateForSecondSend.compiledAgent = agentSimulateForSecondStart.compiledAgent;
      const secondMessage = 'Hello, second message';
      await agentSimulateForSecondSend.send(secondResult.sessionId, secondMessage);

      // Verify only the second session entries exist (first message should be gone)
      entries = await readTranscriptEntries(agentApiName);

      // Should have: start entry + user message + agent response
      expect(entries.length).to.be.greaterThan(1);
      expect(entries[0].sessionId).to.equal(session);

      // Verify the second message is present
      const secondUserEntry = entries.find((e) => e.role === 'user' && e.text === secondMessage);
      expect(secondUserEntry).to.exist;
      expect(secondUserEntry?.text).to.equal(secondMessage);

      // Verify the first message is NOT present
      const firstUserEntry = entries.find((e) => e.role === 'user' && e.text === firstMessage);
      expect(firstUserEntry).to.not.exist;
    });
  });
});
