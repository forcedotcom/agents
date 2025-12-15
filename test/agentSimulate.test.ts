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
import { Connection, SfProject } from '@salesforce/core';
import sinon from 'sinon';
import { ScriptAgent } from '../src';
import { readTranscriptEntries } from '../src';
import * as utils from '../src/utils';
import { compileAgentScriptResponseSuccess } from './testData';

describe('ScriptAgent', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  const session = 'e17fe68d-8509-4da7-8715-f270da5d64be';
  const agentApiName = 'test-agent'; // directory name without extension

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

    // Create the test .agent file in a directory structure
    const fixturesDir = join(process.cwd(), 'test', 'fixtures', 'test-agent');
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(join(fixturesDir, 'test-agent.agent'), 'system:\n  instructions: "Test agent"');

    // Create the bundle-meta.xml file
    await writeFile(
      join(fixturesDir, 'test-agent.bundle-meta.xml'),
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
      const fixturesDir = join(process.cwd(), 'test', 'fixtures', 'test-agent');
      await rm(fixturesDir, { recursive: true, force: true });
    } catch {
      // Files don't exist, that's fine
    }
  });

  describe('transcript saving', () => {
    it('should save transcript entries and clear previous conversation on new session', async () => {
      const project = SfProject.getInstance();
      const aabDirectory = join(process.cwd(), 'test', 'fixtures', 'test-agent');

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
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/scripts') }))
        .resolves(compileAgentScriptResponseSuccess)
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse)
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions/.*/messages') }))
        .resolves(sendResponse);

      // Mock the query for default agent user check
      $$.SANDBOX.stub(connection, 'query').resolves({ totalSize: 0, done: true, records: [] });

      const scriptAgent = new ScriptAgent({ connection, project, aabDirectory });

      // Start first session
      const firstResult = await scriptAgent.preview.start();
      expect(firstResult.sessionId).to.equal(session);

      // Send a message
      const firstMessage = 'Hello, first message';
      await scriptAgent.preview.send(firstMessage);

      // Verify first session entries (transcripts are saved in end())
      await scriptAgent.preview.end();
      let entries = await readTranscriptEntries(agentApiName);
      expect(entries.length).to.be.greaterThan(0);
      expect(entries[0].sessionId).to.equal(session);

      // Find the user message entry
      const userEntry = entries.find((e) => e.role === 'user' && e.text === firstMessage);
      expect(userEntry).to.exist;
      expect(userEntry?.text).to.equal(firstMessage);

      // End first session and start a new one (should clear the previous one)
      await scriptAgent.preview.end();
      const secondResult = await scriptAgent.preview.start();
      expect(secondResult.sessionId).to.equal(session);

      // Send a different message in the second session
      const secondMessage = 'Hello, second message';
      await scriptAgent.preview.send(secondMessage);
      await scriptAgent.preview.end();

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
      const project = SfProject.getInstance();
      const aabDirectory = join(process.cwd(), 'test', 'fixtures', 'test-agent');

      // Create bundle-meta.xml with version
      await writeFile(
        join(aabDirectory, 'test-agent.bundle-meta.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <bundleType>AGENT</bundleType>\n    <masterLabel>Willie1</masterLabel>\n    <versionDescription>something in version description</versionDescription>\n    <target>willie.v1</target>\n</AiAuthoringBundle>'
      );

      // Mock the compile and start responses
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
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/scripts') }))
        .resolves(compileAgentScriptResponseSuccess)
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse);

      const scriptAgent = new ScriptAgent({ connection, project, aabDirectory });
      await scriptAgent.preview.start();

      expect(scriptAgent['agentJson']?.agentVersion.developerName).to.equal('v1');
    });

    it('should default to v0 when version cannot be extracted', async () => {
      const project = SfProject.getInstance();
      const aabDirectory = join(process.cwd(), 'test', 'fixtures', 'test-agent');

      // Create bundle-meta.xml without version in target
      await writeFile(
        join(aabDirectory, 'test-agent.bundle-meta.xml'),
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
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/scripts') }))
        .resolves(compileAgentScriptResponseSuccess)
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse);

      const scriptAgent = new ScriptAgent({ connection, project, aabDirectory });
      await scriptAgent.preview.start();

      expect(scriptAgent['agentJson']?.agentVersion.developerName).to.equal('v0');
    });

    it('should extract different version numbers correctly', async () => {
      const project = SfProject.getInstance();
      const aabDirectory = join(process.cwd(), 'test', 'fixtures', 'test-agent');

      // Create bundle-meta.xml with version v2
      await writeFile(
        join(aabDirectory, 'test-agent.bundle-meta.xml'),
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
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/scripts') }))
        .resolves(compileAgentScriptResponseSuccess)
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/preview/sessions') }))
        .resolves(startResponse);

      const scriptAgent = new ScriptAgent({ connection, project, aabDirectory });
      await scriptAgent.preview.start();

      expect(scriptAgent['agentJson']?.agentVersion.developerName).to.equal('v2');
    });
  });
});
