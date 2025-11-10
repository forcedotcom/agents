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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { ComponentSetBuilder, ComponentSet, MetadataApiRetrieve } from '@salesforce/source-deploy-retrieve';
import { type AgentJson } from '../src/types.js';
import { AgentPublisher } from '../src';
import * as utils from '../src/utils';
import { testAgentJson } from './testData';

describe('AgentPublisher', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let sfProject: SfProject;
  let agentJson: AgentJson;

  async function createTestBundleStructure(developerName = 'test_agent'): Promise<void> {
    const bundlePath = join('force-app', 'main', 'default', 'aiAuthoringBundles', developerName);
    const bundleFilePath = join(bundlePath, `${developerName}.bundle-meta.xml`);
    await mkdir(bundlePath, { recursive: true });
    await writeFile(
      bundleFilePath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n</AiAuthoringBundle>'
    );
  }

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = join('test', 'mocks');
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://api.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();

    sfProject = SfProject.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    $$.SANDBOX.stub(sfProject, 'getDefaultPackage').returns({ path: 'force-app' } as any);

    // Use test agent JSON from testData
    agentJson = testAgentJson;
  });

  afterEach(async () => {
    delete process.env.SF_MOCK_DIR;
    // Clean up any test files
    try {
      await rm(join('force-app'), { recursive: true, force: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }
  });

  describe('constructor', () => {
    it('should validate developer name and bundle directory during construction', async () => {
      await createTestBundleStructure();

      const publisher = new AgentPublisher(connection, sfProject, agentJson);
      expect(publisher['developerName']).to.equal('test_agent');
      expect(publisher['bundleMetaPath']).to.include('test_agent.bundle-meta.xml');
    });

    it('should throw error when authoring bundle directory does not exist', () => {
      const agentJsonNoBundle = {
        ...agentJson,
        globalConfiguration: {
          ...agentJson.globalConfiguration,
          developerName: 'nonexistent_agent'
        }
      };

      expect(() => new AgentPublisher(connection, sfProject, agentJsonNoBundle)).to.throw(SfError);
    });
  });

  describe('publishAgentJson', () => {
    let publisher: AgentPublisher;

    beforeEach(async () => {
      await createTestBundleStructure();
    });

    it('should publish new agent when there is no bot in the org for the given developer name', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishNewAgent-Success');
      // Mock connection.singleRecordQuery to return undefined (no existing bot)
      $$.SANDBOX.stub(connection, 'singleRecordQuery')
        .withArgs('SELECT Id FROM BotDefinition WHERE DeveloperName=\'test_agent\'')
        .throws(new Error('No records found'));

      publisher = new AgentPublisher(connection, sfProject, agentJson);

      // Mock useNamedUserJwt to return the connection without making HTTP calls
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').resolves(connection);

      // Mock the private methods
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retrieveAgentMetadataStub = $$.SANDBOX.stub(publisher as any, 'retrieveAgentMetadata').resolves();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployAuthoringBundleStub = $$.SANDBOX.stub(publisher as any, 'deployAuthoringBundle').resolves();

      const result = await publisher.publishAgentJson();

      expect(result).to.have.property('developerName', 'test_agent');
      expect(retrieveAgentMetadataStub.calledOnce).to.be.true;
      expect(deployAuthoringBundleStub.calledOnce).to.be.true;

    });

    it('should publish new version of an existing agent when there is a bot in the org for the given developer name', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishNewAgentVersion-Success');

      publisher = new AgentPublisher(connection, sfProject, agentJson);

      // Mock useNamedUserJwt to return the connection without making HTTP calls
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').resolves(connection);

      // Mock connection.singleRecordQuery to return undefined (no existing bot)
      $$.SANDBOX.stub(connection, 'singleRecordQuery')
        .withArgs('SELECT Id FROM BotDefinition WHERE DeveloperName=\'test_agent\'')
        .resolves({ Id: '0Xx000000000001' });

      // Mock the private methods
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retrieveAgentMetadataStub = $$.SANDBOX.stub(publisher as any, 'retrieveAgentMetadata').resolves();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deployAuthoringBundleStub = $$.SANDBOX.stub(publisher as any, 'deployAuthoringBundle').resolves();

      const result = await publisher.publishAgentJson();

      expect(result).to.have.property('developerName', 'test_agent');
      expect(retrieveAgentMetadataStub.calledOnce).to.be.true;
      expect(deployAuthoringBundleStub.calledOnce).to.be.true;
    });

    it('should handle API errors during publishing', async () => {
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishAgentJson-Error');
      
      publisher = new AgentPublisher(connection, sfProject, agentJson);
      
      // Mock useNamedUserJwt to return the connection without making HTTP calls
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').resolves(connection);

      try {
        await publisher.publishAgentJson();
        expect.fail('Expected error was not thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('CreateAgentJsonError');
      }
    });
  });

  describe('getPublishedBotId', () => {
    it('should return bot ID when agent exists', async () => {
      // Create minimal publisher instance by mocking validateDeveloperName
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'test_agent',
        bundleDir: 'test-bundle-dir',
        bundleMetaPath: 'test-meta-path'
      });

      const publisher = new AgentPublisher(connection, sfProject, agentJson);

      const expectedBotId = '0Xx1234567890ABC';
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves({ Id: expectedBotId });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const getPublishedBotId = (publisher as any).getPublishedBotId.bind(publisher);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const result = await getPublishedBotId('test_agent');

      expect(result).to.equal(expectedBotId);
      validateStub.restore();
    });

    it('should return undefined when agent does not exist', async () => {
      // Create minimal publisher instance by mocking validateDeveloperName
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'test_agent',
        bundleDir: 'test-bundle-dir',
        bundleMetaPath: 'test-meta-path'
      });

      const publisher = new AgentPublisher(connection, sfProject, agentJson);

      $$.SANDBOX.stub(connection, 'singleRecordQuery').throws(new Error('No records found'));

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const getPublishedBotId = (publisher as any).getPublishedBotId.bind(publisher);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const result = await getPublishedBotId('nonexistent_agent');

      expect(result).to.be.undefined;
      validateStub.restore();
    });
  });

  describe('getVersionDeveloperName', () => {
    it('should return version developer name', async () => {
      // Create minimal publisher instance by mocking validateDeveloperName
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'test_agent',
        bundleDir: 'test-bundle-dir',
        bundleMetaPath: 'test-meta-path'
      });

      const publisher = new AgentPublisher(connection, sfProject, agentJson);

      const expectedVersionName = 'v1';
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves({ DeveloperName: expectedVersionName });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const getVersionDeveloperName = (publisher as any).getVersionDeveloperName.bind(publisher);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const result = await getVersionDeveloperName('0Bv1234567890ABC');

      expect(result).to.equal(expectedVersionName);
      validateStub.restore();
    });

    it('should throw error when version does not exist', async () => {
      // Create minimal publisher instance by mocking validateDeveloperName
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'test_agent',
        bundleDir: 'test-bundle-dir',
        bundleMetaPath: 'test-meta-path'
      });

      const publisher = new AgentPublisher(connection, sfProject, agentJson);

      $$.SANDBOX.stub(connection, 'singleRecordQuery').throws(new Error('No records found'));

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const getVersionDeveloperName = (publisher as any).getVersionDeveloperName.bind(publisher);

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        await getVersionDeveloperName('invalid_version_id');
        expect.fail('Expected error was not thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('FindBotVersionError');
      }

      validateStub.restore();
    });
  });

  describe('deployAuthoringBundle', () => {
    it('should handle missing bundle directory', async () => {
      // Create minimal publisher instance by mocking validateDeveloperName
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'test_agent',
        bundleDir: '/nonexistent/path',
        bundleMetaPath: '/nonexistent/path/test_agent.bundle-meta.xml'
      });

      const publisher = new AgentPublisher(connection, sfProject, agentJson);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const deployAuthoringBundle = (publisher as any).deployAuthoringBundle.bind(publisher);

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        await deployAuthoringBundle('test_bot_version_id');
        expect.fail('Expected error was not thrown');
      } catch (error) {
        // Expect either SfError or filesystem error
        expect(error).to.be.instanceOf(Error);
      }

      validateStub.restore();
    });
  });

  describe('retrieveAgentMetadata', () => {
    it('should retrieve agent metadata successfully', async () => {
      // Create minimal publisher instance by mocking validateDeveloperName
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'test_agent',
        bundleDir: 'test-bundle-dir',
        bundleMetaPath: 'test-meta-path'
      });

      // Setup successful metadata retrieval mock
      const compSet = new ComponentSet();
      const mdApiRetrieve = new MetadataApiRetrieve({
        usernameOrConnection: testOrg.getMockUserInfo().Username,
        output: 'nowhere',
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      $$.SANDBOX.stub(mdApiRetrieve, 'pollStatus').resolves({
        response: {
          success: true
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      $$.SANDBOX.stub(compSet, 'retrieve').resolves(mdApiRetrieve);
      const buildStub = $$.SANDBOX.stub(ComponentSetBuilder, 'build').resolves(compSet);

      const publisher = new AgentPublisher(connection, sfProject, agentJson);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const retrieveAgentMetadata = (publisher as any).retrieveAgentMetadata.bind(publisher);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await retrieveAgentMetadata();

      // Verify that ComponentSetBuilder.build was called
      expect(buildStub.calledOnce).to.be.true;

      validateStub.restore();
    });

    it('should throw error when retrieval fails', async () => {
      // Create minimal publisher instance by mocking validateDeveloperName
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'test_agent',
        bundleDir: 'test-bundle-dir',
        bundleMetaPath: 'test-meta-path'
      });

      // Setup failed metadata retrieval mock
      const compSet = new ComponentSet();
      const mdApiRetrieve = new MetadataApiRetrieve({
        usernameOrConnection: testOrg.getMockUserInfo().Username,
        output: 'nowhere',
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      $$.SANDBOX.stub(mdApiRetrieve, 'pollStatus').resolves({
        response: {
          success: false,
          messages: ['Retrieval failed']
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      $$.SANDBOX.stub(compSet, 'retrieve').resolves(mdApiRetrieve);
      $$.SANDBOX.stub(ComponentSetBuilder, 'build').resolves(compSet);

      const publisher = new AgentPublisher(connection, sfProject, agentJson);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const retrieveAgentMetadata = (publisher as any).retrieveAgentMetadata.bind(publisher);

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        await retrieveAgentMetadata();
        expect.fail('Expected error was not thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('AgentRetrievalError');
      }

      validateStub.restore();
    });
  });
});
