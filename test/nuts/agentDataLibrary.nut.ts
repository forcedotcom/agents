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
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { Connection, Org } from '@salesforce/core';
import { AgentDataLibrary } from '../../src/agentDataLibrary';

/* eslint-disable no-console */

// AgentDataLibrary NUT — Tests ADL operations against a real org.
// Requires a pre-authenticated org with Data Cloud provisioned.
//
// Usage:
//   TARGET_ORG=sdb3 RETRIEVER_ID=1CxSB000000G5Rx0AK yarn test:nuts --grep "AgentDataLibrary"

const targetOrg = process.env.TARGET_ORG;
const retrieverId = process.env.RETRIEVER_ID;

describe('AgentDataLibrary NUTs — SFDRIVE', function () {
  this.timeout(15 * 60 * 1000);

  let connection: Connection;
  let libraryId: string;
  let testFile: string;
  let testFile2: string;

  before(async function () {
    if (!targetOrg) {
      console.log('Skipping ADL NUTs: set TARGET_ORG env var');
      this.skip();
    }

    const org = await Org.create({ aliasOrUsername: targetOrg });
    connection = org.getConnection();

    testFile = join(tmpdir(), 'adl-agents-nut-test.txt');
    testFile2 = join(tmpdir(), 'adl-agents-nut-test2.txt');
    writeFileSync(testFile, 'AgentDataLibrary NUT test document.');
    writeFileSync(testFile2, 'AgentDataLibrary NUT second document for day-1.');
  });

  after(async () => {
    if (libraryId && connection) {
      try {
        await AgentDataLibrary.delete(connection, libraryId);
        console.log(`Cleanup: deleted ${libraryId}`);
      } catch {
        console.log(`Cleanup: delete failed for ${libraryId} (may still be provisioning)`);
      }
    }
  });

  it('should list libraries (prerequisite check)', async () => {
    const result = await AgentDataLibrary.list(connection);
    expect(result).to.have.property('libraries');
    console.log(`ADL API accessible — ${result.libraries.length} existing libraries`);
  });

  it('should create an SFDRIVE library', async () => {
    const devName = `NUT_Lib_${Date.now()}`;
    const result = await AgentDataLibrary.create(connection, {
      masterLabel: devName,
      developerName: devName,
      groundingSource: { sourceType: 'SFDRIVE' },
    });

    expect(result).to.have.property('libraryId');
    libraryId = result.libraryId;
    console.log(`Created SFDRIVE library: ${libraryId}`);
  });

  it('should get library detail', async () => {
    const result = await AgentDataLibrary.get(connection, libraryId);
    expect(result.libraryId).to.equal(libraryId);
    expect(result.sourceType).to.equal('SFDRIVE');
  });

  it('should get indexing status', async () => {
    const result = await AgentDataLibrary.status(connection, libraryId);
    expect(result.indexingStatus.libraryId).to.equal(libraryId);
    expect(result.indexingStatus).to.have.property('status');
    expect(result.indexingStatus).to.have.property('stageDetails');
  });

  it('should upload multiple files and wait for READY', async function () {
    this.timeout(10 * 60 * 1000);

    const result = await AgentDataLibrary.upload(connection, libraryId, [testFile, testFile2], { waitMinutes: 10 });

    expect(result.libraryId).to.equal(libraryId);
    expect(result.status).to.equal('READY');
    expect(result.retrieverId).to.be.a('string');
    expect(result.ragFeatureConfigId).to.equal(`ARFPC_${libraryId}`);
    console.log(`Multi-file upload complete — retrieverId: ${result.retrieverId}`);
  });

  it('should update library metadata', async () => {
    const result = await AgentDataLibrary.update(connection, libraryId, {
      masterLabel: 'NUT_Updated',
      description: 'Updated by AgentDataLibrary NUT',
    });

    expect(result.masterLabel).to.equal('NUT_Updated');
  });

  it('should add a second file (day-1)', async function () {
    this.timeout(3 * 60 * 1000);

    const result = await AgentDataLibrary.addFile(connection, libraryId, testFile2);

    expect(result.success).to.be.true;
    expect(result.fileName).to.include('adl-agents-nut-test2.txt');
  });

  it('should add multiple files in batch (day-1)', async function () {
    this.timeout(3 * 60 * 1000);

    const file3 = join(tmpdir(), 'adl-agents-nut-test3.txt');
    const file4 = join(tmpdir(), 'adl-agents-nut-test4.txt');
    writeFileSync(file3, 'Third test file for multi-file add.');
    writeFileSync(file4, 'Fourth test file for multi-file add.');

    const result = await AgentDataLibrary.addFile(connection, libraryId, [file3, file4]);

    expect(result.success).to.be.true;
    expect(result.fileName).to.include('adl-agents-nut-test3.txt');
    expect(result.fileName).to.include('adl-agents-nut-test4.txt');
  });

  it('should list files in the library', async () => {
    const response = await AgentDataLibrary.listFiles(connection, libraryId);
    expect(response.files.length).to.be.greaterThan(2);
    console.log(`Files: ${response.files.map((f) => f.fileName).join(', ')}`);
  });

  it('should list libraries with sourceType filter', async () => {
    const result = await AgentDataLibrary.list(connection, { sourceType: 'SFDRIVE' });
    expect(result.libraries.length).to.be.greaterThan(0);
    for (const lib of result.libraries) {
      expect(lib.sourceType).to.equal('SFDRIVE');
    }
  });
});

