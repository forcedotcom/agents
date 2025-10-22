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
import sinon from 'sinon';
import { type AgentJson } from '../src/types.js';
import { Agent, type AgentCreateConfig } from '../src';
import { compileAgentScriptResponseFailure, compileAgentScriptResponseSuccess } from './testData';

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

  it('createAgentScript (mock behavior) should return an AgentScriptContent', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAgent');
    const agentType = 'customer';
    const companyName = 'Coral Cloud Enterprises';
    const output = await Agent.createAgentScript(connection, {
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
    $$.SANDBOX.stub(connection, 'refreshAuth').resolves();
    $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
      accessToken: 'test_access_token',
      instanceUrl: connection.instanceUrl,
    });
    $$.SANDBOX.stub(connection, 'request')
      .withArgs(sinon.match({ url: `${connection.instanceUrl}/agentforce/bootstrap/nameduser` }))
      // eslint-disable-next-line camelcase
      .resolves({ access_token: 'test_access_token' })
      .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/compile') }))
      .resolves({
        status: 'success',
        compiledArtifact: {
          schemaVersion: '2.0',
          globalConfiguration: {
            developerName: 'test_agent_v1',
          },
          agentVersion: {
            developerName: 'test_agent_v1',
          },
        },
      });
    const output = await Agent.compileAgentScript(connection, 'AgentScriptContent');
    expect(output).to.have.property('status', 'success');
    expect(output).to.have.property('compiledArtifact').and.be.an('object');
    expect(output.compiledArtifact).to.have.property('schemaVersion', '2.0');
    expect(output.compiledArtifact).to.have.property('globalConfiguration').and.be.an('object');
    expect(output.compiledArtifact).to.have.property('agentVersion').and.be.an('object');
    await fs.rm('force-app', { recursive: true, force: true });
  });

  describe('compile AgentScript', () => {
    let requestStub: sinon.SinonStub;
    beforeEach(() => {
      $$.SANDBOX.stub(connection, 'refreshAuth').resolves();
      $$.SANDBOX.stub(connection, 'getConnectionOptions').returns({
        accessToken: 'test_access_token',
        instanceUrl: connection.instanceUrl,
      });
      requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub.withArgs(sinon.match({ url: `${connection.instanceUrl}/agentforce/bootstrap/nameduser` }))
        // eslint-disable-next-line camelcase
        .resolves({ access_token: 'test_access_token' });
    });
    afterEach(() => {
      sinon.restore();
    });

    it('compileAgentScript should return raw response on compilation failure', async () => {
      requestStub.withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/compile') }))
        .resolves(compileAgentScriptResponseFailure);

      const result = await Agent.compileAgentScript(connection, 'Invalid AgentScriptContent');
      expect(result).to.have.property('status', 'failure');
      expect(result).to.have.property('compiledArtifact', null);
      expect(result).to.have.property('errors').and.be.an('array').with.lengthOf(1);
      expect(result.errors[0]).to.have.property('errorType', 'SyntaxError');
      expect(result.errors[0]).to.have.property('description', 'Invalid syntax in agent script');
    });
  
    it('compileAgentScript should throw SfError on an exception during the request', async () => {
      requestStub.withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/compile') }))
        .rejects(new Error('Some error'));
  
      try {
        await Agent.compileAgentScript(connection, 'AgentScriptContent');
        expect.fail('Expected compileAgentScript to throw an error');
      } catch (error) {
        expect((error as SfError).name).to.equal('CompileAgentScriptError');
        expect((error as SfError).message).to.include('Error when compiling AgentScript');
      }
    });
  
    it('compileAgentScript should return success response on a successful compilation', async () => {
      requestStub.withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/compile') }))
        .resolves(compileAgentScriptResponseSuccess);
  
    const output = await Agent.compileAgentScript(connection, '');

    expect(output).to.have.property('status', 'success');
    expect(output).to.have.property('compiledArtifact').and.be.an('object');
    expect(output.compiledArtifact!).to.have.property('schemaVersion', '2.0');
    expect(output.compiledArtifact!.globalConfiguration.developerName).to.equal('test_agent_v1');
    });
  
    it('compileAgentScript should handle complex AgentScriptContent', async () => {
      const complexAgentScript = `
        agent ComplexAgent {
          greeting {
            instructions: "Welcome to our service"
            transitions: ["main_menu"]
          }
          main_menu {
            instructions: "How can I help you today?"
            tools: ["case_search", "account_lookup"]
          }
        }
      `;
  
      requestStub.withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/compile') }))
        .resolves({
          status: 'success',
          compiledArtifact: {
            schemaVersion: '2.0',
            globalConfiguration: {
              developerName: 'complex_agent',
            },
            agentVersion: {
              developerName: 'complex_agent',
            },
          },
        });
  
    const output = await Agent.compileAgentScript(connection, complexAgentScript);

    expect(output).to.have.property('status', 'success');
    expect(output).to.have.property('compiledArtifact').and.be.an('object');
    expect(output.compiledArtifact!).to.have.property('schemaVersion', '2.0');
    expect(output.compiledArtifact!.globalConfiguration.developerName).to.equal('complex_agent');
    });
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
        schemaVersion: '1.0',
        globalConfiguration: {
          developerName: 'test_agent_v1',
          label: 'Test Agent',
          description: 'A test agent',
          agentType: 'AgentforceServiceAgent',
          enableEnhancedEventLogs: false,
          templateName: '',
          defaultAgentUser: '',
          defaultOutboundRouting: '',
          contextVariables: [],
        },
        agentVersion: {
          developerName: 'test_agent_v1',
          plannerType: 'Atlas__ConcurrentMultiAgentOrchestration',
          systemMessages: [],
          modalityParameters: {
            voice: {
              inboundModel: null,
              inboundFillerWordsDetection: null,
              outboundVoice: null,
              outboundModel: null,
              outboundSpeed: null,
              outboundStyleExaggeration: null,
            },
            language: {
              defaultLocale: 'en_US',
              additionalLocales: [],
              allAdditionalLocales: false,
            },
          },
          additionalParameters: false,
          company: '',
          role: '',
          stateVariables: [],
          initialNode: '',
          nodes: [],
          knowledgeDefinitions: null,
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
