/*
 * Copyright (c) 2025, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { join } from 'node:path';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError } from '@salesforce/core';
import { AgentPreview } from '../src/agentPreview';

describe('AgentPreview', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  const session = 'e17fe68d-8509-4da7-8715-f270da5d64be';
  const agentId = '0Xxed00000002Q1CAI';

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = join('test', 'mocks');
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://api.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(() => {
    delete process.env.SF_MOCK_DIR;
  });

  describe('start', () => {
    it('should start a session and return an AgentPreviewStartResponse', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Start');

      const agentPreview = new AgentPreview(connection);
      const result = await agentPreview.start(agentId);

      expect(result.sessionId).to.deep.equal(session);
      expect(result.messages[0].type).to.deep.equal('Inform');
      expect(result.messages[0].message).to.deep.equal("Hi, I'm an AI service assistant. How can I help you?");
    });

    it('should wrap errors in SfError on start', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Start-Error');
      const agentPreview = new AgentPreview(connection);
      try {
        await agentPreview.start(agentId);
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

      const agentPreview = new AgentPreview(connection);
      const message = 'Hello, Agent!';
      const result = await agentPreview.send(session, message);

      expect(result.messages[0].type).to.deep.equal('Inform');
      expect(result.messages[0].message).to.deep.equal(
        'How can I assist you with any questions or issues you might have?'
      );
    });

    it('should wrap errors in SfError on start', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-Send-Error');
      const agentPreview = new AgentPreview(connection);

      try {
        const message = 'Hello, Agent!';
        await agentPreview.send(session, message);
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
      const agentPreview = new AgentPreview(connection);
      const reason = 'UserRequest' as const;
      const result = await agentPreview.end(session, reason);

      expect(result.messages[0].type).to.deep.equal('SessionEnded');
      expect(result.messages[0].id).to.exist;
      expect(result.messages[0].reason).to.deep.equal('ClientRequest');
    });

    it('should wrap errors in SfError on end', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'agentPreview-End-Error');
      const agentPreview = new AgentPreview(connection);

      try {
        await agentPreview.end(session, 'UserRequest');
        expect.fail('Expected error to be thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        // @ts-expect-error We just confirmed it's an SfError
        expect((err as SfError).cause.message).to.include('V6Session not found for sessionId');
      }
    });
  });
});
