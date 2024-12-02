/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfProject } from '@salesforce/core';
import { Agent } from '../src/agent';
import { AgentJobSpecCreateConfig } from '../src/types';

describe('Agents', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = 'test/mocks';
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
      type: 'customer_facing',
      role: 'answer questions about vacation_rentals',
      companyName: 'Coral Cloud Enterprises',
      companyDescription: 'Provide vacation rentals and activities',
    });

    // TODO: make this assertion more meaningful
    expect(output).to.be.ok;
  });

  it('create', async () => {
    const sfProject = SfProject.getInstance();
    const agent = new Agent(connection, sfProject);
    const opts: AgentJobSpecCreateConfig = {
      name: 'MyFirstAgent',
      type: 'customer_facing',
      role: 'answer questions about vacation rentals',
      companyName: 'Coral Cloud Enterprises',
      companyDescription: 'Provide vacation rentals and activities',
    };
    const jobSpecs = await agent.createSpec(opts);
    expect(jobSpecs).to.be.ok;
    const output = agent.create({
      ...opts,
      jobSpecs,
    });
    // TODO: make this assertion more meaningful
    expect(output).to.be.ok;
  });
});
