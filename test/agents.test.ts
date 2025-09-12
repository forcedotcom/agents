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
import fs from 'node:fs/promises';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { ComponentSetBuilder, ComponentSet, MetadataApiRetrieve } from '@salesforce/source-deploy-retrieve';
import { type AgentJson } from '../src/types.js';
import { Agent, type AgentCreateConfig } from '../src';

describe('Agents', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = join('test', 'mocks');
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://mydomain.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(() => {
    delete process.env.SF_MOCK_DIR;
  });

  it('createSpec (mock behavior) should return a spec', async () => {
    const agentType = 'customer';
    const companyName = 'Coral Cloud Enterprises';
    const output = await Agent.createSpec(connection, {
      agentType,
      role: 'answer questions about vacation_rentals',
      companyName,
      companyDescription: 'Provide vacation rentals and activities',
    });

    expect(output).to.have.property('topics');
    expect(output).to.have.property('agentType', agentType);
    expect(output).to.have.property('companyName', companyName);
    expect(output.topics).to.be.an('array').with.lengthOf(10);
    expect(output.topics[0]).to.have.property('name', 'Guest_Experience_Enhancement');
  });

  it('createAfScript (mock behavior) should return AF Script', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAfScript');
    const agentType = 'customer';
    const companyName = 'Coral Cloud Enterprises';
    const output = await Agent.createAfScript(connection, {
      agentType,
      role: 'answer questions about vacation_rentals',
      companyName,
      companyDescription: 'Provide vacation rentals and activities',
      topics: [
        {
          name: 'Guest_Experience_Enhancement',
          description: 'Enhance the guest experience',
        },
      ],
    });

    expect(output).to.be.a('string');
    expect(output).to.include('# A simple weather assistant agent');
    expect(output).to.include('topic weather_assistant:');
    expect(output).to.include('agent_name: "ServiceBot"');
  });

  it('createAgentJson (mock behavior) should return full agent json', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAgentJson');
    const output = await Agent.compileAfScript(connection, 'AF Script string');
    expect(output).to.have.property('schema_version', '1.0');
    expect(output).to.have.property('global_configuration').and.be.an('object');
    expect(output).to.have.property('agent_version').and.be.an('object');
    await fs.rm('force-app', { recursive: true, force: true });
  });

  describe('publishAgentJson', () => {
    let sfProject: SfProject;
    let agentJson: AgentJson;

    beforeEach(async () => {
      sfProject = SfProject.getInstance();
      // @ts-expect-error Not the full package def
      $$.SANDBOX.stub(sfProject, 'getDefaultPackage').returns({ path: 'force-app' });

      // Setup default successful metadata retrieval mock
      const compSet = new ComponentSet();
      const mdApiRetrieve = new MetadataApiRetrieve({
        usernameOrConnection: testOrg.getMockUserInfo().Username,
        output: 'nowhere',
      });
      $$.SANDBOX.stub(mdApiRetrieve, 'pollStatus').resolves({
        // @ts-expect-error Not the full response
        response: { success: true },
      });
      $$.SANDBOX.stub(compSet, 'retrieve').resolves(mdApiRetrieve);
      $$.SANDBOX.stub(ComponentSetBuilder, 'build').resolves(compSet);

      // Create test agent JSON
      agentJson = {
        // eslint-disable-next-line camelcase
        schema_version: '1.0',
        // eslint-disable-next-line camelcase
        global_configuration: {
          // eslint-disable-next-line camelcase
          developer_name: 'test_agent_v1',
          label: 'Test Agent',
          description: 'A test agent',
          // eslint-disable-next-line camelcase
          agent_type: 'AgentforceServiceAgent',
        },
        // eslint-disable-next-line camelcase
        agent_version: {
          // eslint-disable-next-line camelcase
          developer_name: 'test_agent_v1',
          // eslint-disable-next-line camelcase
          planner_type: 'Atlas__ConcurrentMultiAgentOrchestration',
        },
      };

      // Create test directory structure and files
      const bundlePath = join('force-app', 'main', 'default', 'genAiPlannerBundles');
      const bundleFilePath = join(bundlePath, 'test_agent_v1.genAiPlannerBundle-meta.xml');
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(
        bundleFilePath,
        '<?xml version="1.0" encoding="UTF-8"?>\n<GenAiPlannerBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <Target>old_value</Target>\n</GenAiPlannerBundle>'
      );
    });

    afterEach(async () => {
      await fs.rm(join('force-app'), { recursive: true, force: true });
    });

    it('should update AuthoringBundle and return bot developer name on success', async () => {
      // Mock successful API response
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishAgentJson-Success');

      // Verify file before
      let fileContent = await fs.readFile(
        join('force-app', 'main', 'default', 'genAiPlannerBundles', 'test_agent_v1.genAiPlannerBundle-meta.xml'),
        'utf-8'
      );
      expect(fileContent).to.not.include('<Target>test_agent_v1</Target>');

      const response = await Agent.publishAgentJson(connection, sfProject, agentJson);
      expect(response).to.have.property('isSuccess', true);
      expect(response).to.have.property('botDeveloperName', 'test_agent_v1');

      // Verify file was updated
      fileContent = await fs.readFile(
        join('force-app', 'main', 'default', 'genAiPlannerBundles', 'test_agent_v1.genAiPlannerBundle-meta.xml'),
        'utf-8'
      );
      expect(fileContent).to.include('<Target>test_agent_v1</Target>');
    });

    it('should throw error when AuthoringBundle file does not exist', async () => {
      // Delete the file to simulate missing file
      await fs.unlink(
        join('force-app', 'main', 'default', 'genAiPlannerBundles', 'test_agent_v1.genAiPlannerBundle-meta.xml')
      );

      // Mock successful API response
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishAgentJson-Success');

      try {
        await Agent.publishAgentJson(connection, sfProject, agentJson);
        expect.fail('Expected error was not thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('AgentRetrievalError');
      }
    });

    it('should throw error when API call fails', async () => {
      // Mock failed API response
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishAgentJson-Error');

      try {
        await Agent.publishAgentJson(connection, sfProject, agentJson);
        expect.fail('Expected error was not thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('CreateAgentJsonError');
      }
    });

    it('should throw error when metadata retrieval fails', async () => {
      // Mock successful API response but failed metadata retrieval
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishAgentJson-Success');

      // Reset the stubs from beforeEach
      $$.SANDBOX.restore();

      // Setup new mocks for this test
      const compSet = new ComponentSet();
      const mdApiRetrieve = new MetadataApiRetrieve({
        usernameOrConnection: testOrg.getMockUserInfo().Username,
        output: 'nowhere',
      });
      const pollingStub = $$.SANDBOX.stub(mdApiRetrieve, 'pollStatus').resolves({
        // @ts-expect-error Not the full response
        response: { success: false, messages: ['Metadata retrieval failed'] },
      });
      const retrieveStub = $$.SANDBOX.stub(compSet, 'retrieve').resolves(mdApiRetrieve);
      $$.SANDBOX.stub(ComponentSetBuilder, 'build').resolves(compSet);

      // Re-stub the project path since we restored all stubs
      // @ts-expect-error Not the full package def
      $$.SANDBOX.stub(sfProject, 'getDefaultPackage').returns({ path: 'force-app' });

      try {
        await Agent.publishAgentJson(connection, sfProject, agentJson);
        expect.fail('Expected error was not thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('AgentRetrievalError');
        expect(pollingStub.calledOnce).to.be.true;
        expect(retrieveStub.calledOnce).to.be.true;
      }
    });
  });

  it('create save agent', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAgent-Save');
    const sfProject = SfProject.getInstance();

    // @ts-expect-error Not the full package def
    $$.SANDBOX.stub(sfProject, 'getDefaultPackage').returns({ path: 'force-app' });
    const mdApiRetrieve = new MetadataApiRetrieve({
      usernameOrConnection: testOrg.getMockUserInfo().Username,
      output: 'nowhere',
    });
    const pollingStub = $$.SANDBOX.stub(mdApiRetrieve, 'pollStatus').resolves({
      // @ts-expect-error Not the full response
      response: { success: true },
    });
    const compSet = new ComponentSet();
    const retrieveStub = $$.SANDBOX.stub(compSet, 'retrieve').resolves(mdApiRetrieve);
    const csbStub = $$.SANDBOX.stub(ComponentSetBuilder, 'build').resolves(compSet);

    const config: AgentCreateConfig = {
      agentType: 'customer',
      saveAgent: true,
      agentSettings: {
        agentName: 'My First Agent',
      },
      generationInfo: {
        defaultInfo: {
          role: 'answer questions about vacation rentals',
          companyName: 'Coral Cloud Enterprises',
          companyDescription: 'Provide vacation rentals and activities',
        },
      },
      generationSettings: {
        maxNumOfTopics: 10,
      },
    };
    const response = await Agent.create(connection, sfProject, config);
    expect(response).to.have.property('isSuccess', true);
    expect(response).to.have.property('agentId');
    expect(response).to.have.property('agentDefinition');
    expect(csbStub.calledOnce).to.be.true;
    expect(retrieveStub.calledOnce).to.be.true;
    expect(pollingStub.calledOnce).to.be.true;
    expect(config.agentSettings?.agentApiName).to.equal('My_First_Agent');
  });

  it('create preview agent', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAgent-Preview');
    const sfProject = SfProject.getInstance();
    const config: AgentCreateConfig = {
      agentType: 'customer',
      saveAgent: false,
      generationInfo: {
        defaultInfo: {
          role: 'answer questions about vacation rentals',
          companyName: 'Coral Cloud Enterprises',
          companyDescription: 'Provide vacation rentals and activities',
        },
      },
      generationSettings: {
        maxNumOfTopics: 10,
      },
    };
    const response = await Agent.create(connection, sfProject, config);
    expect(response).to.have.property('isSuccess', true);
    expect(response).to.not.have.property('agentId');
    expect(response).to.have.property('agentDefinition');
  });
});
