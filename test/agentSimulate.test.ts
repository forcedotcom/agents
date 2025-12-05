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
import { EOL } from 'node:os';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import sinon from 'sinon';
import { AgentSimulate } from '../src/agentSimulate';
import { Agent } from '../src/agent';
import { readTranscriptEntries } from '../src/utils';
import * as utils from '../src/utils';
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
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://api.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();

    // Mock useNamedUserJwt to return the connection without making HTTP calls
    $$.SANDBOX.stub(utils, 'useNamedUserJwt').resolves(connection);
    // Mock connection.refreshAuth to avoid making HTTP calls during auth refresh
    $$.SANDBOX.stub(connection, 'refreshAuth').resolves();

    // Create the test .agent file
    const fixturesDir = join(process.cwd(), 'test', 'fixtures');
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(agentFilePath, 'system:\n  instructions: "Test agent"');

    // Create the bundle-meta.xml file
    const bundleMetaPath = agentFilePath.replace('.agent', '.bundle-meta.xml');
    await writeFile(
      bundleMetaPath,
      `<?xml version="1.0" encoding="UTF-8"?>${EOL}<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">${EOL}    <bundleType>AGENT</bundleType>${EOL}    <masterLabel>TestAgent</masterLabel>${EOL}    <versionDescription>Test version</versionDescription>${EOL}    <target>test-agent.v1</target>${EOL}</AiAuthoringBundle>`
    );
  });

  afterEach(async () => {
    sinon.restore();
    // Clean up any transcript files created during tests
    try {
      const sfdxPath = join(process.cwd(), '.sfdx');
      await rm(sfdxPath, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, that's fine
    }
    // Clean up test fixture files
    try {
      await rm(agentFilePath, { force: true });
      const bundleMetaPath = agentFilePath.replace('.agent', '.bundle-meta.xml');
      await rm(bundleMetaPath, { force: true });
    } catch {
      // Files don't exist, that's fine
    }
  });

  describe('transcript saving', () => {
    it('should save transcript entries and clear previous conversation on new session', async () => {
      // Mock the compile agent script call
      $$.SANDBOX.stub(Agent, 'compileAgentScript').resolves(compileAgentScriptResponseSuccess);

      // Mock responses for start and send
      const startResponse = {
        sessionId: 'e17fe68d-8509-4da7-8715-f270da5d64be',
        _links: {
          self: null,
          messages: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages',
          },
          messagesStream: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages/stream',
          },
          session: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions',
          },
          end: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be',
          },
        },
        messages: [
          {
            type: 'Inform',
            id: '0adc259f-fdfd-42f7-9b1d-e2e0a0ec98be',
            feedbackId: '',
            planId: '',
            isContentSafe: true,
            message: "Hi, I'm an AI service assistant. How can I help you?",
            result: [],
            citedReferences: [],
          },
        ],
      };

      const sendResponse = {
        messages: [
          {
            type: 'Text',
            id: '1b2c3d4e-5f6g-7h8i-9j0k-1l2m3n4o5p6q',
            feedbackId: '',
            planId: '',
            isContentSafe: true,
            message: 'Hi there! I can help you with a few things.',
            result: [],
            citedReferences: [],
          },
        ],
      };

      // Mock the query for default agent user check
      $$.SANDBOX.stub(connection, 'query').resolves({ totalSize: 0, done: true, records: [] });

      const requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse)
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions/.*/messages') }))
        .resolves(sendResponse);

      const agentSimulate = new AgentSimulate(connection, agentFilePath, true);

      // Start first session
      const firstResult = await agentSimulate.start();
      expect(firstResult.sessionId).to.equal(session);

      // Send a message
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
      const secondResult = await agentSimulate.start();
      expect(secondResult.sessionId).to.equal(session);

      // Send a different message in the second session
      const secondMessage = 'Hello, second message';
      await agentSimulateForSend.send(firstResult.sessionId, secondMessage);

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

  describe('version extraction from bundle-meta.xml', () => {
    it('should extract version from bundle-meta.xml target field', async () => {
      // Mock the compile agent script call
      $$.SANDBOX.stub(Agent, 'compileAgentScript').resolves(compileAgentScriptResponseSuccess);

      // Create bundle-meta.xml with version
      const bundleMetaPath = agentFilePath.replace('.agent', '.bundle-meta.xml');
      await writeFile(
        bundleMetaPath,
        '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <bundleType>AGENT</bundleType>\n    <masterLabel>Willie1</masterLabel>\n    <versionDescription>something in version description</versionDescription>\n    <target>willie.v1</target>\n</AiAuthoringBundle>'
      );

      // Mock the start response
      const startResponse = {
        sessionId: 'e17fe68d-8509-4da7-8715-f270da5d64be',
        _links: {
          self: null,
          messages: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages',
          },
          messagesStream: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages/stream',
          },
          session: { href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions' },
          end: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be',
          },
        },
        messages: [
          {
            type: 'Inform',
            id: '0adc259f-fdfd-42f7-9b1d-e2e0a0ec98be',
            feedbackId: '',
            planId: '',
            isContentSafe: true,
            message: "Hi, I'm an AI service assistant. How can I help you?",
            result: [],
            citedReferences: [],
          },
        ],
      };

      // Mock the query for default agent user check
      $$.SANDBOX.stub(connection, 'query').resolves({ totalSize: 0, done: true, records: [] });

      const requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse);

      const agentSimulate = new AgentSimulate(connection, agentFilePath, true);

      await agentSimulate.start();

      // @ts-expect-error - accessing private property for testing
      expect(agentSimulate.compiledAgent?.agentVersion.developerName).to.equal('v1');
    });

    it('should default to v0 when version cannot be extracted', async () => {
      // Mock the compile agent script call
      $$.SANDBOX.stub(Agent, 'compileAgentScript').resolves(compileAgentScriptResponseSuccess);

      // Create bundle-meta.xml without version in target
      const bundleMetaPath = agentFilePath.replace('.agent', '.bundle-meta.xml');
      await writeFile(
        bundleMetaPath,
        '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <bundleType>AGENT</bundleType>\n    <masterLabel>TestAgent</masterLabel>\n    <target>test-agent</target>\n</AiAuthoringBundle>'
      );

      // Mock the start response
      const startResponse = {
        sessionId: 'e17fe68d-8509-4da7-8715-f270da5d64be',
        _links: {
          self: null,
          messages: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages',
          },
          messagesStream: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages/stream',
          },
          session: { href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions' },
          end: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be',
          },
        },
        messages: [
          {
            type: 'Inform',
            id: '0adc259f-fdfd-42f7-9b1d-e2e0a0ec98be',
            feedbackId: '',
            planId: '',
            isContentSafe: true,
            message: "Hi, I'm an AI service assistant. How can I help you?",
            result: [],
            citedReferences: [],
          },
        ],
      };

      // Mock the query for default agent user check
      $$.SANDBOX.stub(connection, 'query').resolves({ totalSize: 0, done: true, records: [] });

      const requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse);

      const agentSimulate = new AgentSimulate(connection, agentFilePath, true);

      await agentSimulate.start();

      // @ts-expect-error - accessing private property for testing
      expect(agentSimulate.compiledAgent?.agentVersion.developerName).to.equal('v0');
    });

    it('should extract different version numbers correctly', async () => {
      // Mock the compile agent script call
      $$.SANDBOX.stub(Agent, 'compileAgentScript').resolves(compileAgentScriptResponseSuccess);

      // Create bundle-meta.xml with version v2
      const bundleMetaPath = agentFilePath.replace('.agent', '.bundle-meta.xml');
      await writeFile(
        bundleMetaPath,
        '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <bundleType>AGENT</bundleType>\n    <masterLabel>TestAgent</masterLabel>\n    <target>test-agent.v2</target>\n</AiAuthoringBundle>'
      );

      // Mock the start response
      const startResponse = {
        sessionId: 'e17fe68d-8509-4da7-8715-f270da5d64be',
        _links: {
          self: null,
          messages: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages',
          },
          messagesStream: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be/messages/stream',
          },
          session: { href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions' },
          end: {
            href: 'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/e17fe68d-8509-4da7-8715-f270da5d64be',
          },
        },
        messages: [
          {
            type: 'Inform',
            id: '0adc259f-fdfd-42f7-9b1d-e2e0a0ec98be',
            feedbackId: '',
            planId: '',
            isContentSafe: true,
            message: "Hi, I'm an AI service assistant. How can I help you?",
            result: [],
            citedReferences: [],
          },
        ],
      };

      // Mock the query for default agent user check
      $$.SANDBOX.stub(connection, 'query').resolves({ totalSize: 0, done: true, records: [] });

      const requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse);

      const agentSimulate = new AgentSimulate(connection, agentFilePath, true);

      await agentSimulate.start();

      // @ts-expect-error - accessing private property for testing
      expect(agentSimulate.compiledAgent?.agentVersion.developerName).to.equal('v2');
    });
  });
});
