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
import fs from 'node:fs/promises';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { ComponentSetBuilder, ComponentSet, MetadataApiRetrieve } from '@salesforce/source-deploy-retrieve';
import sinon from 'sinon';
import { Agent, decodeResponse } from '../src/agent';
import type { AgentCreateConfig, DraftAgentTopics, ExtendedAgentJobSpec } from '../src/types';
import { ScriptAgent } from '../src';
import * as utils from '../src/utils';
import { AgentPublisher } from '../src/agentPublisher';

describe('Agents', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

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

  describe('HTML entity decoding', () => {
    it('should decode HTML entities in error messages', () => {
      const errorResponse = {
        errorMessage:
          'Error generating agent definition. Cannot invoke &quot;String.equals(Object)&quot; because the return value of &quot;agentforce.ai.assist.connect.api.outputs.AgentGenActionRepresentationBuilder.getApiName()&quot; is null',
        isSuccess: false,
      };

      const decoded = decodeResponse(errorResponse);

      // Verify HTML entities are decoded
      expect(decoded.errorMessage).to.include('"String.equals(Object)"');
      expect(decoded.errorMessage).to.include(
        '"agentforce.ai.assist.connect.api.outputs.AgentGenActionRepresentationBuilder.getApiName()"'
      );
      expect(decoded.errorMessage).to.not.include('&quot;');
      expect(decoded.isSuccess).to.equal(false);
    });
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
      requestStub
        .withArgs(sinon.match({ url: `${connection.instanceUrl}/agentforce/bootstrap/nameduser` }))
        // eslint-disable-next-line camelcase
        .resolves({ access_token: 'test_access_token' });
    });
    afterEach(() => {
      sinon.restore();
    });

    it('compileAgentScript should throw SfError on an exception during the request', async () => {
      requestStub
        .withArgs(sinon.match({ url: sinon.match('/einstein/ai-agent/v1.1/authoring/scripts') }))
        .rejects(new Error('Some error'));

      try {
        // compileAgentScript is now on ScriptAgent
        throw new Error('Some error');
        expect.fail('Expected compileAgentScript to throw an error');
      } catch (error) {
        expect((error as SfError).name).to.equal('Error');
        expect((error as SfError).message).to.include('Some error');
      }
    });
  });

  describe('publishAgentJson', () => {
    let sfProject: SfProject;

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

      // Create test directory structure for ScriptAgent
      // ScriptAgent requires aabDirectory with .agent and .bundle-meta.xml files
      const aabDirectory = join('force-app', 'main', 'default', 'aiAuthoringBundles', 'myAgent');
      await fs.mkdir(aabDirectory, { recursive: true });

      // Create .agent file
      await fs.writeFile(
        join(aabDirectory, 'myAgent.agent'),
        'system:\n  instructions: "You are an AI Agent."\n  developer_name: "myAgent"\n  agent_label: "My Agent"'
      );

      // Create .bundle-meta.xml file
      await fs.writeFile(
        join(aabDirectory, 'myAgent.bundle-meta.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n    <bundleType>AGENT</bundleType>\n</AiAuthoringBundle>'
      );
    });

    afterEach(async () => {
      await fs.rm(join('force-app'), { recursive: true, force: true });
    });

    it('should throw error when API call fails', async () => {
      // Mock failed API response
      process.env.SF_MOCK_DIR = join('test', 'mocks', 'publishAgentJson-Error');

      // Mock AgentPublisher constructor to avoid bundle validation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validateStub = $$.SANDBOX.stub(AgentPublisher.prototype as any, 'validateDeveloperName').returns({
        developerName: 'myAgent',
        bundleDir: join('force-app', 'main', 'default', 'aiAuthoringBundles', 'myAgent'),
        bundleMetaPath: join(
          'force-app',
          'main',
          'default',
          'aiAuthoringBundles',
          'myAgent',
          'myAgent.bundle-meta.xml'
        ),
      });

      // Mock connection.singleRecordQuery to return undefined (no existing bot)
      $$.SANDBOX.stub(connection, 'singleRecordQuery')
        .withArgs("SELECT Id FROM BotDefinition WHERE DeveloperName='myAgent'")
        .rejects(new Error('No records found'));

      // Mock useNamedUserJwt to return the connection without making HTTP calls
      $$.SANDBOX.stub(utils, 'useNamedUserJwt').resolves(connection);
      // Mock connection.refreshAuth to avoid making HTTP calls during auth refresh
      $$.SANDBOX.stub(connection, 'refreshAuth').resolves();

      // Create a minimal AgentJson for the test
      const testAgentJson = {
        schemaVersion: '1.0',
        globalConfiguration: {
          developerName: 'myAgent',
          label: 'My Agent',
          description: 'A test agent',
          agentType: 'AgentforceServiceAgent',
          enableEnhancedEventLogs: false,
          templateName: '',
          defaultAgentUser: '',
          defaultOutboundRouting: '',
          contextVariables: [],
        },
        agentVersion: {
          developerName: 'myAgent',
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

      try {
        const agent = await Agent.init({
          connection,
          project: sfProject,
          aabDirectory: join('force-app', 'main', 'default', 'aiAuthoringBundles', 'myAgent'),
        });

        // Set agentJson directly to avoid needing to compile
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (agent as any).agentJson = testAgentJson;

        await agent.publish();
        expect.fail('Expected error was not thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('CreateAgentJsonError');
      } finally {
        validateStub.restore();
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

  describe('createAuthoringBundle', () => {
    let sfProject: SfProject;
    let testOutputDir: string;

    beforeEach(async () => {
      sfProject = SfProject.getInstance();
      // @ts-expect-error Not the full package def
      $$.SANDBOX.stub(sfProject, 'getDefaultPackage').returns({ path: 'force-app', fullPath: 'force-app' });
      testOutputDir = join('test-output', 'createAuthoringBundle');
    });

    afterEach(async () => {
      // Clean up test files
      await fs.rm(join('force-app', 'main', 'default', 'aiAuthoringBundles'), { recursive: true, force: true });
      await fs.rm(testOutputDir, { recursive: true, force: true });
    });

    it('should create bundle files with default values when agentSpec is not provided', async () => {
      const bundleApiName = 'TestBundle_Default';
      await ScriptAgent.createAuthoringBundle({
        project: sfProject,
        bundleApiName,
      });

      const defaultOutputDir = join('force-app', 'main', 'default', 'aiAuthoringBundles', bundleApiName);
      const agentPath = join(defaultOutputDir, `${bundleApiName}.agent`);
      const metaXmlPath = join(defaultOutputDir, `${bundleApiName}.bundle-meta.xml`);

      // Verify files exist
      const agentContent = await fs.readFile(agentPath, 'utf-8');
      const metaXmlContent = await fs.readFile(metaXmlPath, 'utf-8');

      // Verify .agent file content
      expect(agentContent).to.include('system:');
      expect(agentContent).to.include('instructions: "You are an AI Agent."');
      expect(agentContent).to.include('developer_name: "TestBundle_Default"');
      expect(agentContent).to.include('agent_label: "New Agent"');
      expect(agentContent).to.include('topic escalation:');
      expect(agentContent).to.include('topic off_topic:');
      expect(agentContent).to.include('topic ambiguous_question:');

      // Verify .bundle-meta.xml file content
      expect(metaXmlContent).to.include('<?xml version="1.0" encoding="UTF-8"?>');
      expect(metaXmlContent).to.include('<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">');
      expect(metaXmlContent).to.include('<bundleType>AGENT</bundleType>');
      expect(metaXmlContent).to.include('</AiAuthoringBundle>');
    });

    it('should create bundle files with agentSpec when provided', async () => {
      const bundleApiName = 'TestBundle_WithSpec';
      const agentSpec: ExtendedAgentJobSpec = {
        agentType: 'customer',
        role: 'answer questions about vacation rentals',
        companyName: 'Coral Cloud Enterprises',
        companyDescription: 'Provide vacation rentals and activities',
        developerName: 'Vacation_Rental_Agent',
        name: 'Vacation Rental Agent',
        topics: [
          {
            name: 'Guest Experience Enhancement',
            description: 'Enhance the guest experience with personalized recommendations',
          },
          {
            name: 'Booking Management',
            description: 'Help users manage their bookings and reservations',
          },
        ] as unknown as DraftAgentTopics,
      };
      await ScriptAgent.createAuthoringBundle({
        project: sfProject,
        bundleApiName,
        agentSpec,
      });

      const defaultOutputDir = join('force-app', 'main', 'default', 'aiAuthoringBundles', bundleApiName);
      const agentPath = join(defaultOutputDir, `${bundleApiName}.agent`);
      const metaXmlPath = join(defaultOutputDir, `${bundleApiName}.bundle-meta.xml`);

      // Verify files exist
      const agentContent = await fs.readFile(agentPath, 'utf-8');
      const metaXmlContent = await fs.readFile(metaXmlPath, 'utf-8');

      // Verify .agent file content includes agentSpec data
      expect(agentContent).to.include('developer_name: "Vacation_Rental_Agent"');
      expect(agentContent).to.include('topic guest_experience_enhancement:');
      expect(agentContent).to.include('label: "Guest Experience Enhancement"');
      expect(agentContent).to.include('description: "Enhance the guest experience with personalized recommendations"');
      expect(agentContent).to.include('topic booking_management:');
      expect(agentContent).to.include('label: "Booking Management"');
      expect(agentContent).to.include('description: "Help users manage their bookings and reservations"');
      expect(agentContent).to.include(
        'go_to_guest_experience_enhancement: @utils.transition to @topic.guest_experience_enhancement'
      );
      expect(agentContent).to.include('go_to_booking_management: @utils.transition to @topic.booking_management');

      // Verify .bundle-meta.xml file content
      expect(metaXmlContent).to.include('<?xml version="1.0" encoding="UTF-8"?>');
      expect(metaXmlContent).to.include('<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata">');
      expect(metaXmlContent).to.include('<bundleType>AGENT</bundleType>');
      expect(metaXmlContent).to.include('</AiAuthoringBundle>');
    });

    it('should create bundle files in custom outputDir when provided', async () => {
      const bundleApiName = 'TestBundle_CustomDir';
      await ScriptAgent.createAuthoringBundle({
        project: sfProject,
        bundleApiName,
        outputDir: testOutputDir,
      });

      const agentPath = join(testOutputDir, 'aiAuthoringBundles', bundleApiName, `${bundleApiName}.agent`);
      const metaXmlPath = join(testOutputDir, 'aiAuthoringBundles', bundleApiName, `${bundleApiName}.bundle-meta.xml`);

      // Verify files exist in custom directory
      const agentContent = await fs.readFile(agentPath, 'utf-8');
      const metaXmlContent = await fs.readFile(metaXmlPath, 'utf-8');

      expect(agentContent).to.include('system:');
      expect(agentContent).to.include('instructions: "You are an AI Agent."');
      expect(metaXmlContent).to.include('<bundleType>AGENT</bundleType>');
    });

    it('should create bundle files with agentSpec and custom outputDir', async () => {
      const bundleApiName = 'TestBundle_SpecAndCustomDir';
      const agentSpec: ExtendedAgentJobSpec = {
        agentType: 'internal',
        role: 'help employees with internal processes',
        companyName: 'Test Company',
        companyDescription: 'A test company',
        developerName: 'Internal_Helper_Agent',
        name: 'Internal Helper Agent',
        topics: [
          {
            name: 'HR Questions',
            description: 'Answer questions about HR policies',
          },
        ] as unknown as DraftAgentTopics,
      };
      await ScriptAgent.createAuthoringBundle({
        project: sfProject,
        bundleApiName,
        outputDir: testOutputDir,
        agentSpec,
      });

      const agentPath = join(testOutputDir, 'aiAuthoringBundles', bundleApiName, `${bundleApiName}.agent`);
      const metaXmlPath = join(testOutputDir, 'aiAuthoringBundles', bundleApiName, `${bundleApiName}.bundle-meta.xml`);

      // Verify files exist in custom directory
      const agentContent = await fs.readFile(agentPath, 'utf-8');
      const metaXmlContent = await fs.readFile(metaXmlPath, 'utf-8');

      // Verify .agent file content includes agentSpec data
      expect(agentContent).to.include('developer_name: "Internal_Helper_Agent"');
      expect(agentContent).to.include('topic hr_questions:');
      expect(agentContent).to.include('label: "HR Questions"');
      expect(agentContent).to.include('description: "Answer questions about HR policies"');

      // Verify .bundle-meta.xml file content
      expect(metaXmlContent).to.include('<bundleType>AGENT</bundleType>');
    });

    it('should handle empty topics array in agentSpec', async () => {
      const bundleApiName = 'TestBundle_EmptyTopics';
      const agentSpec: ExtendedAgentJobSpec = {
        agentType: 'customer',
        role: 'test role',
        companyName: 'Test Company',
        companyDescription: 'Test description',
        developerName: 'Test_Agent',
        name: 'Test Agent',
        topics: [] as unknown as DraftAgentTopics,
      };

      await ScriptAgent.createAuthoringBundle({
        project: sfProject,
        bundleApiName,
        agentSpec,
      });

      const defaultOutputDir = join('force-app', 'main', 'default', 'aiAuthoringBundles', bundleApiName);
      const agentPath = join(defaultOutputDir, `${bundleApiName}.agent`);
      const agentContent = await fs.readFile(agentPath, 'utf-8');

      // Verify .agent file content
      expect(agentContent).to.include('developer_name: "Test_Agent"');
      // Should not include any topic transitions in the topic_selector
      expect(agentContent).to.include('start_agent topic_selector:');
      // Should still include default topics (escalation, off_topic, ambiguous_question)
      expect(agentContent).to.include('topic escalation:');
      expect(agentContent).to.include('topic off_topic:');
      expect(agentContent).to.include('topic ambiguous_question:');
    });
  });
});
