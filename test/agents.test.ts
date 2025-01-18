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
import { Agent } from '../src/agent';
import type { AgentJobSpecCreateConfig, AgentCreateConfigV2 } from '../src/types';

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

  it('createSpec', async () => {
    const sfProject = SfProject.getInstance();
    const agent = new Agent(connection, sfProject);
    const output = await agent.createSpec({
      name: 'MyFirstAgent',
      type: 'customer',
      role: 'answer questions about vacation_rentals',
      companyName: 'Coral Cloud Enterprises',
      companyDescription: 'Provide vacation rentals and activities',
    });

    // TODO: make this assertion more meaningful
    expect(output).to.be.ok;
  });

  it('createSpecV2 (mock behavior) should return a spec', async () => {
    const sfProject = SfProject.getInstance();
    const agent = new Agent(connection, sfProject);
    const agentType = 'customer';
    const companyName = 'Coral Cloud Enterprises';
    const output = await agent.createSpecV2({
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

  it('createV2 save agent', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAgent-Save');
    const sfProject = SfProject.getInstance();
    const agent = new Agent(connection, sfProject);
    const config: AgentCreateConfigV2 = {
      agentType: 'customer',
      saveAgent: true,
      agentSettings: {
        agentName: 'My First Agent',
        agentApiName: 'My_First_Agent',
        userId: 'new',
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
    const response = await agent.createV2(config);
    expect(response).to.have.property('isSuccess', true);
    expect(response).to.have.property('agentId');
    expect(response).to.have.property('agentDefinition');
  });

  it('createV2 preview agent', async () => {
    process.env.SF_MOCK_DIR = join('test', 'mocks', 'createAgent-Preview');
    const sfProject = SfProject.getInstance();
    const agent = new Agent(connection, sfProject);
    const config: AgentCreateConfigV2 = {
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
    const response = await agent.createV2(config);
    expect(response).to.have.property('isSuccess', true);
    expect(response).to.not.have.property('agentId');
    expect(response).to.have.property('agentDefinition');
  });

  it('create', async () => {
    const sfProject = SfProject.getInstance();
    const agent = new Agent(connection, sfProject);
    const opts: AgentJobSpecCreateConfig = {
      name: 'MyFirstAgent',
      type: 'customer',
      role: 'answer questions about vacation rentals',
      companyName: 'Coral Cloud Enterprises',
      companyDescription: 'Provide vacation rentals and activities',
    };
    const jobSpec = await agent.createSpec(opts);
    expect(jobSpec).to.be.ok;
    const output = agent.create({
      ...opts,
      jobSpec,
    });
    // TODO: make this assertion more meaningful
    expect(output).to.be.ok;
  });
});