describe('AgentDataLibrary NUTs — KNOWLEDGE', function () {
  this.timeout(5 * 60 * 1000);

  let connection: Connection;
  let libraryId: string;

  before(async function () {
    if (!targetOrg) {
      this.skip();
    }
    const org = await Org.create({ aliasOrUsername: targetOrg });
    connection = org.getConnection();
  });

  after(async () => {
    if (libraryId && connection) {
      try {
        await AgentDataLibrary.delete(connection, libraryId);
        console.log(`Cleanup: deleted Knowledge library ${libraryId}`);
      } catch {
        console.log(`Cleanup: delete failed for ${libraryId}`);
      }
    }
  });

  it('should create a KNOWLEDGE library with config', async () => {
    const devName = `NUT_Know_${Date.now()}`;
    const result = await AgentDataLibrary.create(connection, {
      masterLabel: devName,
      developerName: devName,
      groundingSource: {
        sourceType: 'KNOWLEDGE',
        knowledgeConfig: {
          primaryIndexField1: 'ArticleNumber',
          primaryIndexField2: 'Title',
        },
      },
    });

    expect(result).to.have.property('libraryId');
    expect(result.sourceType).to.equal('KNOWLEDGE');
    libraryId = result.libraryId;
    console.log(`Created KNOWLEDGE library: ${libraryId}`);
  });

  it('should get Knowledge library detail', async () => {
    const result = await AgentDataLibrary.get(connection, libraryId);
    expect(result.sourceType).to.equal('KNOWLEDGE');
  });

  it('should get Knowledge indexing status with stages', async () => {
    const result = await AgentDataLibrary.status(connection, libraryId);
    expect(result.indexingStatus.libraryId).to.equal(libraryId);
    expect(result.indexingStatus).to.have.property('stageDetails');
  });

  it('should update Knowledge metadata (best-effort — may fail if still provisioning)', async () => {
    try {
      const result = await AgentDataLibrary.update(connection, libraryId, {
        masterLabel: 'NUT_Know_Updated',
        description: 'Updated Knowledge lib',
      });
      expect(result.masterLabel).to.equal('NUT_Know_Updated');
    } catch (err: unknown) {
      const error = err as { message?: string };
      if (error.message?.includes('provisioning operation is currently in progress')) {
        console.log('Update skipped — library still provisioning (expected for freshly created Knowledge)');
      } else {
        throw err;
      }
    }
  });
});

