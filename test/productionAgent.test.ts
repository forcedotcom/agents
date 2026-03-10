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
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, Messages, SfError, SfProject } from '@salesforce/core';
import { ProductionAgent } from '../src/agents/productionAgent';
import type { BotMetadata } from '../src/types';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

describe('ProductionAgent', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let sfProject: SfProject;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = 'test/mocks';
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://mydomain.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();

    sfProject = SfProject.getInstance();
    // @ts-expect-error Not the full package def
    $$.SANDBOX.stub(sfProject, 'getDefaultPackage').returns({ path: 'force-app' });
  });

  afterEach(() => {
    delete process.env.SF_MOCK_DIR;
  });

  describe('getBotVersionMetadata', () => {
    it('should return latest version when version parameter is undefined', async () => {
      // Mock the getBotMetadata to return test data
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
            {
              Id: 'version2',
              Status: 'Active',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v2',
              CreatedDate: '2025-01-02T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-02T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-02T00:00:00.000+0000',
              VersionNumber: 2,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      const version = await agent.getBotVersionMetadata();

      expect(version.VersionNumber).to.equal(2);
      expect(version.Status).to.equal('Active');
      expect(version.Id).to.equal('version2');
    });

    it('should return specific version when version number is provided', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
            {
              Id: 'version2',
              Status: 'Active',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v2',
              CreatedDate: '2025-01-02T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-02T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-02T00:00:00.000+0000',
              VersionNumber: 2,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      const version = await agent.getBotVersionMetadata(1);

      expect(version.VersionNumber).to.equal(1);
      expect(version.Status).to.equal('Inactive');
      expect(version.Id).to.equal('version1');
    });

    it('should throw error when version not found', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });

      try {
        await agent.getBotVersionMetadata(99);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).message).to.include(messages.getMessage('versionNotFound', ['99']));
      }
    });

    it('should throw error when botVersions is empty', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });

      try {
        await agent.getBotVersionMetadata();
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).message).to.include(messages.getMessage('noVersionsFound', ['TestAgent']));
      }
    });

    it('should throw error when botVersions is empty and specific version requested', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });

      try {
        await agent.getBotVersionMetadata(1);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).message).to.include(messages.getMessage('noVersionsFound', ['TestAgent']));
      }
    });
  });

  describe('activate', () => {
    it('should activate specific version when version number is provided', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
            {
              Id: 'version2',
              Status: 'Active',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v2',
              CreatedDate: '2025-01-02T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-02T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-02T00:00:00.000+0000',
              VersionNumber: 2,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      const version = await agent.activate(1);

      expect(version.VersionNumber).to.equal(1);
      expect(version.Id).to.equal('version1');
    });

    it('should activate latest version when version parameter is undefined', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
            {
              Id: 'version2',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v2',
              CreatedDate: '2025-01-02T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-02T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-02T00:00:00.000+0000',
              VersionNumber: 2,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      const version = await agent.activate();

      expect(version.VersionNumber).to.equal(2);
      expect(version.Id).to.equal('version2');
    });

    it('should return already active version without making a request', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Active',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      const version = await agent.activate(1);

      expect(version.Status).to.equal('Active');
      expect(version.VersionNumber).to.equal(1);
    });

    it('should throw error when agent is deleted', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: true,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });

      try {
        await agent.activate(1);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).message).to.include(messages.getMessage('agentIsDeleted', ['TestAgent']));
      }
    });

    it('should throw error when trying to activate non-existent version', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });

      try {
        await agent.activate(99);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).message).to.include(messages.getMessage('versionNotFound', ['99']));
      }
    });

    it('should throw error when trying to activate with no versions available', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });

      try {
        await agent.activate();
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).message).to.include(messages.getMessage('noVersionsFound', ['TestAgent']));
      }
    });
  });

  describe('getLatestBotVersionMetadata', () => {
    it('should return the latest version', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [
            {
              Id: 'version1',
              Status: 'Inactive',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v1',
              CreatedDate: '2025-01-01T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-01T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-01T00:00:00.000+0000',
              VersionNumber: 1,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
            {
              Id: 'version2',
              Status: 'Active',
              IsDeleted: false,
              BotDefinitionId: '0Xx123456789ABC',
              DeveloperName: 'TestAgent_v2',
              CreatedDate: '2025-01-02T00:00:00.000+0000',
              CreatedById: 'user123',
              LastModifiedDate: '2025-01-02T00:00:00.000+0000',
              LastModifiedById: 'user123',
              SystemModstamp: '2025-01-02T00:00:00.000+0000',
              VersionNumber: 2,
              CopilotPrimaryLanguage: 'en_US',
              ToneType: 'formal',
              CopilotSecondaryLanguages: [],
            },
          ],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      const version = await agent.getLatestBotVersionMetadata();

      expect(version.VersionNumber).to.equal(2);
      expect(version.Status).to.equal('Active');
      expect(version.Id).to.equal('version2');
    });

    it('should throw error when no versions available', async () => {
      const mockBotMetadata: BotMetadata = {
        Id: '0Xx123456789ABC',
        IsDeleted: false,
        DeveloperName: 'TestAgent',
        MasterLabel: 'Test Agent',
        CreatedDate: '2025-01-01T00:00:00.000+0000',
        CreatedById: 'user123',
        LastModifiedDate: '2025-01-02T00:00:00.000+0000',
        LastModifiedById: 'user123',
        SystemModstamp: '2025-01-02T00:00:00.000+0000',
        BotUserId: 'botUser123',
        Description: 'Test bot description',
        Type: 'AgentForce',
        AgentType: 'Standard',
        AgentTemplate: null,
        BotVersions: {
          records: [],
        },
      };

      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(mockBotMetadata);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });

      try {
        await agent.getLatestBotVersionMetadata();
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).message).to.include(messages.getMessage('noVersionsFound', ['TestAgent']));
      }
    });
  });
});
