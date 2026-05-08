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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'chai';
import { genUniqueString, TestSession } from '@salesforce/cli-plugins-testkit';
import { Connection, Org, SfProject, User, UserFields } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { sleep } from '@salesforce/kit';
import { Agent, ScriptAgent, type AgentJobSpec, type AgentJobSpecCreateConfig } from '../../src';

/* eslint-disable no-console */
// Helper function to wait for Einstein AI services to be ready
async function waitForEinsteinReady(connection: Connection, maxAttempts = 30): Promise<void> {
  // eslint-disable-next-line no-await-in-loop
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Check Agent API status using direct HTTP call
      // eslint-disable-next-line no-await-in-loop
      const statusResponse = await connection.request<{ status: 'UP' | 'DOWN' }>({
        // eslint-disable-line no-await-in-loop
        method: 'GET',
        url: 'https://api.salesforce.com/einstein/ai-agent/v1/status',
        headers: {
          'x-salesforce-region': 'us-west-2',
        },
      });

      if (statusResponse.status === 'UP') {
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
  let project: SfProject;
  let agentSpec: AgentJobSpec;
  let defaultAgentUsername: string;

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
    project = await SfProject.resolve(session.project.dir);

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
      defaultAgentUsername = genUniqueString('botUser_%s@test.org');
      const botUser = await User.create({ org: defaultOrg });
      // @ts-expect-error - private method. Must use this to prevent the auth flow that happens with the createUser method
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const { userId } = (await botUser.createUserInternal({
        username: defaultAgentUsername,
        lastName: 'AgentUser',
        alias: 'botUser',
        timeZoneSidKey: 'America/Denver',
        email: defaultAgentUsername,
        emailEncodingKey: 'UTF-8',
        languageLocaleKey: 'en_US',
        localeSidKey: 'en_US',
        profileId,
      } as UserFields)) as { userId: string };

      await botUser.assignPermissionSets(userId, ['AgentforceServiceAgentUser']);

      // Replace the botUser with the current user's username
      const botDir = join(session.project.dir, 'force-app', 'main', 'default', 'bots', botApiName);
      const botFile = readFileSync(join(botDir, 'Local_Info_Agent.bot-meta.xml'), 'utf8');
      const updatedBotFile = botFile.replace('%BOT_USER%', defaultAgentUsername);
      writeFileSync(join(botDir, 'Local_Info_Agent.bot-meta.xml'), updatedBotFile);

      // deploy project to scratch org
      const compSet = await ComponentSetBuilder.build({
        sourcepath: [join(session.project.dir, 'force-app')],
        apiversion: '65.0',
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
        const agent = await Agent.init({ connection, project, apiNameOrId: botApiName });
        const botMetadata = await agent.getBotMetadata();
        expect(botMetadata).to.be.an('object');
        expect(botMetadata.Id).to.be.a('string');
        expect(botMetadata.BotUserId).to.be.a('string');
        expect(botMetadata.AgentType).to.equal('EinsteinServiceAgent');
        expect(botMetadata.DeveloperName).to.equal(botApiName);
        expect(botMetadata.BotVersions.records.length).to.equal(2);
        botId = botMetadata.Id;
        expect(botMetadata.BotVersions.records[0].BotDefinitionId).to.equal(botId);
        expect(botMetadata.BotVersions.records[1].BotDefinitionId).to.equal(botId);
      });

      it('should get agent bot metadata by botId', async () => {
        const agent = await Agent.init({ connection, project, apiNameOrId: botId });
        const botMetadata = await agent.getBotMetadata();
        expect(botMetadata).to.be.an('object');
        expect(botMetadata.Id).to.equal(botId);
        expect(botMetadata.BotUserId).to.be.a('string');
        expect(botMetadata.AgentType).to.equal('EinsteinServiceAgent');
        expect(botMetadata.DeveloperName).to.equal(botApiName);
        expect(botMetadata.BotVersions.records.length).to.equal(2);
        expect(botMetadata.BotVersions.records[0].BotDefinitionId).to.equal(botId);
        expect(botMetadata.BotVersions.records[1].BotDefinitionId).to.equal(botId);
      });
    });

    describe('getLatestBotVersionMetadata()', () => {
      it('should get the latest agent bot version metadata by bot developer name', async () => {
        const agent = await Agent.init({ connection, project, apiNameOrId: botApiName });
        const botVersionMetadata = await agent.getLatestBotVersionMetadata();
        expect(botVersionMetadata).to.be.an('object');
        expect(botVersionMetadata.Id).to.be.a('string');
        expect(botVersionMetadata.Status).to.be.a('string');
        expect(botVersionMetadata.IsDeleted).to.equal(false);
        expect(botVersionMetadata.DeveloperName).to.equal('v2');
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
        expect(agents[0].BotVersions.records.length).to.equal(2);
        expect(agents[0].BotVersions.records[0].BotDefinitionId).to.equal(botId);
        expect(agents[0].BotVersions.records[1].BotDefinitionId).to.equal(botId);
        expect(agents[0].BotVersions.records[1].VersionNumber).to.be.greaterThan(
          agents[0].BotVersions.records[0].VersionNumber
        );
      });
    });

    describe('activate/deactivate', () => {
      it('should activate the agent', async () => {
        const agent = await Agent.init({ connection, project, apiNameOrId: botId });
        let botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[1].Status).to.equal('Inactive');
        try {
          await agent.activate();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'err';
          console.log('error activating agent. Waiting 2 minutes and trying again.', errMsg);
          await sleep(120_000);
          await agent.activate();
        }

        botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[1].Status).to.equal('Active');
      });

      it('should deactivate the agent', async () => {
        const agent = await Agent.init({ connection, project, apiNameOrId: botId });
        let botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[1].Status).to.equal('Active');
        await agent.deactivate();
        botMetadata = await agent.getBotMetadata();
        expect(botMetadata.BotVersions.records[1].Status).to.equal('Inactive');
      });
    });

    describe('Create and preview AAB agent', () => {
      const bundleApiName = 'Test_AAB_Preview';
      let simulatedSessionId: string;

      before(async () => {
        await ScriptAgent.createAuthoringBundle({ project, bundleApiName });

        // Set the default agent user in the agent script so we can test live preview
        const aabDir = join(session.project.dir, 'force-app', 'main', 'default', 'aiAuthoringBundles', bundleApiName);
        const agentScriptFile = readFileSync(join(aabDir, 'Test_AAB_Preview.agent'), 'utf8');
        const updatedAgentScriptFile = agentScriptFile.replace('NEW AGENT USER', defaultAgentUsername);
        writeFileSync(join(aabDir, 'Test_AAB_Preview.agent'), updatedAgentScriptFile);
      });

      it('should start a preview session (simulated)', async () => {
        const agent = await Agent.init({ connection, project, aabName: bundleApiName });
        const previewSession = await agent.preview.start();
        expect(previewSession).to.be.an('object');
        expect(previewSession.sessionId).to.be.a('string');
        expect(previewSession.sessionId).to.not.be.empty;
        simulatedSessionId = previewSession.sessionId;

        // verify metadata files in local .sfdx directory
        const agentBaseDir = join(project.getPath(), '.sfdx', 'agents', bundleApiName);
        const indexMdPath = join(agentBaseDir, 'index.md');
        expect(existsSync(indexMdPath)).to.be.true;
        const sessionDir = join(agentBaseDir, 'sessions', simulatedSessionId);
        expect(existsSync(sessionDir)).to.be.true;

        // verify contents of index.md
        const indexMd = readFileSync(indexMdPath, 'utf8');
        expect(indexMd).to.contain(`# ${bundleApiName} - Sessions`);
        expect(indexMd).to.contain(`\`${simulatedSessionId}\` | simulated`);

        // verify turn-index.json exists and has proper structure
        const turnIndexPath = join(sessionDir, 'turn-index.json');
        expect(existsSync(turnIndexPath), 'turn-index.json should exist').to.be.true;

        const turnIndexContent = readFileSync(turnIndexPath, 'utf8');
        const turnIndex = JSON.parse(turnIndexContent) as {
          version: string;
          sessionId: string;
          agentId: string;
          created: string;
          turns: Array<{ turn: number; timestamp: string; role: string }>;
        };

        expect(turnIndex.version).to.equal('1.0');
        expect(turnIndex.sessionId).to.equal(simulatedSessionId);
        expect(turnIndex.agentId).to.equal(bundleApiName);
        expect(turnIndex.turns).to.be.an('array');
        expect(turnIndex.turns.length).to.be.greaterThan(0); // At least initial greeting

        // verify metadata.json exists
        const metadataPath = join(sessionDir, 'metadata.json');
        expect(existsSync(metadataPath), 'metadata.json should exist').to.be.true;

        const metadataContent = readFileSync(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataContent) as {
          sessionId: string;
          agentId: string;
          startTime: string;
          planIds: string[];
        };

        expect(metadata.sessionId).to.equal(simulatedSessionId);
        expect(metadata.agentId).to.equal(bundleApiName);
        expect(metadata.startTime).to.be.a('string');
        expect(metadata.planIds).to.be.an('array');
      });

      it('should start a preview session (live)', async () => {
        const agent = await Agent.init({ connection, project, aabName: bundleApiName });
        agent.preview.setMockMode('Live Test');
        const previewSession = await agent.preview.start();
        expect(previewSession).to.be.an('object');
        expect(previewSession.sessionId).to.be.a('string');
        expect(previewSession.sessionId).to.not.be.empty;
        const liveSessionId = previewSession.sessionId;

        // verify metadata files in local .sfdx directory
        const agentBaseDir = join(project.getPath(), '.sfdx', 'agents', bundleApiName);
        const indexMdPath = join(agentBaseDir, 'index.md');
        expect(existsSync(indexMdPath)).to.be.true;
        const sessionDir = join(agentBaseDir, 'sessions', liveSessionId);
        expect(existsSync(sessionDir)).to.be.true;

        // verify contents of index.md
        const indexMd = readFileSync(indexMdPath, 'utf8');
        expect(indexMd).to.contain(`# ${bundleApiName} - Sessions`);
        expect(indexMd).to.contain(`\`${liveSessionId}\` | live`);
        expect(indexMd).to.contain(`\`${simulatedSessionId}\` | simulated`);

        // verify turn-index.json exists for live session
        const turnIndexPath = join(sessionDir, 'turn-index.json');
        expect(existsSync(turnIndexPath), 'turn-index.json should exist for live session').to.be.true;

        const turnIndexContent = readFileSync(turnIndexPath, 'utf8');
        const turnIndex = JSON.parse(turnIndexContent) as {
          version: string;
          sessionId: string;
          agentId: string;
          turns: Array<{ turn: number }>;
        };

        expect(turnIndex.version).to.equal('1.0');
        expect(turnIndex.sessionId).to.equal(liveSessionId);
        expect(turnIndex.agentId).to.equal(bundleApiName);
        expect(turnIndex.turns).to.be.an('array');

        // verify metadata.json has correct mode
        const metadataPath = join(sessionDir, 'metadata.json');
        const metadataContent = readFileSync(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataContent) as { mockMode?: string };
        expect(metadata.mockMode).to.equal('Live Test');
      });

      it('should send a message to the agent', async () => {
        const agent = await Agent.init({ connection, project, aabName: bundleApiName });
        const previewSession = await agent.preview.start();
        const sessionId = previewSession.sessionId;

        // Send a message
        const response = await agent.preview.send('What can you help me with?');
        expect(response).to.be.an('object');
        expect(response.messages).to.be.an('array');
        expect(response.messages.length).to.be.greaterThan(0);

        const sessionDir = join(project.getPath(), '.sfdx', 'agents', bundleApiName, 'sessions', sessionId);

        // Verify turn-index.json was updated with the conversation
        const turnIndexPath = join(sessionDir, 'turn-index.json');
        const turnIndexContent = readFileSync(turnIndexPath, 'utf8');
        const turnIndex = JSON.parse(turnIndexContent) as {
          turns: Array<{
            turn: number;
            timestamp: string;
            role: string;
            summary: string;
            traceFile: string | null;
            planId: string | null;
          }>;
        };

        expect(turnIndex.turns.length).to.be.greaterThan(1); // At least greeting + user message + agent response

        // Verify turns have sequential turn numbers
        turnIndex.turns.forEach((turn, index) => {
          expect(turn.turn).to.equal(index + 1);
          expect(turn.timestamp).to.be.a('string');
          expect(turn.role).to.be.oneOf(['user', 'agent']);
          expect(turn.summary).to.be.a('string');
        });

        // Verify at least one agent turn has a trace file
        const agentTurnsWithTraces = turnIndex.turns.filter((turn) => turn.role === 'agent' && turn.traceFile !== null);
        expect(agentTurnsWithTraces.length).to.be.greaterThan(0, 'At least one agent turn should have a trace file');

        // Verify metadata.json has planIds populated
        const metadataPath = join(sessionDir, 'metadata.json');
        const metadataContent = readFileSync(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataContent) as { planIds: string[] };

        expect(metadata.planIds).to.be.an('array');
        expect(metadata.planIds.length).to.be.greaterThan(0, 'planIds array should be populated');

        // Verify planIds in metadata match planIds in turn-index
        const planIdsFromTurnIndex = turnIndex.turns.filter((turn) => turn.planId !== null).map((turn) => turn.planId);
        expect(metadata.planIds).to.have.members(planIdsFromTurnIndex);

        // Verify transcript.jsonl correlates with turn-index
        const transcriptPath = join(sessionDir, 'transcript.jsonl');
        const transcriptContent = readFileSync(transcriptPath, 'utf8');
        const transcriptLines = transcriptContent.trim().split('\n');
        expect(transcriptLines.length).to.equal(turnIndex.turns.length);

        // Verify trace files exist for turns that have traceFile references
        agentTurnsWithTraces.forEach((turn) => {
          if (turn.traceFile) {
            const tracePath = join(sessionDir, turn.traceFile);
            expect(existsSync(tracePath), `Trace file ${turn.traceFile} should exist`).to.be.true;
          }
        });
      });

      it('should end the preview session', async () => {
        const agent = await Agent.init({ connection, project, aabName: bundleApiName });
        const previewSession = await agent.preview.start();
        const sessionId = previewSession.sessionId;

        // Send a message to generate some history
        await agent.preview.send('Tell me about your features');

        // End the session
        await agent.preview.end();

        const sessionDir = join(project.getPath(), '.sfdx', 'agents', bundleApiName, 'sessions', sessionId);

        // Verify metadata.json has endTime populated
        const metadataPath = join(sessionDir, 'metadata.json');
        const metadataContent = readFileSync(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataContent) as {
          startTime: string;
          endTime?: string;
          planIds: string[];
        };

        expect(metadata.endTime).to.be.a('string');
        expect(metadata.endTime).to.not.be.empty;
        expect(new Date(metadata.endTime!).getTime()).to.be.greaterThan(new Date(metadata.startTime).getTime());

        // Verify final planIds array is populated
        expect(metadata.planIds).to.be.an('array');
        expect(metadata.planIds.length).to.be.greaterThan(0);

        // Verify turn-index has session end entry
        const turnIndexPath = join(sessionDir, 'turn-index.json');
        const turnIndexContent = readFileSync(turnIndexPath, 'utf8');
        const turnIndex = JSON.parse(turnIndexContent) as {
          turns: Array<{ role: string; reason?: string }>;
        };

        const lastTurn = turnIndex.turns[turnIndex.turns.length - 1];
        expect(lastTurn.role).to.equal('agent');
        expect(lastTurn.reason).to.equal('UserRequest');
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
});
