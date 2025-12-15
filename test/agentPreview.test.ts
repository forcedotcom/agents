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
import { rm } from 'node:fs/promises';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { Agent } from '../src/agent';
import { readTranscriptEntries } from '../src/utils';

describe('AgentPreview', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let project: SfProject;
  const session = 'e17fe68d-8509-4da7-8715-f270da5d64be';
  const agentId = '0Xxed00000002Q1CAI';

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = join('test', 'mocks');
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://api.salesforce.com';
    project = SfProject.getInstance();
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(async () => {
    delete process.env.SF_MOCK_DIR;
    // Clean up any transcript files created during tests
    try {
      const sfdxPath = join(process.cwd(), '.sfdx');
      await rm(sfdxPath, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, that's fine
    }
  });

  describe('start', () => {
    it('should start a session and return an AgentPreviewStartResponse', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Start');

      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      const result = await agent.preview.start();

      expect(result.sessionId).to.deep.equal(session);
      expect(result.messages[0].type).to.deep.equal('Inform');
      expect(result.messages[0].message).to.deep.equal("Hi, I'm an AI service assistant. How can I help you?");
    });

    it('should wrap errors in SfError on start', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Start-Error');
      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      try {
        await agent.preview.start();
        expect.fail('Expected error to be thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        // @ts-expect-error We just confirmed it's an SfError
        expect((err as SfError).cause.message).to.include('An unexpected error occurred');
      }
    });
  });

  describe('send', () => {
    it('should send a message and return an AgentPreviewSendResponse', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Send');

      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      await agent.preview.start(); // Start session first
      const message = 'Hello, Agent!';
      const result = await agent.preview.send(message);

      expect(result.messages[0].type).to.deep.equal('Inform');
      expect(result.messages[0].message).to.deep.equal(
        'How can I assist you with any questions or issues you might have?'
      );
    });

    it('should send a message and return with apex debug log in debug mode', async () => {
      const fakeApexLog = { Id: '123', StartTime: '2025-05-12T12:00:00.000Z' };
      const queryResult = {
        records: [fakeApexLog],
        done: true,
        totalSize: 1,
      };
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Send');
      $$.SANDBOX.stub(connection.tooling, 'query').resolves(queryResult);
      $$.SANDBOX.stub(Date, 'now')
        .onFirstCall()
        .returns(123_456_789)
        .onSecondCall()
        .returns(1_747_047_600_000)
        .onCall(4)
        .returns(1_747_054_800_000);

      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      agent.preview.setApexDebugging(true);
      await agent.preview.start(); // Start session first
      const message = 'Hello, Agent!';
      const result = await agent.preview.send(message);
      expect(result.apexDebugLog).to.deep.equal(fakeApexLog);
    });

    it('should send a message and return with no apex debug log when time is not in range', async () => {
      const fakeApexLog = { Id: '123', StartTime: '2025-05-12T12:00:00.000Z' };
      const queryResult = {
        records: [fakeApexLog],
        done: true,
        totalSize: 1,
      };
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Send');
      $$.SANDBOX.stub(connection.tooling, 'query').resolves(queryResult);
      $$.SANDBOX.stub(Date, 'now')
        .onFirstCall()
        .returns(123_456_789)
        .onSecondCall()
        .returns(1_747_047_600_000)
        .onCall(4)
        .returns(1_747_049_000_000);

      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      agent.preview.setApexDebugging(true);
      await agent.preview.start(); // Start session first
      const message = 'Hello, Agent!';
      const result = await agent.preview.send(message);
      expect(result.apexDebugLog).to.equal(undefined);
    });

    it('should send a message and return with no apex debug log when no log returned', async () => {
      const queryResult = {
        records: [],
        done: true,
        totalSize: 0,
      };
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Send');
      $$.SANDBOX.stub(connection.tooling, 'query').resolves(queryResult);
      $$.SANDBOX.stub(Date, 'now')
        .onFirstCall()
        .returns(123_456_789)
        .onSecondCall()
        .returns(1_747_047_600_000)
        .onCall(4)
        .returns(1_747_054_800_000);

      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      agent.preview.setApexDebugging(true);
      await agent.preview.start(); // Start session first
      const message = 'Hello, Agent!';
      const result = await agent.preview.send(message);
      expect(result.apexDebugLog).to.equal(undefined);
    });

    it('should wrap errors in SfError on send', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Send-Error');
      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      await agent.preview.start(); // Start session first

      try {
        const message = 'Hello, Agent!';
        await agent.preview.send(message);
        expect.fail('Expected error to be thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        // @ts-expect-error We just confirmed it's an SfError
        expect((err as SfError).cause.message).to.include('V6Session not found for sessionId');
      }
    });
  });

  describe('end', () => {
    it('should end a session and return an AgentPreviewEndResponse', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-End');
      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      await agent.preview.start(); // Start session first
      const reason = 'UserRequest' as const;
      const result = await agent.preview.end(reason);

      expect(result.messages[0].type).to.deep.equal('SessionEnded');
      expect(result.messages[0].id).to.exist;
      expect(result.messages[0].reason).to.deep.equal('ClientRequest');
    });

    it('should wrap errors in SfError on end', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-End-Error');
      const agent = await Agent.init({ connection, project, nameOrId: agentId });
      await agent.preview.start(); // Start session first

      try {
        await agent.preview.end('UserRequest');
        expect.fail('Expected error to be thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        // @ts-expect-error We just confirmed it's an SfError
        expect((err as SfError).cause.message).to.include('V6Session not found for sessionId');
      }
    });
  });

  describe('transcript saving', () => {
    it('should save transcript entries during start', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Start');
      const agent = await Agent.init({ connection, project, nameOrId: agentId });

      const result = await agent.preview.start();
      expect(result.sessionId).to.equal(session);

      // Verify transcript was saved (basic check)
      // Note: Transcripts are now saved in end(), not start()
      await agent.preview.end('UserRequest');
      const entries = await readTranscriptEntries(agentId);
      expect(entries).to.have.length.greaterThan(0);
    });
  });
});
