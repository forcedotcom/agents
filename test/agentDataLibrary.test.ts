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

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unused-vars */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection } from '@salesforce/core';
import { AgentDataLibrary } from '../src/agentDataLibrary';
import type { CreateLibraryInput, UpdateLibraryInput } from '../src/dataLibraryTypes';

describe('AgentDataLibrary', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;
  let requests: Array<{ method?: string; url?: string; body?: string }>;

  beforeEach(async () => {
    testOrg = new MockTestOrgData();
    await $$.stubAuths(testOrg);
    connection = await testOrg.getConnection();
    requests = [];
  });

  afterEach(() => {
    $$.restore();
  });

  function mockRequest(response: any): void {
    $$.fakeConnectionRequest = (req: any) => {
      requests.push(req);
      return Promise.resolve(response);
    };
  }

  describe('list', () => {
    it('should return libraries from the API', async () => {
      const mockLibraries = [
        { libraryId: '1JD000001', masterLabel: 'Test', developerName: 'Test', sourceType: 'SFDRIVE', status: 'READY' },
      ];
      mockRequest({ libraries: mockLibraries });

      const result = await AgentDataLibrary.list(connection);

      expect(result.libraries).to.deep.equal(mockLibraries);
      expect(requests[0].method).to.equal('GET');
      expect(requests[0].url).to.include('/einstein/data-libraries');
    });

    it('should pass sourceType filter as query param', async () => {
      mockRequest({ libraries: [] });

      await AgentDataLibrary.list(connection, { sourceType: 'SFDRIVE' });

      expect(requests[0].url).to.include('?sourceType=SFDRIVE');
    });

    it('should not include query param when no filter', async () => {
      mockRequest({ libraries: [] });

      await AgentDataLibrary.list(connection);

      expect(requests[0].url).to.not.include('?');
    });

    it('should throw on API error', async () => {
      $$.fakeConnectionRequest = () => Promise.reject(new Error('Network error'));

      try {
        await AgentDataLibrary.list(connection);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('Network error');
      }
    });
  });

  describe('create', () => {
    it('should create an SFDRIVE library', async () => {
      const input: CreateLibraryInput = {
        masterLabel: 'Test',
        developerName: 'Test',
        groundingSource: { sourceType: 'SFDRIVE' },
      };
      mockRequest({ libraryId: '1JD000001', masterLabel: 'Test', developerName: 'Test', sourceType: 'SFDRIVE' });

      const result = await AgentDataLibrary.create(connection, input);

      expect(result.libraryId).to.equal('1JD000001');
      expect(requests[0].method).to.equal('POST');
      const body = JSON.parse(requests[0].body!);
      expect(body.groundingSource.sourceType).to.equal('SFDRIVE');
    });

    it('should auto-trigger indexing for KNOWLEDGE via fetch', async () => {
      const input: CreateLibraryInput = {
        masterLabel: 'KB',
        developerName: 'KB',
        groundingSource: {
          sourceType: 'KNOWLEDGE',
          knowledgeConfig: { primaryIndexField1: 'ArticleNumber', primaryIndexField2: 'Title' },
        },
      };
      mockRequest({ libraryId: '1JD000002', masterLabel: 'KB', developerName: 'KB', sourceType: 'KNOWLEDGE' });

      // stub global fetch for the indexing call
      const fetchStub = $$.SANDBOX.stub(global, 'fetch');
      fetchStub.resolves(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 201 }));

      await AgentDataLibrary.create(connection, input);

      // create goes through connection.request, indexing goes through fetch
      expect(requests).to.have.lengthOf(1);
      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0] as string).to.include('/indexing');
      expect((fetchStub.firstCall.args[1] as { method: string }).method).to.equal('POST');
    });

    it('should not trigger indexing for RETRIEVER', async () => {
      const input: CreateLibraryInput = {
        masterLabel: 'Ret',
        developerName: 'Ret',
        groundingSource: { sourceType: 'RETRIEVER', retrieverId: '1Cx000001' },
      };
      mockRequest({ libraryId: '1JD000003', masterLabel: 'Ret', developerName: 'Ret', sourceType: 'RETRIEVER' });

      await AgentDataLibrary.create(connection, input);

      expect(requests).to.have.lengthOf(1);
    });

    it('should throw when retriever is not active', async () => {
      $$.fakeConnectionRequest = () => Promise.reject(new Error('INVALID_REQUEST_STATE: The custom retriever is not active. Activate the retriever before adding it to a Data Library.'));

      const input: CreateLibraryInput = {
        masterLabel: 'Ret',
        developerName: 'Ret',
        groundingSource: { sourceType: 'RETRIEVER', retrieverId: '1Cx_INACTIVE' },
      };

      try {
        await AgentDataLibrary.create(connection, input);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('not active');
      }
    });

    it('should pass indexMode for SFDRIVE', async () => {
      const input: CreateLibraryInput = {
        masterLabel: 'Test',
        developerName: 'Test',
        groundingSource: { sourceType: 'SFDRIVE', indexMode: 'ENHANCED' },
      };
      mockRequest({ libraryId: '1JD000004', masterLabel: 'Test', developerName: 'Test', sourceType: 'SFDRIVE' });

      await AgentDataLibrary.create(connection, input);

      const body = JSON.parse(requests[0].body!);
      expect(body.groundingSource.indexMode).to.equal('ENHANCED');
    });

    it('should pass retrieverId for RETRIEVER', async () => {
      const input: CreateLibraryInput = {
        masterLabel: 'Ret',
        developerName: 'Ret',
        groundingSource: { sourceType: 'RETRIEVER', retrieverId: '0pmSG000000001KAAQ' },
      };
      mockRequest({ libraryId: '1JD000005', masterLabel: 'Ret', developerName: 'Ret', sourceType: 'RETRIEVER' });

      await AgentDataLibrary.create(connection, input);

      const body = JSON.parse(requests[0].body!);
      expect(body.groundingSource.sourceType).to.equal('RETRIEVER');
      expect(body.groundingSource.retrieverId).to.equal('0pmSG000000001KAAQ');
    });

    it('should pass full knowledgeConfig for KNOWLEDGE', async () => {
      const input: CreateLibraryInput = {
        masterLabel: 'KB Full',
        developerName: 'KB_Full',
        description: 'Full knowledge config',
        groundingSource: {
          sourceType: 'KNOWLEDGE',
          knowledgeConfig: {
            primaryIndexField1: 'ArticleNumber',
            primaryIndexField2: 'Title',
            contentFields: ['Answer__c', 'Summary__c'],
            isRestrictToPublicArticle: true,
          },
        },
      };
      mockRequest({ libraryId: '1JD000006', masterLabel: 'KB Full', developerName: 'KB_Full', sourceType: 'KNOWLEDGE' });

      await AgentDataLibrary.create(connection, input);

      const body = JSON.parse(requests[0].body!);
      expect(body.groundingSource.sourceType).to.equal('KNOWLEDGE');
      expect(body.groundingSource.knowledgeConfig.primaryIndexField1).to.equal('ArticleNumber');
      expect(body.groundingSource.knowledgeConfig.primaryIndexField2).to.equal('Title');
      expect(body.groundingSource.knowledgeConfig.contentFields).to.deep.equal(['Answer__c', 'Summary__c']);
      expect(body.groundingSource.knowledgeConfig.isRestrictToPublicArticle).to.be.true;
      expect(body.description).to.equal('Full knowledge config');
    });

    it('should pass description for any source type', async () => {
      const input: CreateLibraryInput = {
        masterLabel: 'Test',
        developerName: 'Test',
        description: 'My description',
        groundingSource: { sourceType: 'SFDRIVE' },
      };
      mockRequest({ libraryId: '1JD000007', masterLabel: 'Test', developerName: 'Test', sourceType: 'SFDRIVE' });

      await AgentDataLibrary.create(connection, input);

      const body = JSON.parse(requests[0].body!);
      expect(body.description).to.equal('My description');
    });
  });

  describe('get', () => {
    it('should return library detail', async () => {
      mockRequest({ libraryId: '1JD000001', masterLabel: 'Test', sourceType: 'SFDRIVE', status: 'READY', retrieverId: '1Cx000001' });

      const result = await AgentDataLibrary.get(connection, '1JD000001');

      expect(result.libraryId).to.equal('1JD000001');
      expect(result.retrieverId).to.equal('1Cx000001');
      expect(requests[0].url).to.include('/1JD000001');
    });
  });

  describe('update', () => {
    it('should send PATCH with metadata', async () => {
      const input: UpdateLibraryInput = { masterLabel: 'Updated', description: 'New desc' };
      mockRequest({ libraryId: '1JD000001', masterLabel: 'Updated', developerName: 'Test' });

      const result = await AgentDataLibrary.update(connection, '1JD000001', input);

      expect(result.masterLabel).to.equal('Updated');
      expect(requests[0].method).to.equal('PATCH');
      const body = JSON.parse(requests[0].body!);
      expect(body.masterLabel).to.equal('Updated');
    });

    it('should send knowledgeConfig in groundingSource', async () => {
      const input: UpdateLibraryInput = {
        groundingSource: {
          sourceType: 'KNOWLEDGE',
          knowledgeConfig: { contentFields: ['Answer__c'], isRestrictToPublicArticle: true },
        },
      };
      mockRequest({ libraryId: '1JD000001', masterLabel: 'KB' });

      await AgentDataLibrary.update(connection, '1JD000001', input);

      const body = JSON.parse(requests[0].body!);
      expect(body.groundingSource.knowledgeConfig.contentFields).to.deep.equal(['Answer__c']);
      expect(body.groundingSource.knowledgeConfig.isRestrictToPublicArticle).to.be.true;
    });

    it('should update only contentFields without restrictToPublicArticle', async () => {
      const input: UpdateLibraryInput = {
        groundingSource: {
          sourceType: 'KNOWLEDGE',
          knowledgeConfig: { contentFields: ['Answer__c', 'Summary__c'] },
        },
      };
      mockRequest({ libraryId: '1JD000001', masterLabel: 'KB' });

      await AgentDataLibrary.update(connection, '1JD000001', input);

      const body = JSON.parse(requests[0].body!);
      expect(body.groundingSource.knowledgeConfig.contentFields).to.deep.equal(['Answer__c', 'Summary__c']);
      expect(body.groundingSource.knowledgeConfig.isRestrictToPublicArticle).to.be.undefined;
    });

    it('should combine metadata and knowledgeConfig update', async () => {
      const input: UpdateLibraryInput = {
        masterLabel: 'Updated KB',
        description: 'New desc',
        groundingSource: {
          sourceType: 'KNOWLEDGE',
          knowledgeConfig: { contentFields: ['Answer__c'] },
        },
      };
      mockRequest({ libraryId: '1JD000001', masterLabel: 'Updated KB' });

      await AgentDataLibrary.update(connection, '1JD000001', input);

      const body = JSON.parse(requests[0].body!);
      expect(body.masterLabel).to.equal('Updated KB');
      expect(body.description).to.equal('New desc');
      expect(body.groundingSource.knowledgeConfig.contentFields).to.deep.equal(['Answer__c']);
    });

    it('should throw on update error (e.g. provisioning in progress)', async () => {
      $$.fakeConnectionRequest = () => Promise.reject(new Error('INVALID_REQUEST_STATE: Cannot update library'));

      try {
        await AgentDataLibrary.update(connection, '1JD000001', { masterLabel: 'Fail' });
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('Cannot update library');
      }
    });
  });

  describe('delete', () => {
    it('should send DELETE request', async () => {
      mockRequest({});

      await AgentDataLibrary.delete(connection, '1JD000001');

      expect(requests[0].method).to.equal('DELETE');
      expect(requests[0].url).to.include('/1JD000001');
    });

    it('should throw on API error', async () => {
      $$.fakeConnectionRequest = () => Promise.reject(new Error('Cannot delete'));

      try {
        await AgentDataLibrary.delete(connection, '1JD000001');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('Cannot delete');
      }
    });
  });

  describe('status', () => {
    it('should return indexing status', async () => {
      const mockResult = {
        indexingStatus: {
          libraryId: '1JD000001',
          status: 'IN_PROGRESS',
          stageDetails: [
            { name: 'DATA_LAKE_OBJECT', status: 'SUCCESS' },
            { name: 'SEARCH_INDEX', status: 'IN_PROGRESS' },
          ],
        },
      };
      mockRequest(mockResult);

      const result = await AgentDataLibrary.status(connection, '1JD000001');

      expect(result.indexingStatus.status).to.equal('IN_PROGRESS');
      expect(result.indexingStatus.stageDetails).to.have.lengthOf(2);
      expect(requests[0].url).to.include('/status');
    });
  });

  describe('listFiles', () => {
    it('should return paginated file list from /files endpoint', async () => {
      mockRequest({
        files: [{ fileId: '1Jc000001', fileName: 'doc.pdf', filePath: 'path/doc.pdf', fileSize: 1024, status: 'INDEXED' }],
        totalSize: 1,
        currentPageUrl: '/einstein/data-libraries/1JD000001/files?pageSize=50&offset=0',
      });

      const result = await AgentDataLibrary.listFiles(connection, '1JD000001');

      expect(result.files).to.have.lengthOf(1);
      expect(result.files[0].fileName).to.equal('doc.pdf');
      expect(result.totalSize).to.equal(1);
      expect(requests[0].url).to.include('/files');
    });

    it('should return empty files array when no files', async () => {
      mockRequest({ files: [], totalSize: 0 });

      const result = await AgentDataLibrary.listFiles(connection, '1JD000001');

      expect(result.files).to.have.lengthOf(0);
      expect(result.totalSize).to.equal(0);
    });

    it('should pass pagination options as query params', async () => {
      mockRequest({ files: [], totalSize: 0 });

      await AgentDataLibrary.listFiles(connection, '1JD000001', { pageSize: 10, status: 'INDEXED' });

      expect(requests[0].url).to.include('pageSize=10');
      expect(requests[0].url).to.include('status=INDEXED');
    });
  });

  describe('deleteFile', () => {
    it('should send DELETE to files endpoint', async () => {
      mockRequest({});

      await AgentDataLibrary.deleteFile(connection, '1JD000001', '1Jc000001');

      expect(requests[0].method).to.equal('DELETE');
      expect(requests[0].url).to.include('/files/1Jc000001');
    });
  });

  describe('upload', () => {
    let fetchStub: sinon.SinonStub;
    const testFilePath = join(tmpdir(), 'adl-upload-test.txt');

    beforeEach(async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(testFilePath, 'test content for upload');
      fetchStub = $$.SANDBOX.stub(global, 'fetch');
      fetchStub.resolves(new Response(null, { status: 200 }));
    });

    it('should perform full upload flow (readiness → urls → s3 → indexing)', async () => {
      let callCount = 0;
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        callCount++;
        if (req.url?.includes('/upload-readiness')) {
          return Promise.resolve({ ready: true });
        }
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [{ uploadUrl: 'https://s3.example.com/upload', filePath: '$adl$/1JD000001/test.txt', headers: { 'Content-Type': 'text/plain' } }],
          });
        }
        if (req.url?.includes('/indexing')) {
          return Promise.resolve({ status: 'IN_PROGRESS', filesAccepted: 1 });
        }
        return Promise.resolve({});
      };

      const result = await AgentDataLibrary.upload(connection, '1JD000001', testFilePath);

      expect(result.status).to.equal('IN_PROGRESS');
      expect(result.libraryId).to.equal('1JD000001');
      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal('https://s3.example.com/upload');
      expect(fetchStub.firstCall.args[1].method).to.equal('PUT');
      expect(fetchStub.firstCall.args[1].headers).to.deep.equal({ 'Content-Type': 'text/plain' });

      const readinessReq = requests.find((r) => r.url?.includes('/upload-readiness'));
      const urlsReq = requests.find((r) => r.url?.includes('/file-upload-urls'));
      const indexingReq = requests.find((r) => r.url?.includes('/indexing'));
      expect(readinessReq).to.exist;
      expect(urlsReq).to.exist;
      expect(indexingReq).to.exist;

      const indexBody = JSON.parse(indexingReq!.body!);
      expect(indexBody.uploadedFiles[0].filePath).to.equal('$adl$/1JD000001/test.txt');
      expect(indexBody.uploadedFiles[0].fileSize).to.be.a('number');
    });

    it('should poll and return READY when --wait and retrieverId appears', async () => {
      let pollCount = 0;
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/upload-readiness')) {
          return Promise.resolve({ ready: true });
        }
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [{ uploadUrl: 'https://s3.example.com/upload', filePath: '$adl$/1JD000001/test.txt', headers: {} }],
          });
        }
        if (req.url?.includes('/indexing')) {
          return Promise.resolve({ status: 'IN_PROGRESS' });
        }
        // GET detail (polling)
        pollCount++;
        if (pollCount >= 2) {
          return Promise.resolve({ libraryId: '1JD000001', retrieverId: '1Cx000001', status: 'READY' });
        }
        return Promise.resolve({ libraryId: '1JD000001', status: 'IN_PROGRESS' });
      };

      const result = await AgentDataLibrary.upload(connection, '1JD000001', testFilePath, { waitMinutes: 1 });

      expect(result.status).to.equal('READY');
      expect(result.retrieverId).to.equal('1Cx000001');
      expect(result.ragFeatureConfigId).to.equal('ARFPC_1JD000001');
    });

    it('should retry upload-readiness up to 3 times', async () => {
      let readinessAttempts = 0;
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/upload-readiness')) {
          readinessAttempts++;
          if (readinessAttempts < 3) {
            return Promise.resolve({ ready: false });
          }
          return Promise.resolve({ ready: true });
        }
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [{ uploadUrl: 'https://s3.example.com/upload', filePath: '$adl$/1JD000001/test.txt', headers: {} }],
          });
        }
        if (req.url?.includes('/indexing')) {
          return Promise.resolve({ status: 'IN_PROGRESS' });
        }
        return Promise.resolve({});
      };

      const result = await AgentDataLibrary.upload(connection, '1JD000001', testFilePath);

      expect(readinessAttempts).to.equal(3);
      expect(result.status).to.equal('IN_PROGRESS');
    });

    it('should throw UploadNotReady after 3 failed readiness attempts', async () => {
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/upload-readiness')) {
          return Promise.resolve({ ready: false });
        }
        return Promise.resolve({});
      };

      try {
        await AgentDataLibrary.upload(connection, '1JD000001', testFilePath);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.name).to.equal('UploadNotReady');
      }
    });

    it('should upload multiple files in batch', async () => {
      const { writeFileSync } = await import('node:fs');
      const file2 = join(tmpdir(), 'adl-upload-test2.txt');
      writeFileSync(file2, 'second file');

      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/upload-readiness')) {
          return Promise.resolve({ ready: true });
        }
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [
              { uploadUrl: 'https://s3.example.com/upload1', filePath: '$adl$/1JD000001/test1.txt', headers: {} },
              { uploadUrl: 'https://s3.example.com/upload2', filePath: '$adl$/1JD000001/test2.txt', headers: {} },
            ],
          });
        }
        if (req.url?.includes('/indexing')) {
          return Promise.resolve({ status: 'IN_PROGRESS', filesAccepted: 2 });
        }
        return Promise.resolve({});
      };

      const result = await AgentDataLibrary.upload(connection, '1JD000001', [testFilePath, file2]);

      expect(result.status).to.equal('IN_PROGRESS');
      expect(fetchStub.calledTwice).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal('https://s3.example.com/upload1');
      expect(fetchStub.secondCall.args[0]).to.equal('https://s3.example.com/upload2');

      const urlsReq = requests.find((r) => r.url?.includes('/file-upload-urls'));
      const urlsBody = JSON.parse(urlsReq!.body!);
      expect(urlsBody.files).to.have.lengthOf(2);

      const indexingReq = requests.find((r) => r.url?.includes('/indexing'));
      const indexBody = JSON.parse(indexingReq!.body!);
      expect(indexBody.uploadedFiles).to.have.lengthOf(2);
    });

    it('should throw on S3 upload failure', async () => {
      fetchStub.resolves(new Response('Forbidden', { status: 403 }));
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/upload-readiness')) {
          return Promise.resolve({ ready: true });
        }
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [{ uploadUrl: 'https://s3.example.com/upload', filePath: '$adl$/1JD000001/test.txt', headers: {} }],
          });
        }
        return Promise.resolve({});
      };

      try {
        await AgentDataLibrary.upload(connection, '1JD000001', testFilePath);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.name).to.equal('S3UploadFailed');
        expect(err.message).to.include('403');
      }
    });
  });

  describe('addFile', () => {
    let fetchStub: sinon.SinonStub;
    const testFilePath = join(tmpdir(), 'adl-add-test.txt');

    beforeEach(async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(testFilePath, 'test content for add');
      fetchStub = $$.SANDBOX.stub(global, 'fetch');
      fetchStub.resolves(new Response(null, { status: 200 }));
    });

    it('should perform add file flow (urls → s3 → /files)', async () => {
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [{ uploadUrl: 'https://s3.example.com/add', filePath: '$adl$/1JD000001/new.txt', headers: { 'Content-Type': 'text/plain' } }],
          });
        }
        if (req.url?.includes('/files')) {
          return Promise.resolve({ filesAccepted: 1 });
        }
        return Promise.resolve({});
      };

      const result = await AgentDataLibrary.addFile(connection, '1JD000001', testFilePath);

      expect(result.success).to.be.true;
      expect(result.fileName).to.equal('adl-add-test.txt');
      expect(result.libraryId).to.equal('1JD000001');

      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal('https://s3.example.com/add');

      const filesReq = requests.find((r) => r.url?.includes('/files') && r.method === 'POST');
      expect(filesReq).to.exist;
      const filesBody = JSON.parse(filesReq!.body!);
      expect(filesBody.uploadedFiles[0].filePath).to.equal('$adl$/1JD000001/new.txt');
    });

    it('should add multiple files in batch', async () => {
      const { writeFileSync } = await import('node:fs');
      const file2 = join(tmpdir(), 'adl-add-test2.txt');
      writeFileSync(file2, 'second add file');

      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [
              { uploadUrl: 'https://s3.example.com/add1', filePath: '$adl$/1JD000001/file1.txt', headers: {} },
              { uploadUrl: 'https://s3.example.com/add2', filePath: '$adl$/1JD000001/file2.txt', headers: {} },
            ],
          });
        }
        if (req.url?.includes('/files')) {
          return Promise.resolve({ filesAccepted: 2 });
        }
        return Promise.resolve({});
      };

      const result = await AgentDataLibrary.addFile(connection, '1JD000001', [testFilePath, file2]);

      expect(result.success).to.be.true;
      expect(fetchStub.calledTwice).to.be.true;

      const filesReq = requests.find((r) => r.url?.includes('/files') && r.method === 'POST');
      const filesBody = JSON.parse(filesReq!.body!);
      expect(filesBody.uploadedFiles).to.have.lengthOf(2);
    });

    it('should throw on S3 failure during add', async () => {
      fetchStub.resolves(new Response('Access Denied', { status: 403 }));
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if (req.url?.includes('/file-upload-urls')) {
          return Promise.resolve({
            uploadUrls: [{ uploadUrl: 'https://s3.example.com/add', filePath: '$adl$/1JD000001/new.txt', headers: {} }],
          });
        }
        return Promise.resolve({});
      };

      try {
        await AgentDataLibrary.addFile(connection, '1JD000001', testFilePath);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.name).to.equal('S3UploadFailed');
      }
    });
  });
});