describe('AgentDataLibrary NUTs — Data Categories', function () {
  this.timeout(5 * 60 * 1000);

  let connection: Connection;
  let libraryId: string;
  const dataCategoryNames = process.env.DATA_CATEGORY_NAMES;

  before(async function () {
    if (!targetOrg || !dataCategoryNames) {
      console.log('Skipping Data Category NUTs: set TARGET_ORG and DATA_CATEGORY_NAMES env vars');
      this.skip();
    }
    const org = await Org.create({ aliasOrUsername: targetOrg });
    connection = org.getConnection();
  });

  after(async () => {
    if (libraryId && connection) {
      try {
        await AgentDataLibrary.delete(connection, libraryId);
        console.log(`Cleanup: deleted data category library ${libraryId}`);
      } catch {
        console.log(`Cleanup: delete failed for ${libraryId}`);
      }
    }
  });

  it('should create KNOWLEDGE library with dataCategorySelectionNames and auto-enable rule', async () => {
    const devName = `NUT_DC_${Date.now()}`;
    const categories = dataCategoryNames!.split(',').map((n) => n.trim());

    const result = await AgentDataLibrary.create(connection, {
      masterLabel: devName,
      developerName: devName,
      groundingSource: {
        sourceType: 'KNOWLEDGE',
        knowledgeConfig: {
          primaryIndexField1: 'ArticleNumber',
          primaryIndexField2: 'Title',
          contentFields: ['Summary'],
          isDataCategoryRuleEnabled: true,
          dataCategorySelectionNames: categories,
        },
      },
    });

    expect(result).to.have.property('libraryId');
    libraryId = result.libraryId;

    const detail = await AgentDataLibrary.get(connection, libraryId);
    const kc = detail.groundingSource as { knowledgeConfig?: { isDataCategoryRuleEnabled?: boolean; dataCategorySelectionIds?: string[] } };
    expect(kc.knowledgeConfig?.isDataCategoryRuleEnabled).to.be.true;
    expect(kc.knowledgeConfig?.dataCategorySelectionIds).to.be.an('array').with.length.greaterThan(0);
    console.log(`Created with ${kc.knowledgeConfig!.dataCategorySelectionIds!.length} resolved category IDs`);
  });

  it('should disable data category rule via update (best-effort)', async () => {
    try {
      const result = await AgentDataLibrary.update(connection, libraryId, {
        groundingSource: {
          sourceType: 'KNOWLEDGE',
          knowledgeConfig: {
            isDataCategoryRuleEnabled: false,
          },
        },
      });

      const kc = result.groundingSource as { knowledgeConfig?: { isDataCategoryRuleEnabled?: boolean } };
      expect(kc.knowledgeConfig?.isDataCategoryRuleEnabled).to.be.false;
      console.log('✓ Data category rule disabled via update');
    } catch (err: unknown) {
      const error = err as { message?: string };
      if (error.message?.includes('provisioning operation is currently in progress')) {
        console.log('Update skipped — library still provisioning (expected)');
      } else {
        throw err;
      }
    }
  });

  it('should re-enable data category rule via update (best-effort)', async () => {
    try {
      const result = await AgentDataLibrary.update(connection, libraryId, {
        groundingSource: {
          sourceType: 'KNOWLEDGE',
          knowledgeConfig: {
            isDataCategoryRuleEnabled: true,
          },
        },
      });

      const kc = result.groundingSource as { knowledgeConfig?: { isDataCategoryRuleEnabled?: boolean } };
      expect(kc.knowledgeConfig?.isDataCategoryRuleEnabled).to.be.true;
      console.log('✓ Data category rule re-enabled via update');
    } catch (err: unknown) {
      const error = err as { message?: string };
      if (error.message?.includes('provisioning operation is currently in progress')) {
        console.log('Update skipped — library still provisioning (expected)');
      } else {
        throw err;
      }
    }
  });
});

