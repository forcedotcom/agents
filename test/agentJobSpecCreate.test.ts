/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { SfProject } from '@salesforce/core';
import { Agent } from '../src/agent';

describe('agent job spec create test', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  $$.inProject(true);

  it('runs agent run test', async () => {
    const connection = await testOrg.getConnection();
    const sfProject = SfProject.getInstance();
    const agent = new Agent(connection, sfProject);
    const output = agent.createSpec({
      name: 'MyFirstAgent',
      type: 'customer_facing',
      role: 'answer questions about vacation rentals',
      companyName: 'Coral Cloud Enterprises',
      companyDescription: 'Provide vacation rentals and activities',
    });
    expect(output).to.be.ok;
  });
});
