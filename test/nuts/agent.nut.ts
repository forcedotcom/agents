/*
 * Copyright (c) 2025, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'chai';
import { genUniqueString, TestSession } from '@salesforce/cli-plugins-testkit';
import { Connection, Org, SfProject, User, UserFields } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { sleep } from '@salesforce/kit';
import { Agent, type AgentJobSpec, type AgentJobSpecCreateConfig } from '../../src/index';

/* eslint-disable no-console */

describe('agent NUTs', () => {
  const agentName = 'The Campus Agent Test';
  let session: TestSession;
  let connection: Connection;
  let defaultOrg: Org;
  let agentSpec: AgentJobSpec;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: join('test', 'projects', 'agent-project'),
      },
      devhubAuthStrategy: 'AUTO',
      scratchOrgs: [
        {
          setDefault: true,
          config: join('config', 'project-scratch-def.json'),
        },
      ],
    });
    const username = session.orgs.get('default')!.username as string;
    defaultOrg = await Org.create({ aliasOrUsername: username });
    connection = defaultOrg.getConnection();

    // assign the EinsteinGPTPromptTemplateManager to the scratch org admin user
    const queryResult = await connection.singleRecordQuery<{ Id: string }>(
      `SELECT Id FROM User WHERE Username='${username}'`
    );
    const user = await User.create({ org: defaultOrg });
    await user.assignPermissionSets(queryResult.Id, ['EinsteinGPTPromptTemplateManager']);
  });

  after(async () => {
    await session?.clean();
  });

  // skipping because the server API is not reliable enough to run in CI
  it.skip('should create an agent spec', async () => {
    const agentConfig: AgentJobSpecCreateConfig = {
      agentType: 'customer',
      role: 'answer questions about the climbing gym',
      companyName: 'The Campus',
      companyDescription: 'A climbing gym built by climbers for climbers',
      maxNumOfTopics: 5,
    };
    try {
      agentSpec = await Agent.createSpec(connection, agentConfig);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'err';
      console.log('error creating agent spec attempt 1. Waiting 10 seconds and trying again.', errMsg);
      // If the agent spec fails during creation, try again.
      await sleep(10_000);
      agentSpec = await Agent.createSpec(connection, agentConfig);
    }

    expect(agentSpec).to.be.ok;
    expect(agentSpec.agentType).to.equal(agentConfig.agentType);
    expect(agentSpec.role).to.equal(agentConfig.role);
    expect(agentSpec.companyName).to.equal(agentConfig.companyName);
    expect(agentSpec.companyDescription).to.equal(agentConfig.companyDescription);
    expect(agentSpec.maxNumOfTopics).to.equal(agentConfig.maxNumOfTopics);
    expect(agentSpec.topics).to.have.lengthOf(5);
  });

  // skipping because the server API is not reliable enough to run in CI
  it.skip('should create an agent from a spec', async () => {
    console.log('session.project.dir', session.project.dir);
    const project = await SfProject.resolve(session.project.dir);
    const agentResponse = await Agent.create(connection, project, {
      agentType: agentSpec.agentType,
      saveAgent: true,
      agentSettings: {
        agentName,
      },
      generationInfo: {
        defaultInfo: {
          role: agentSpec.role,
          companyName: agentSpec.companyName,
          companyDescription: agentSpec.companyDescription,
          preDefinedTopics: agentSpec.topics,
        },
      },
      generationSettings: {
        maxNumOfTopics: agentSpec.maxNumOfTopics,
      },
    });
    expect(agentResponse).to.be.ok;
    expect(agentResponse.isSuccess).to.equal(true);
    expect(agentResponse.agentDefinition).to.be.ok;
    expect(agentResponse.agentId?.botId).to.be.ok;
    agentResponse.agentDefinition.agentDescription;

    // verify agent metadata files are retrieved to the project
    const sourceDir = join(session.project.dir, 'force-app', 'main', 'default');
    expect(readdirSync(join(sourceDir, 'bots'))).to.have.lengthOf(1);
    expect(readdirSync(join(sourceDir, 'genAiPlanners'))).to.have.lengthOf(1);
    expect(readdirSync(join(sourceDir, 'genAiPlugins'))).to.have.lengthOf(5);
  });

  describe('getBotMetadata()', () => {
    let botId: string;
    const botApiName = 'Local_Info_Agent';

    before(async () => {
      // Query for the agent user profile
      const queryResult = await connection.singleRecordQuery<{ Id: string }>(
        "SELECT Id FROM Profile WHERE Name='Einstein Agent User'"
      );
      const profileId = queryResult.Id;

      // create a new unique bot user
      const username = genUniqueString('botUser_%s@test.org');
      const botUser = await User.create({ org: defaultOrg });
      // @ts-expect-error - private method
      const { userId } = await botUser.createUserInternal({
        username,
        lastName: 'AgentUser',
        alias: 'botUser',
        timeZoneSidKey: 'America/Denver',
        email: username,
        emailEncodingKey: 'UTF-8',
        languageLocaleKey: 'en_US',
        localeSidKey: 'en_US',
        profileId,
      } as UserFields);

      await botUser.assignPermissionSets(userId, ['AgentforceServiceAgentUser']);

      // Replace the botUser with the current user's username
      const botDir = join(session.project.dir, 'force-app', 'main', 'default', 'bots', botApiName);
      const botFile = readFileSync(join(botDir, 'Local_Info_Agent.bot-meta.xml'), 'utf8');
      const updatedBotFile = botFile.replace('%BOT_USER%', username);
      writeFileSync(join(botDir, 'Local_Info_Agent.bot-meta.xml'), updatedBotFile);

      // deploy project to scratch org
      const compSet = await ComponentSetBuilder.build({
        sourcepath: [join(session.project.dir, 'force-app')],
      });
      const deploy = await compSet.deploy({ usernameOrConnection: connection });
      const deployResult = await deploy.pollStatus();
      expect(deployResult.response.success, 'expected deploy to succeed').to.equal(true);
    });

    it('should get agent bot metadata by bot developer name', async () => {
      const agent = new Agent({ connection, nameOrId: botApiName });
      const botMetadata = await agent.getBotMetadata();
      expect(botMetadata).to.be.an('object');
      expect(botMetadata.Id).to.be.a('string');
      expect(botMetadata.BotUserId).to.be.a('string');
      expect(botMetadata.AgentType).to.equal('EinsteinServiceAgent');
      expect(botMetadata.DeveloperName).to.equal(botApiName);
      botId = botMetadata.Id;
    });

    it('should get agent bot metadata by botId', async () => {
      const agent = new Agent({ connection, nameOrId: botId });
      const botMetadata = await agent.getBotMetadata();
      expect(botMetadata).to.be.an('object');
      expect(botMetadata.Id).to.equal(botId);
      expect(botMetadata.BotUserId).to.be.a('string');
      expect(botMetadata.AgentType).to.equal('EinsteinServiceAgent');
      expect(botMetadata.DeveloperName).to.equal(botApiName);
    });
  });
});