describe('AgentDataLibrary NUTs — RETRIEVER', function () {
  this.timeout(3 * 60 * 1000);

  let connection: Connection;
  let libraryId: string;

  before(async function () {
    if (!targetOrg || !retrieverId) {
      console.log('Skipping RETRIEVER NUTs: set TARGET_ORG and RETRIEVER_ID env vars');
      this.skip();
    }
    const org = await Org.create({ aliasOrUsername: targetOrg });
    connection = org.getConnection();
  });

  after(async () => {
    if (libraryId && connection) {
      try {
        await AgentDataLibrary.delete(connection, libraryId);
        console.log(`Cleanup: deleted Retriever library ${libraryId}`);
      } catch {
        console.log(`Cleanup: delete failed for ${libraryId}`);
      }
    }
  });

  it('should create a RETRIEVER library (immediately READY)', async () => {
    const devName = `NUT_Ret_${Date.now()}`;
    const result = await AgentDataLibrary.create(connection, {
      masterLabel: devName,
      developerName: devName,
      groundingSource: { sourceType: 'RETRIEVER', retrieverId },
    });

    expect(result).to.have.property('libraryId');
    expect(result.sourceType).to.equal('RETRIEVER');
    libraryId = result.libraryId;
    console.log(`Created RETRIEVER library: ${libraryId}`);
  });

  it('should get Retriever detail with status READY', async () => {
    const result = await AgentDataLibrary.get(connection, libraryId);
    expect(result.sourceType).to.equal('RETRIEVER');
    expect(result.status).to.equal('READY');
    expect(result.retrieverId).to.equal(retrieverId);
  });

  it('should update Retriever metadata', async () => {
    const result = await AgentDataLibrary.update(connection, libraryId, {
      masterLabel: 'NUT_Ret_Updated',
      description: 'Updated Retriever',
    });

    expect(result.masterLabel).to.equal('NUT_Ret_Updated');
  });

  it('should swap retrieverId via update', async () => {
    const result = await AgentDataLibrary.update(connection, libraryId, {
      groundingSource: {
        sourceType: 'RETRIEVER',
        retrieverId,
      },
    });

    expect(result.retrieverId).to.equal(retrieverId);
  });

  it('should delete Retriever library', async () => {
    await AgentDataLibrary.delete(connection, libraryId);
    libraryId = '';
  });
});

