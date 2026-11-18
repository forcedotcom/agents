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

/**
 * Shared presigned-URL upload helpers used by {@link AgentDataLibrary} and {@link AgentExpressContext}.
 *
 * Both Connect APIs use the same three-step flow: POST `{library}/file-upload-urls` for presigned
 * storage URLs, PUT the bytes to each URL, then register the uploaded `filePath`s with the service.
 * This module owns the first two steps; the register step differs per API and stays with the caller.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { isIP } from 'node:net';
import { Connection, SfError } from '@salesforce/core';

/** 100 MB — SearchIndex limit for chunking/vectorization. */
export const MAX_UPLOAD_FILE_SIZE = 100 * 1024 * 1024;

/** Max storage PUTs in flight at once; each holds its whole file in memory. */
export const UPLOAD_CONCURRENCY = 3;

export type PresignedUploadEntry = { uploadUrl: string; filePath: string; headers: Record<string, string> };
type FileUploadUrlsResponse = { uploadUrls?: PresignedUploadEntry[] };

/** A local file that passed pre-upload validation. */
export type LocalUploadFile = { localPath: string; fileName: string; fileSize: number };

/** A local file paired with the presigned storage slot it was uploaded to. */
export type UploadedFile = LocalUploadFile & { filePath: string };

/**
 * Validate local files before any network call: at least one file, no two files sharing a basename
 * (the service keys uploads by file name, so they would collide), and every file within the size
 * limit. Stats each file once and returns the sizes for the register step.
 */
export function prepareUploadFiles(paths: string[]): LocalUploadFile[] {
  if (paths.length === 0) {
    throw new SfError('At least one file is required.', 'NoFilesProvided');
  }
  const seen = new Set<string>();
  return paths.map((localPath) => {
    const fileName = basename(localPath);
    if (seen.has(fileName)) {
      throw new SfError(
        `More than one file is named "${fileName}". File names must be unique within an upload.`,
        'DuplicateFileName'
      );
    }
    seen.add(fileName);
    const fileSize = statSync(localPath).size;
    if (fileSize > MAX_UPLOAD_FILE_SIZE) {
      throw new SfError(
        `File "${fileName}" (${fileSize} bytes) exceeds maximum of ${MAX_UPLOAD_FILE_SIZE} bytes.`,
        'FileTooLarge'
      );
    }
    return { localPath, fileName, fileSize };
  });
}

/**
 * Request one presigned storage URL per file and pair each URL with its local file. The service
 * returns the entries in request order; an entry count that doesn't match is rejected rather than
 * silently pairing bytes with the wrong slot.
 */
export async function requestUploadUrls(
  connection: Connection,
  libraryUrl: string,
  files: LocalUploadFile[]
): Promise<Array<{ file: LocalUploadFile; entry: PresignedUploadEntry }>> {
  const response = await connection.request<FileUploadUrlsResponse>({
    method: 'POST',
    url: `${libraryUrl}/file-upload-urls`,
    body: JSON.stringify({ files: files.map((f) => ({ fileName: f.fileName })) }),
    headers: { 'Content-Type': 'application/json' },
  });
  const entries = response.uploadUrls ?? [];
  if (entries.length !== files.length) {
    throw new SfError(
      `Requested ${files.length} upload URL(s) but the service returned ${entries.length}.`,
      'UploadUrlMismatch'
    );
  }
  return files.map((file, i) => ({ file, entry: entries[i] }));
}

/**
 * Reject a server-supplied upload URL that isn't a plain HTTPS URL to a named host, so a tampered
 * Connect API response can't point the PUT (and the local file bytes) at an internal or plaintext
 * endpoint.
 */
export function assertSafeUploadUrl(uploadUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    throw new SfError('The service returned an invalid upload URL.', 'InvalidUploadUrl');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'https:' || isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) {
    throw new SfError(
      `The service returned an upload URL that isn't an HTTPS URL to a named host (${parsed.protocol}//${host}).`,
      'InvalidUploadUrl'
    );
  }
}

/** Error thrown when one or more storage PUTs fail. `data` reports what landed and what didn't. */
export type StorageUploadFailureData = {
  /** Storage `filePath`s that were PUT successfully but not registered with the service. */
  uploadedFilePaths: string[];
  failedFiles: Array<{ fileName: string; errName: string; statusCode: number | null }>;
};

/**
 * PUT every file to its presigned URL with at most {@link UPLOAD_CONCURRENCY} in flight. Every file
 * is attempted even if another fails, so the caller learns exactly which files landed.
 *
 * @param errorName - `SfError` name to throw on failure, so each client keeps its own error code.
 */
export async function uploadAllToStorage(
  pairs: Array<{ file: LocalUploadFile; entry: PresignedUploadEntry }>,
  errorName: string
): Promise<UploadedFile[]> {
  // Validate every URL before PUTting anything, so a bad response uploads nothing.
  pairs.forEach(({ entry }) => assertSafeUploadUrl(entry.uploadUrl));

  const results: Array<{ ok: true } | { ok: false; error: SfError; statusCode: number | null }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pairs.length) {
      const i = next++;
      try {
        // eslint-disable-next-line no-await-in-loop
        await putFile(pairs[i].entry, pairs[i].file);
        results[i] = { ok: true };
      } catch (error) {
        const wrapped = SfError.wrap(error);
        results[i] = { ok: false, error: wrapped, statusCode: (wrapped.data as { statusCode?: number } | undefined)?.statusCode ?? null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pairs.length) }, worker));

  const failedFiles: StorageUploadFailureData['failedFiles'] = [];
  const uploadedFilePaths: string[] = [];
  results.forEach((r, i) => {
    if (r.ok) {
      uploadedFilePaths.push(pairs[i].entry.filePath);
    } else {
      failedFiles.push({ fileName: pairs[i].file.fileName, errName: r.error.name, statusCode: r.statusCode });
    }
  });
  if (failedFiles.length > 0) {
    const detail = failedFiles
      .map((f) => (f.statusCode !== null ? `${f.fileName} (HTTP ${f.statusCode})` : `${f.fileName} (${f.errName})`))
      .join(', ');
    const data: StorageUploadFailureData = { uploadedFilePaths, failedFiles };
    throw SfError.create<StorageUploadFailureData>({
      message: `File storage upload failed for ${failedFiles.length} of ${pairs.length} file(s): ${detail}. No files were registered.`,
      name: errorName,
      data,
    });
  }
  return pairs.map(({ file, entry }) => ({ ...file, filePath: entry.filePath }));
}

async function putFile(entry: PresignedUploadEntry, file: LocalUploadFile): Promise<void> {
  const response = await fetch(entry.uploadUrl, {
    method: 'PUT',
    headers: entry.headers,
    body: readFileSync(file.localPath),
  });
  if (!response.ok) {
    // The storage response body is remote content of unbounded size; report only the status.
    throw SfError.create({
      message: `HTTP ${response.status}`,
      name: 'StoragePutFailed',
      data: { statusCode: response.status },
    });
  }
}
