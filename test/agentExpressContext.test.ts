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

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, Lifecycle, SfError } from '@salesforce/core';
import { AgentExpressContext } from '../src/agentExpressContext';

describe('AgentExpressContext', () => {
  const $$ = new TestContext();
  let connection: Connection;
  let requests: Array<{ method?: string; url?: string; body?: string }>;
  let telemetryStub: sinon.SinonStub;
  const base = (): string => `/services/data/v${connection.version}/einstein/aec-libraries`;

  beforeEach(async () => {
    const testOrg = new MockTestOrgData();
    await $$.stubAuths(testOrg);
    connection = await testOrg.getConnection();
    requests = [];
    telemetryStub = $$.SANDBOX.stub(Lifecycle.getInstance(), 'emitTelemetry').resolves();
  });

  const respond = (handler: (req: { url: string; body?: string }) => unknown): void => {
    $$.fakeConnectionRequest = (req: any) => {
      requests.push(req);
      return Promise.resolve(handler(req) as any);
    };
  };

  const fail = (status: number): void => {
    $$.fakeConnectionRequest = (req: any) => {
      requests.push(req);
      return Promise.reject(Object.assign(new Error('boom'), { errorCode: 'INVALID_REQUEST', statusCode: status }));
    };
  };

  const expectThrows = async (fn: () => Promise<unknown>): Promise<SfError> => {
    try {
      await fn();
    } catch (err) {
      return err as SfError;
    }
    return expect.fail('expected an error');
  };

  const failureEvents = (): string[] =>
    telemetryStub
      .getCalls()
      .map((c) => (c.args[0] as { eventName: string }).eventName)
      .filter((e) => e.endsWith('_failed'));

  describe('read operations', () => {
    it('list GETs the collection', async () => {
      respond(() => ({ libraries: [{ libraryId: '1JD1', masterLabel: 'L', developerName: 'L_abc', status: 'READY' }] }));
      const result = await AgentExpressContext.list(connection);
      expect(result.libraries).to.have.lengthOf(1);
      expect(requests[0]).to.include({ method: 'GET', url: base() });
    });

    it('get, status and listFiles target the library by id', async () => {
      respond(() => ({ libraryId: '1JD1', status: 'READY', files: [] }));
      await AgentExpressContext.get(connection, '1JD1');
      await AgentExpressContext.status(connection, '1JD1');
      await AgentExpressContext.listFiles(connection, '1JD1');
      expect(requests.map((r) => r.url)).to.deep.equal([
        `${base()}/1JD1`,
        `${base()}/1JD1/status`,
        `${base()}/1JD1/files`,
      ]);
    });

    it('listFiles passes paging and filter options as query params', async () => {
      respond(() => ({ files: [] }));
      await AgentExpressContext.listFiles(connection, '1JD1', { pageSize: 10, offset: 20, name: 'a b', status: 'INDEXED' });
      expect(requests[0].url).to.equal(`${base()}/1JD1/files?pageSize=10&offset=20&name=a+b&status=INDEXED`);
    });

    it('URL-encodes the library id and file id', async () => {
      respond(() => ({}));
      await AgentExpressContext.get(connection, 'My Lib/../x?y');
      await AgentExpressContext.deleteFile(connection, 'lib#1', 'file/2');
      expect(requests[0].url).to.equal(`${base()}/My%20Lib%2F..%2Fx%3Fy`);
      expect(requests[1].url).to.equal(`${base()}/lib%231/files/file%2F2`);
    });

    for (const [name, call, event] of [
      ['list', (c: Connection) => AgentExpressContext.list(c), 'aec_list_failed'],
      ['get', (c: Connection) => AgentExpressContext.get(c, '1JD1'), 'aec_get_failed'],
      ['status', (c: Connection) => AgentExpressContext.status(c, '1JD1'), 'aec_status_failed'],
      ['listFiles', (c: Connection) => AgentExpressContext.listFiles(c, '1JD1'), 'aec_list_files_failed'],
      ['delete', (c: Connection) => AgentExpressContext.delete(c, '1JD1'), 'aec_delete_failed'],
      ['deleteFile', (c: Connection) => AgentExpressContext.deleteFile(c, '1JD1', '1Fx1'), 'aec_file_delete_failed'],
    ] as const) {
      it(`${name} wraps API errors and emits ${event} with status and error name`, async () => {
        fail(404);
        const err = await expectThrows(() => call(connection));
        expect(err).to.be.instanceOf(SfError);
        const telemetry = telemetryStub.getCalls().find((c) => c.args[0].eventName === event);
        expect(telemetry?.args[0]).to.include({ statusCode: 404 });
        expect(telemetry?.args[0].errName).to.be.a('string');
      });
    }
  });

  describe('create', () => {
    it('POSTs the input as JSON and emits success telemetry', async () => {
      respond(() => ({ libraryId: '1JD1', masterLabel: 'L', developerName: 'L_abc', status: 'READY' }));
      const result = await AgentExpressContext.create(connection, { masterLabel: 'L', developerName: 'L', description: 'd' });
      expect(result.libraryId).to.equal('1JD1');
      expect(requests[0]).to.include({ method: 'POST', url: base() });
      expect(JSON.parse(requests[0].body!)).to.deep.equal({ masterLabel: 'L', developerName: 'L', description: 'd' });
      expect(telemetryStub.calledWithMatch({ eventName: 'agent_aec_create_success' })).to.be.true;
    });

    it('emits aec_create_failed and no success event on error', async () => {
      fail(400);
      await expectThrows(() => AgentExpressContext.create(connection, { masterLabel: 'L', developerName: 'L' }));
      expect(failureEvents()).to.deep.equal(['aec_create_failed']);
      expect(telemetryStub.calledWithMatch({ eventName: 'agent_aec_create_success' })).to.be.false;
    });
  });

  describe('delete', () => {
    it('sends DELETE for the library and for a file', async () => {
      respond(() => ({}));
      await AgentExpressContext.delete(connection, '1JD1');
      await AgentExpressContext.deleteFile(connection, '1JD1', '1Fx1');
      expect(requests.map((r) => [r.method, r.url])).to.deep.equal([
        ['DELETE', `${base()}/1JD1`],
        ['DELETE', `${base()}/1JD1/files/1Fx1`],
      ]);
    });
  });

  describe('upload', () => {
    let dir: string;
    let fetchStub: sinon.SinonStub;
    let fileA: string;
    let fileB: string;

    const urlsFor = (names: string[]): unknown => ({
      uploadUrls: names.map((n) => ({
        uploadUrl: `https://storage.example.com/${n}`,
        filePath: `$agentforce_express_context$/Lib/${n}`,
        headers: { 'Content-Type': 'text/plain' },
      })),
    });

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'aec-upload-'));
      fileA = join(dir, 'a.txt');
      fileB = join(dir, 'b.md');
      writeFileSync(fileA, 'aaa');
      writeFileSync(fileB, 'bbbbbb');
      fetchStub = $$.SANDBOX.stub(global, 'fetch');
      fetchStub.resolves(new Response(null, { status: 200 }));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('runs presign → PUT → /indexing and returns the local-to-SFDrive pairing', async () => {
      respond((req) => (req.url.endsWith('/file-upload-urls') ? urlsFor(['a.txt', 'b.md']) : {}));

      const result = await AgentExpressContext.upload(connection, '1JD1', [fileA, fileB]);

      expect(requests.map((r) => r.url)).to.deep.equal([`${base()}/1JD1/file-upload-urls`, `${base()}/1JD1/indexing`]);
      expect(JSON.parse(requests[0].body!)).to.deep.equal({ files: [{ fileName: 'a.txt' }, { fileName: 'b.md' }] });
      expect(JSON.parse(requests[1].body!)).to.deep.equal({
        uploadedFiles: [
          { filePath: '$agentforce_express_context$/Lib/a.txt', fileSize: 3 },
          { filePath: '$agentforce_express_context$/Lib/b.md', fileSize: 6 },
        ],
      });
      expect(fetchStub.callCount).to.equal(2);
      expect(result).to.deep.equal({
        libraryId: '1JD1',
        fileNames: ['a.txt', 'b.md'],
        filePaths: ['$agentforce_express_context$/Lib/a.txt', '$agentforce_express_context$/Lib/b.md'],
        files: [
          { localPath: fileA, fileName: 'a.txt', filePath: '$agentforce_express_context$/Lib/a.txt' },
          { localPath: fileB, fileName: 'b.md', filePath: '$agentforce_express_context$/Lib/b.md' },
        ],
      });
      expect(telemetryStub.calledWithMatch({ eventName: 'agent_aec_upload_success' })).to.be.true;
    });

    it('accepts a single path string', async () => {
      respond((req) => (req.url.endsWith('/file-upload-urls') ? urlsFor(['a.txt']) : {}));
      const result = await AgentExpressContext.upload(connection, '1JD1', fileA);
      expect(result.fileNames).to.deep.equal(['a.txt']);
    });

    it('rejects an empty file list without calling the API', async () => {
      respond(() => ({}));
      const err = await expectThrows(() => AgentExpressContext.upload(connection, '1JD1', []));
      expect(err.name).to.equal('NoFilesProvided');
      expect(requests).to.be.empty;
    });

    it('rejects duplicate basenames without calling the API', async () => {
      mkdirSync(join(dir, 'sub'));
      const dup = join(dir, 'sub', 'a.txt');
      writeFileSync(dup, 'other');
      respond(() => ({}));
      const err = await expectThrows(() => AgentExpressContext.upload(connection, '1JD1', [fileA, dup]));
      expect(err.name).to.equal('DuplicateFileName');
      expect(requests).to.be.empty;
    });

    it('reports presign failures as aec_upload_presign_failed', async () => {
      fail(500);
      await expectThrows(() => AgentExpressContext.upload(connection, '1JD1', fileA));
      expect(failureEvents()).to.deep.equal(['aec_upload_presign_failed']);
      expect(fetchStub.called).to.be.false;
    });

    it('reports a short presign response as aec_upload_presign_failed', async () => {
      respond(() => urlsFor(['a.txt']));
      const err = await expectThrows(() => AgentExpressContext.upload(connection, '1JD1', [fileA, fileB]));
      expect(err.name).to.equal('UploadUrlMismatch');
      expect(failureEvents()).to.deep.equal(['aec_upload_presign_failed']);
      expect(fetchStub.called).to.be.false;
    });

    it('does not register anything and reports landed files when a storage PUT fails', async () => {
      respond((req) => (req.url.endsWith('/file-upload-urls') ? urlsFor(['a.txt', 'b.md']) : {}));
      fetchStub.callsFake((url: string) =>
        Promise.resolve(new Response(null, { status: url.endsWith('/b.md') ? 403 : 200 }))
      );

      const err = await expectThrows(() => AgentExpressContext.upload(connection, '1JD1', [fileA, fileB]));

      expect(err.name).to.equal('StorageUploadFailed');
      expect((err.data as any).uploadedFilePaths).to.deep.equal(['$agentforce_express_context$/Lib/a.txt']);
      expect(requests.some((r) => r.url?.endsWith('/indexing'))).to.be.false;
      expect(failureEvents()).to.deep.equal(['aec_upload_storage_failed']);
    });

    it('rejects a non-https upload URL as aec_upload_storage_failed without PUTting', async () => {
      respond(() => ({ uploadUrls: [{ uploadUrl: 'http://10.0.0.1/x', filePath: '$p$/a.txt', headers: {} }] }));
      const err = await expectThrows(() => AgentExpressContext.upload(connection, '1JD1', fileA));
      expect(err.name).to.equal('InvalidUploadUrl');
      expect(fetchStub.called).to.be.false;
      expect(failureEvents()).to.deep.equal(['aec_upload_storage_failed']);
    });

    it('reports /indexing failures as aec_upload_index_failed', async () => {
      $$.fakeConnectionRequest = (req: any) => {
        requests.push(req);
        if ((req.url as string).endsWith('/file-upload-urls')) return Promise.resolve(urlsFor(['a.txt']) as any);
        return Promise.reject(Object.assign(new Error('bad state'), { statusCode: 409 }));
      };
      await expectThrows(() => AgentExpressContext.upload(connection, '1JD1', fileA));
      expect(failureEvents()).to.deep.equal(['aec_upload_index_failed']);
      expect(telemetryStub.calledWithMatch({ eventName: 'agent_aec_upload_success' })).to.be.false;
    });
  });
});