describe('AgentDataLibrary NUTs — 262.11 Features', function () {
  this.timeout(3 * 60 * 1000);

  let connection: Connection;
  const readyLibraryId = process.env.READY_SFDRIVE_ID;
  const knowledgeLibraryId = process.env.READY_KNOWLEDGE_ID;

  before(async function () {
    if (!targetOrg || !readyLibraryId) {
      console.log('Skipping 262.11 NUTs: set TARGET_ORG and READY_SFDRIVE_ID env vars');
      this.skip();
    }
    const org = await Org.create({ aliasOrUsername: targetOrg });
    connection = org.getConnection();
  });

  it('should get status with includeArtifacts and return artifacts array', async () => {
    const result = await AgentDataLibrary.status(connection, readyLibraryId!, { includeArtifacts: true });

    expect(result.indexingStatus.libraryId).to.equal(readyLibraryId);
    expect(result.indexingStatus).to.have.property('stageDetails');
    expect(result.indexingStatus.stageDetails).to.be.an('array');

    // At least one stage should have artifacts
    const stageDetails = result.indexingStatus.stageDetails ?? [];
    const stagesWithArtifacts = stageDetails.filter((stage) => stage.artifacts && stage.artifacts.length > 0);
    expect(stagesWithArtifacts.length).to.be.greaterThan(0);

    // Verify artifacts structure
    const firstStageWithArtifacts = stagesWithArtifacts[0];
    expect(firstStageWithArtifacts.artifacts).to.be.an('array');
    console.log(`Stage "${firstStageWithArtifacts.name}" has ${firstStageWithArtifacts.artifacts?.length} artifacts`);
  });

  it('should listFiles and return FileListResponse shape', async () => {
    const response = await AgentDataLibrary.listFiles(connection, readyLibraryId!);

    expect(response).to.have.property('files');
    expect(response).to.have.property('totalSize');
    expect(response.files).to.be.an('array');
    expect(response.totalSize).to.be.a('number');
    expect(response.files.length).to.be.greaterThan(0);
    console.log(`Library has ${response.files.length} files (totalSize: ${response.totalSize})`);
  });

  it('should listFiles with pageSize and return pagination URLs', async () => {
    const response = await AgentDataLibrary.listFiles(connection, readyLibraryId!, { pageSize: 1 });

    expect(response).to.have.property('files');
    expect(response).to.have.property('totalSize');
    expect(response.files).to.be.an('array');
    expect(response.files.length).to.equal(1);
    expect(response).to.have.property('currentPageUrl');

    // Should have nextPageUrl if there are more files
    if (response.totalSize > 1) {
      expect(response).to.have.property('nextPageUrl');
      expect(response.nextPageUrl).to.be.a('string');
      console.log(`Pagination works — page 1 of ${response.totalSize} files`);
    }
  });

  it('should listFiles with status filter', async () => {
    const response = await AgentDataLibrary.listFiles(connection, readyLibraryId!, { status: 'INDEXED' });

    expect(response).to.have.property('files');
    expect(response.files).to.be.an('array');

    // All returned files should have status INDEXED
    for (const file of response.files) {
      expect(file.status).to.equal('INDEXED');
    }

    console.log(`Found ${response.files.length} INDEXED files`);
  });

  it('should return files with status field', async () => {
    const response = await AgentDataLibrary.listFiles(connection, readyLibraryId!);

    expect(response.files.length).to.be.greaterThan(0);

    // Every file should have a status field
    for (const file of response.files) {
      expect(file).to.have.property('status');
      expect(file.status).to.be.a('string');
    }

    const statusCounts: Record<string, number> = {};
    for (const file of response.files) {
      const status = file.status ?? 'UNKNOWN';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }

    console.log(`File statuses: ${JSON.stringify(statusCounts)}`);
  });

  it('should return totalFileCount on library detail', async () => {
    const driveResult = await AgentDataLibrary.get(connection, readyLibraryId!);
    console.log(`SFDRIVE totalFileCount: ${driveResult.totalFileCount ?? 'not present'}`);

    if (driveResult.totalFileCount !== undefined) {
      expect(driveResult.totalFileCount).to.be.a('number');
    }

    if (knowledgeLibraryId) {
      const knowledgeResult = await AgentDataLibrary.get(connection, knowledgeLibraryId);
      console.log(`Knowledge totalFileCount: ${knowledgeResult.totalFileCount ?? 'not present'}`);
      if (knowledgeResult.totalFileCount !== undefined) {
        expect(knowledgeResult.totalFileCount).to.be.a('number');
      }
    }
  });

  it('should return retriever as structured object with id and label', async () => {
    const result = await AgentDataLibrary.get(connection, readyLibraryId!);

    expect(result).to.have.property('retriever');
    expect(result.retriever).to.be.an('object');

    if (result.retriever) {
      expect(result.retriever).to.have.property('id');
      expect(result.retriever).to.have.property('label');
      expect(result.retriever.id).to.be.a('string');
      expect(result.retriever.label).to.be.a('string');
      console.log(`Retriever: ${result.retriever.label} (${result.retriever.id})`);
    }
  });

  it('should return retrieverAction as structured object with id and label', async () => {
    const result = await AgentDataLibrary.get(connection, readyLibraryId!);

    // retrieverAction may not always be present, but if it is, verify structure
    if (result.retrieverAction) {
      expect(result.retrieverAction).to.be.an('object');
      expect(result.retrieverAction).to.have.property('id');
      expect(result.retrieverAction).to.have.property('label');
      expect(result.retrieverAction.id).to.be.a('string');
      expect(result.retrieverAction.label).to.be.a('string');
      console.log(`RetrieverAction: ${result.retrieverAction.label} (${result.retrieverAction.id})`);
    } else {
      console.log('RetrieverAction not present (this is optional)');
    }
  });
});
