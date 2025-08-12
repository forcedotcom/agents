/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { join } from 'node:path';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfProject } from '@salesforce/core';
import { ComponentSetBuilder, ComponentSet, MetadataApiRetrieve } from '@salesforce/source-deploy-retrieve';
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

  it('createAgentDsl (mock behavior) should return full agent dsl', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAgentDsl');
    const output = await Agent.createAgentDsl(connection, 'AF Script string');
    expect(output).to.have.property('schema_version', '1.0');
    expect(output).to.have.property('global_configuration').and.be.an('object');
    expect(output).to.have.property('agent_version').and.be.an('object');
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
