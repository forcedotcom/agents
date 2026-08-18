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
import sinon from 'sinon';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, Messages, SfError, SfProject } from '@salesforce/core';
import { ProductionAgent } from '../src/agents/productionAgent';
import { ConnectionManager, setManagerForTesting } from '../src/connectionManager';
import type { BotMetadata, ContextVariable, PlannerResponse } from '../src/types';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

function createMockConnectionManager(conn: Connection): ConnectionManager {
  return {
    jwtConnection: conn,
    standardConnection: conn,
    getJwtConnection: () => conn,
    getStandardConnection: () => conn,
    inspectJwt: () => ({
      isValid: true,
      hasRequiredFields: true,
      missingFields: [],
      isExpired: false,
    }),
  } as unknown as ConnectionManager;
}

describe('ProductionAgent', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let connectionManager: ConnectionManager;
  let sfProject: SfProject;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = 'test/mocks';
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://mydomain.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();

    connectionManager = createMockConnectionManager(connection);
    setManagerForTesting(connection, connectionManager);

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

  describe('preview.start bypassUser', () => {
    const buildBotMetadata = (agentType: string): BotMetadata => ({
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
      AgentType: agentType,
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
    });

    let requestStub: sinon.SinonStub;

    beforeEach(() => {
      // Capture the session-start request body without hitting the network.
      requestStub = $$.SANDBOX.stub(connection, 'request');
      requestStub.resolves({ sessionId: 'test-session-id', _links: {}, messages: [] });
    });

    const getStartRequestBody = (): Record<string, unknown> => {
      const startCall = requestStub
        .getCalls()
        .find((c) => (c.args[0] as { url: string }).url.endsWith('/sessions'));
      if (!startCall) throw new Error('agent sessions request not captured');
      return JSON.parse((startCall.args[0] as { body: string }).body) as Record<string, unknown>;
    };

    it('sends bypassUser: false for an employee agent', async () => {
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(buildBotMetadata('AgentforceEmployeeAgent'));

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      await agent.preview.start();

      expect(getStartRequestBody().bypassUser).to.equal(false);
    });

    it('sends bypassUser: true for a non-employee (service) agent', async () => {
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(buildBotMetadata('EinsteinServiceAgent'));

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      await agent.preview.start();

      expect(getStartRequestBody().bypassUser).to.equal(true);
    });

    it('sends context variables as the `variables` array when provided', async () => {
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(buildBotMetadata('EinsteinServiceAgent'));

      const contextVariables: ContextVariable[] = [
        { name: 'CustomerId', type: 'Text', value: '001xx000003DGb2' },
        { name: 'IsVip', type: 'Boolean', value: 'true' },
      ];

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      await agent.preview.start({ contextVariables });

      expect(getStartRequestBody().variables).to.deep.equal(contextVariables);
    });

    it('defaults `variables` to an empty array when no context variables are provided', async () => {
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(buildBotMetadata('EinsteinServiceAgent'));

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      await agent.preview.start();

      expect(getStartRequestBody().variables).to.deep.equal([]);
    });

    const getStartRequestHeaders = (): Record<string, string> => {
      const startCall = requestStub
        .getCalls()
        .find((c) => (c.args[0] as { url: string }).url.endsWith('/sessions'));
      if (!startCall) throw new Error('agent sessions request not captured');
      return (startCall.args[0] as { headers: Record<string, string> }).headers;
    };

    it('sends the x-attributed-client: no-builder header on session start to strip markdown', async () => {
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(buildBotMetadata('EinsteinServiceAgent'));

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      await agent.preview.start();

      const headers = getStartRequestHeaders();
      expect(headers['x-attributed-client']).to.equal('no-builder');
      expect(headers['x-client-name']).to.equal('afdx');
    });
  });

  describe('getTrace', () => {
    const buildBotMetadata = (): BotMetadata => ({
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
      AgentType: 'EinsteinServiceAgent',
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
    });

    const trace: PlannerResponse = {
      type: 'PlanSuccessResponse',
      planId: 'plan-123',
      sessionId: 'test-session-id',
      intent: 'answer',
      topic: 'general',
      plan: [],
    };

    it('returns undefined when no session has been started', async () => {
      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      expect(await agent.getTrace('plan-123')).to.equal(undefined);
    });

    it('GETs the v1.1 preview plans endpoint for the committed session and returns the trace', async () => {
      $$.SANDBOX.stub(connection, 'singleRecordQuery').resolves(buildBotMetadata());

      const requestStub = $$.SANDBOX.stub(connection, 'request');
      // Session start returns the sessionId; the getTrace call returns the reasoning trace.
      requestStub.onFirstCall().resolves({ sessionId: 'test-session-id', _links: {}, messages: [] });
      requestStub.resolves(trace);

      const agent = new ProductionAgent({ connection, project: sfProject, apiNameOrId: 'TestAgent' });
      await agent.preview.start();

      const result = await agent.getTrace('plan-123');

      const traceCall = requestStub
        .getCalls()
        .find((c) => (c.args[0] as { url: string }).url.includes('/plans/'));
      if (!traceCall) throw new Error('getTrace request not captured');
      const { url, method } = traceCall.args[0] as { url: string; method: string };

      expect(method).to.equal('GET');
      expect(url).to.equal(
        'https://api.salesforce.com/einstein/ai-agent/v1.1/preview/sessions/test-session-id/plans/plan-123'
      );
      expect(result).to.deep.equal(trace);
    });
  });
});
