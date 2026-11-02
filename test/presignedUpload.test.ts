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

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */

import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError } from '@salesforce/core';
import {
  MAX_UPLOAD_FILE_SIZE,
  UPLOAD_CONCURRENCY,
  assertSafeUploadUrl,
  prepareUploadFiles,
  requestUploadUrls,
  uploadAllToStorage,
  type LocalUploadFile,
  type PresignedUploadEntry,
} from '../src/presignedUpload';

describe('presignedUpload', () => {
  const $$ = new TestContext();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'presigned-upload-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeFile = (name: string, content = 'content'): string => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  const expectSfError = async (fn: () => unknown, name: string): Promise<SfError> => {
    try {
      await fn();
    } catch (err) {
      expect((err as SfError).name).to.equal(name);
      return err as SfError;
    }
    return expect.fail(`expected ${name} to be thrown`);
  };

  describe('prepareUploadFiles', () => {
    it('returns name and size for each file, in input order', () => {
      const a = writeFile('a.txt', 'aaa');
      const b = writeFile('b.txt', 'bbbbb');
      expect(prepareUploadFiles([a, b])).to.deep.equal([
        { localPath: a, fileName: 'a.txt', fileSize: 3 },
        { localPath: b, fileName: 'b.txt', fileSize: 5 },
      ]);
    });

    it('throws NoFilesProvided for an empty list', async () => {
      await expectSfError(() => prepareUploadFiles([]), 'NoFilesProvided');
    });

    it('throws DuplicateFileName when two paths share a basename', async () => {
      const a = writeFile('report.pdf');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'sub'));
      const b = join(dir, 'sub', 'report.pdf');
      writeFileSync(b, 'other');
      const err = await expectSfError(() => prepareUploadFiles([a, b]), 'DuplicateFileName');
      expect(err.message).to.include('report.pdf');
    });

    it('throws FileTooLarge before any network call when a file exceeds the limit', async () => {
      const small = writeFile('small.txt');
      const big = writeFile('big.bin', '');
      truncateSync(big, MAX_UPLOAD_FILE_SIZE + 1); // sparse file, no real disk use
      const err = await expectSfError(() => prepareUploadFiles([small, big]), 'FileTooLarge');
      expect(err.message).to.include('big.bin');
    });

    it('throws FileNotFound for a missing path', async () => {
      await expectSfError(() => prepareUploadFiles([join(dir, 'nope.txt')]), 'FileNotFound');
    });

    it('throws NotAFile for a directory', async () => {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'folder'));
      await expectSfError(() => prepareUploadFiles([writeFile('a.txt'), join(dir, 'folder')]), 'NotAFile');
    });
  });

  describe('assertSafeUploadUrl', () => {
    it('accepts an https URL to a named host', () => {
      expect(() => assertSafeUploadUrl('https://bucket.s3.us-west-2.amazonaws.com/key?sig=1')).to.not.throw();
    });

    for (const bad of [
      'http://s3.example.com/upload',
      'file:///etc/passwd',
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1:8200/v1',
      'https://[::1]/x',
      'https://localhost/x',
      'not a url',
    ]) {
      it(`rejects ${bad}`, async () => {
        await expectSfError(() => assertSafeUploadUrl(bad), 'InvalidUploadUrl');
      });
    }
  });

  describe('requestUploadUrls', () => {
    let connection: Connection;
    let files: LocalUploadFile[];

    beforeEach(async () => {
      const testOrg = new MockTestOrgData();
      await $$.stubAuths(testOrg);
      connection = await testOrg.getConnection();
      files = [
        { localPath: '/x/a.txt', fileName: 'a.txt', fileSize: 1 },
        { localPath: '/x/b.txt', fileName: 'b.txt', fileSize: 2 },
      ];
    });

    it('posts file names and pairs each returned entry with its file', async () => {
      let body: any;
      $$.fakeConnectionRequest = (req: any) => {
        body = JSON.parse(req.body as string);
        return Promise.resolve({
          uploadUrls: [
            { uploadUrl: 'https://s3.example.com/1', filePath: '$p$/a.txt', headers: {} },
            { uploadUrl: 'https://s3.example.com/2', filePath: '$p$/b.txt', headers: {} },
          ],
        });
      };
      const pairs = await requestUploadUrls(connection, '/lib', files);
      expect(body).to.deep.equal({ files: [{ fileName: 'a.txt' }, { fileName: 'b.txt' }] });
      expect(pairs.map((p) => [p.file.fileName, p.entry.filePath])).to.deep.equal([
        ['a.txt', '$p$/a.txt'],
        ['b.txt', '$p$/b.txt'],
      ]);
    });

    it('throws UploadUrlMismatch when the service returns fewer entries than files', async () => {
      $$.fakeConnectionRequest = () =>
        Promise.resolve({
          uploadUrls: [{ uploadUrl: 'https://s3.example.com/1', filePath: '$p$/a.txt', headers: {} }],
        });
      await expectSfError(() => requestUploadUrls(connection, '/lib', files), 'UploadUrlMismatch');
    });

    it('throws UploadUrlMismatch when uploadUrls is missing', async () => {
      $$.fakeConnectionRequest = () => Promise.resolve({});
      await expectSfError(() => requestUploadUrls(connection, '/lib', files), 'UploadUrlMismatch');
    });
  });

  describe('uploadAllToStorage', () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
      fetchStub = $$.SANDBOX.stub(global, 'fetch');
      fetchStub.resolves(new Response(null, { status: 200 }));
    });

    const pairsFor = (names: string[]): Array<{ file: LocalUploadFile; entry: PresignedUploadEntry }> =>
      names.map((n, i) => ({
        file: { localPath: writeFile(n, n), fileName: n, fileSize: n.length },
        entry: { uploadUrl: `https://s3.example.com/${i}`, filePath: `$p$/${n}`, headers: { 'x-amz-acl': 'private' } },
      }));

    it('PUTs each file to its URL with the returned headers and returns the pairing', async () => {
      const pairs = pairsFor(['a.txt', 'b.txt']);
      const result = await uploadAllToStorage(pairs, 'S3UploadFailed');

      expect(fetchStub.callCount).to.equal(2);
      const urls = fetchStub.getCalls().map((c) => c.args[0] as string);
      expect(urls).to.have.members(['https://s3.example.com/0', 'https://s3.example.com/1']);
      const call = fetchStub.getCalls().find((c) => c.args[0] === 'https://s3.example.com/0')!;
      expect(call.args[1].method).to.equal('PUT');
      expect(call.args[1].headers).to.deep.equal({ 'x-amz-acl': 'private' });
      expect(Buffer.from(call.args[1].body).toString()).to.equal('a.txt');
      expect(result.map((r) => [r.fileName, r.filePath, r.fileSize])).to.deep.equal([
        ['a.txt', '$p$/a.txt', 5],
        ['b.txt', '$p$/b.txt', 5],
      ]);
    });

    it(`keeps at most ${UPLOAD_CONCURRENCY} PUTs in flight`, async () => {
      let inFlight = 0;
      let peak = 0;
      fetchStub.callsFake(async (): Promise<Response> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response(null, { status: 200 });
      });
      await uploadAllToStorage(pairsFor(['1', '2', '3', '4', '5', '6', '7', '8']), 'S3UploadFailed');
      expect(fetchStub.callCount).to.equal(8);
      expect(peak).to.equal(UPLOAD_CONCURRENCY);
    });

    it('rejects an unsafe URL before PUTting any file', async () => {
      const pairs = pairsFor(['a.txt', 'b.txt']);
      pairs[1].entry.uploadUrl = 'http://169.254.169.254/latest';
      await expectSfError(() => uploadAllToStorage(pairs, 'S3UploadFailed'), 'InvalidUploadUrl');
      expect(fetchStub.called).to.be.false;
    });

    it('attempts every file and reports which landed when one PUT fails', async () => {
      fetchStub.callsFake((url: string) =>
        Promise.resolve(
          url.endsWith('/1')
            ? new Response('<Error>secret detail</Error>', { status: 403 })
            : new Response(null, { status: 200 })
        )
      );
      const err = await expectSfError(
        () => uploadAllToStorage(pairsFor(['a.txt', 'b.txt', 'c.txt']), 'StorageUploadFailed'),
        'StorageUploadFailed'
      );
      expect(fetchStub.callCount).to.equal(3);
      expect(err.message).to.include('1 of 3').and.include('b.txt (HTTP 403)');
      expect(err.message).to.not.include('secret detail');
      expect(err.data).to.deep.equal({
        uploadedFilePaths: ['$p$/a.txt', '$p$/c.txt'],
        failedFiles: [{ fileName: 'b.txt', errName: 'StoragePutFailed', statusCode: 403, storageErrorCode: null }],
      });
    });

    it('reports the S3 error code from the storage body, not the body itself', async () => {
      fetchStub.resolves(
        new Response('<Error><Code>SignatureDoesNotMatch</Code><Message>secret detail</Message></Error>', {
          status: 403,
        })
      );
      const err = await expectSfError(
        () => uploadAllToStorage(pairsFor(['a.txt']), 'S3UploadFailed'),
        'S3UploadFailed'
      );
      expect(err.message).to.include('a.txt (HTTP 403 SignatureDoesNotMatch)');
      expect(err.message).to.not.include('secret detail');
      expect((err.data as any).failedFiles[0].storageErrorCode).to.equal('SignatureDoesNotMatch');
    });

    it('reads only a bounded prefix of a large storage error body', async () => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller): void {
          pulled++;
          controller.enqueue(new Uint8Array(1024).fill(120)); // 'x' forever
        },
      });
      fetchStub.resolves(new Response(body, { status: 500 }));
      const err = await expectSfError(
        () => uploadAllToStorage(pairsFor(['a.txt']), 'S3UploadFailed'),
        'S3UploadFailed'
      );
      expect(err.message).to.include('a.txt (HTTP 500)');
      expect(pulled).to.be.lessThan(10);
    });

    it('reports a network error by error name', async () => {
      fetchStub.rejects(new TypeError('fetch failed'));
      const err = await expectSfError(
        () => uploadAllToStorage(pairsFor(['a.txt']), 'S3UploadFailed'),
        'S3UploadFailed'
      );
      expect(err.message).to.include('a.txt (TypeError)');
      expect((err.data as any).failedFiles[0].statusCode).to.equal(null);
    });
  });
});
