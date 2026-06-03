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
    const files = await AgentDataLibrary.listFiles(connection, libraryId);
    expect(files.length).to.be.greaterThan(2);
    console.log(`Files: ${files.map((f) => f.fileName).join(', ')}`);
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
