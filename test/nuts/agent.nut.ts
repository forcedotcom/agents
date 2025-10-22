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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'chai';
import { genUniqueString, TestSession } from '@salesforce/cli-plugins-testkit';
import { Connection, Org, SfProject, User, UserFields } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { sleep } from '@salesforce/kit';
import { Agent, type AgentJobSpec, type AgentJobSpecCreateConfig } from '../../src/index';

/* eslint-disable no-console */
// Helper function to wait for Einstein AI services to be ready
async function waitForEinsteinReady(connection: Connection, maxAttempts = 30): Promise<void> {
  // eslint-disable-next-line no-await-in-loop
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Check Agent API status using direct HTTP call
      const statusResponse = await connection.request<{ status: 'UP' | 'DOWN' }>({ // eslint-disable-line no-await-in-loop
        method: 'GET',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/status',
        headers: {
          'x-salesforce-region': 'us-west-2'
        }
      });

      if (statusResponse.status === 'UP') {;
        return;
      }
    } catch (error) {
      // do nothing
    }
    // Wait 10 seconds between checks
    await sleep(10 * 1000); // eslint-disable-line no-await-in-loop
  }
  const timeoutSeconds = maxAttempts * 10;
  throw new Error(`Einstein AI did not become ready within ${timeoutSeconds} seconds timeout`);
}

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

    // Wait for Einstein AI services to be fully initialized using polling
    await waitForEinsteinReady(connection);
  });

  after(async () => {
    await session?.clean();
  });

  describe('List and Get Bot Metadata', () => {
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
      // @ts-expect-error - private method. Must use this to prevent the auth flow that happens with the createUser method
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const { userId } = (await botUser.createUserInternal({
        username,
        lastName: 'AgentUser',
        alias: 'botUser',
        timeZoneSidKey: 'America/Denver',
        email: username,
        emailEncodingKey: 'UTF-8',
        languageLocaleKey: 'en_US',
        localeSidKey: 'en_US',
        profileId,
      } as UserFields)) as { userId: string };

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
      if (!deployResult.response.success) {
        console.dir(deployResult.response, { depth: 10 });
      }
      expect(deployResult.response.success, 'expected deploy to succeed').to.equal(true);

      // wait for the agent to be provisioned
      console.log('\nwaiting 2 minutes for agent to be provisioned...');
      await sleep(120_000);
    });

    describe('getBotMetadata()', () => {
      it('should get agent bot metadata by bot developer name', async () => {
        const agent = new Agent({ connection, nameOrId: botApiName });
        const botMetadata = await agent.getBotMetadata();
        expect(botMetadata).to.be.an('object');
        expect(botMetadata.Id).to.be.a('string');
        expect(botMetadata.BotUserId).to.be.a('string');
        expect(botMetadata.AgentType).to.equal('EinsteinServiceAgent');
        expect(botMetadata.DeveloperName).to.equal(botApiName);
        expect(botMetadata.BotVersions.records.length).to.equal(1);
        botId = botMetadata.Id;
        expect(botMetadata.BotVersions.records[0].BotDefinitionId).to.equal(botId);
      });

      it('should get agent bot metadata by botId', async () => {
        const agent = new Agent({ connection, nameOrId: botId });
        const botMetadata = await agent.getBotMetadata();
        expect(botMetadata).to.be.an('object');
        expect(botMetadata.Id).to.equal(botId);
        expect(botMetadata.BotUserId).to.be.a('string');
        expect(botMetadata.AgentType).to.equal('EinsteinServiceAgent');
        expect(botMetadata.DeveloperName).to.equal(botApiName);
        expect(botMetadata.BotVersions.records.length).to.equal(1);
        expect(botMetadata.BotVersions.records[0].BotDefinitionId).to.equal(botId);
      });
    });

    describe('getLatestBotVersionMetadata()', () => {
      it('should get the latest agent bot version metadata by bot developer name', async () => {
        const agent = new Agent({ connection, nameOrId: botApiName });
        const botVersionMetadata = await agent.getLatestBotVersionMetadata();
        expect(botVersionMetadata).to.be.an('object');
        expect(botVersionMetadata.Id).to.be.a('string');
        expect(botVersionMetadata.Status).to.be.a('string');
        expect(botVersionMetadata.IsDeleted).to.equal(false);
        expect(botVersionMetadata.DeveloperName).to.equal('v1');
        expect(botVersionMetadata.BotDefinitionId).to.equal(botId);
      });
    });

    describe('listRemote()', () => {
      it('should list all agents in the org', async () => {
        const agents = await Agent.listRemote(connection);
        expect(agents).to.be.an('array');
        expect(agents.length).to.equal(1);
        expect(agents[0].DeveloperName).to.equal(botApiName);
        expect(agents[0].Id).to.equal(botId);
        expect(agents[0].BotVersions.records.length).to.equal(1);
        expect(agents[0].BotVersions.records[0].BotDefinitionId).to.equal(botId);
      });
    });

    describe('activate/deactivate', () => {
      it('should activate the agent', async () => {
        const agent = new Agent({ connection, nameOrId: botId });
        let botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[0].Status).to.equal('Inactive');
        try {
          await agent.activate();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'err';
          console.log('error activating agent. Waiting 2 minutes and trying again.', errMsg);
          await sleep(120_000);
          await agent.activate();
        }

        botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[0].Status).to.equal('Active');
      });

      it('should deactivate the agent', async () => {
        const agent = new Agent({ connection, nameOrId: botId });
        let botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[0].Status).to.equal('Active');
        await agent.deactivate();
        botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[0].Status).to.equal('Inactive');
      });
    });
  });

  describe('agent create', () => {
    it('should create an agent spec', async () => {
      const agentConfig: AgentJobSpecCreateConfig = {
        agentType: 'customer',
        role: 'answer questions about the climbing gym',
        companyName: 'The Campus',
        companyDescription: 'A climbing gym built by climbers for climbers',
        maxNumOfTopics: 3,
      };
      try {
        agentSpec = await Agent.createSpec(connection, agentConfig);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'err';
        console.log('error creating agent spec attempt 1. Waiting 2 minutes and trying again.', errMsg);
        // If the agent spec fails during creation, try again.
        await sleep(120_000);
        try {
          agentSpec = await Agent.createSpec(connection, agentConfig);
        } catch (e) {
          // If the agent spec fails again, try one more time
          const eMsg = e instanceof Error ? e.message : 'err';
          console.log('error creating agent spec attempt 2. Waiting 3 minutes and trying again.', eMsg);
          // If the agent spec fails during creation, try again.
          await sleep(180_000);
          agentSpec = await Agent.createSpec(connection, agentConfig);
        }
      }

      expect(agentSpec).to.be.ok;
      expect(agentSpec.agentType).to.equal(agentConfig.agentType);
      expect(agentSpec.role).to.equal(agentConfig.role);
      expect(agentSpec.companyName).to.equal(agentConfig.companyName);
      expect(agentSpec.companyDescription).to.equal(agentConfig.companyDescription);
      expect(agentSpec.maxNumOfTopics).to.equal(agentConfig.maxNumOfTopics);
      expect(agentSpec.topics).to.have.lengthOf(3);
    });

    it('should create an agent from a spec', async () => {
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
      if (!agentResponse.isSuccess) {
        console.dir(agentResponse, { depth: 10 });
      }
      expect(agentResponse.isSuccess).to.equal(true);
      expect(agentResponse.agentDefinition).to.be.ok;
      expect(agentResponse.agentId?.botId).to.be.ok;
      agentResponse.agentDefinition.agentDescription;

      // verify agent metadata files are retrieved to the project
      const sourceDir = join(session.project.dir, 'force-app', 'main', 'default');
      expect(readdirSync(join(sourceDir, 'bots'))).to.have.lengthOf(2);
      expect(readdirSync(join(sourceDir, 'genAiPlannerBundles'))).to.have.lengthOf(2);
      expect(readdirSync(join(sourceDir, 'genAiPlugins'))).to.have.lengthOf(6);
    });
  });

  describe('compileAgentScript', () => {
    it('should compile a lululemon agent script successfully', async () => {
      // Read the lululemon agent script from the project
      const lululemonAgentPath = join(session.project.dir, 'force-app', 'main', 'default', 'aiAuthoringBundles', 'lululemon', 'lululemon.agent');
      const lululemonAgentScript = readFileSync(lululemonAgentPath, 'utf8');

      const result = await Agent.compileAgentScript(connection, lululemonAgentScript);

      // Verify the response structure
      expect(result).to.be.an('object');
      expect(result).to.have.property('status', 'success');
      expect(result).to.have.property('compiledArtifact');
      expect(result.compiledArtifact).to.not.be.null;
      expect(result.compiledArtifact).to.be.an('object');
      expect(result.compiledArtifact).to.have.property('schemaVersion');
      expect(result.compiledArtifact).to.have.property('globalConfiguration');
      expect(result.compiledArtifact).to.have.property('agentVersion');
    });

    it('should return compilation errors for invalid agent script', async () => {
      // Invalid agent script - missing closing brace
      const invalidAgentScript = `
        agent InvalidAgent {
          greeting {
            instructions: "Hello!"
          // Missing closing brace for agent
      `;

      const result = await Agent.compileAgentScript(connection, invalidAgentScript);

      // Verify the response indicates failure
      expect(result).to.be.an('object');
      expect(result).to.have.property('status', 'failure');
      expect(result).to.have.property('errors');
      expect(result.errors).to.be.an('array');
      expect(result.errors.length).to.be.greaterThan(0);

      // Verify error structure
      const firstError = result.errors[0];
      expect(firstError).to.have.property('errorType');
      expect(firstError).to.have.property('description');
    });
  });
});
