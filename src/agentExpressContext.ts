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

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Connection, Lifecycle, SfError } from '@salesforce/core';
import { getHttpStatusCode } from './utils';
import { CtxLogger } from './ctxLogger';
import {
  type ExpressContextLibrarySummary,
  type ExpressContextFileListResponse,
  type ExpressContextStatusResponse,
  type CreateExpressContextInput,
  type ExpressContextUploadResult,
} from './expressContextTypes.js';

let logger: CtxLogger;
const getLogger = (): CtxLogger => {
  if (!logger) {
    logger = CtxLogger.child('AgentExpressContext');
  }
  return logger;
};

export {
  type ExpressContextLibrarySummary,
  type ExpressContextFileRef,
  type ExpressContextFileListResponse,
  type ExpressContextStatusResponse,
  type CreateExpressContextInput,
  type ExpressContextUploadResult,
} from './expressContextTypes.js';

type FileUploadUrlEntry = { uploadUrl: string; filePath: string; headers: Record<string, string> };
type FileUploadUrlsResponse = { uploadUrls: FileUploadUrlEntry[] };

function baseUrl(connection: Connection, libraryId?: string): string {
  const base = `/services/data/v${String(connection.version)}/einstein/aec-libraries`;
  return libraryId ? `${base}/${libraryId}` : base;
}

/**
 * Client for the Agentforce Express Context (AEC) Connect API.
 *
 * Mirrors {@link AgentDataLibrary} but targets `/einstein/aec-libraries`. AEC bypasses the
 * Data Cloud pipeline (realtime BM25 index), so it exposes a smaller surface: no upload
 * readiness gate, no multi-stage provisioning, no data-space scope.
 *
 * Endpoint confidence (verified live on an AEC-enabled org, API v68, 2026-09-29):
 * GET list / {id} / {id}/status, POST {id}/file-upload-urls, POST {id} create, and the
 * upload flow (file-upload-urls → PUT to S3 → POST {id}/indexing). NOTE: the file
 * register/index step is POST {id}/indexing, NOT POST {id}/files — the latter returns
 * INVALID_REQUEST_STATE. Min API version is v67.0; lower versions 404. Requires the org
 * perm EinsteinKnowledgeConfig and a CDPServiceTenant record. DELETE {id} verified 2026-10-07 — it does
 * NOT delete the library's global retriever action GenAiFunctionDefinition; callers must remove it.
 */
export class AgentExpressContext {
  public static async list(connection: Connection): Promise<{ libraries: ExpressContextLibrarySummary[] }> {
    try {
      return await connection.request<{ libraries: ExpressContextLibrarySummary[] }>({
        method: 'GET',
        url: baseUrl(connection),
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_list_failed', error, {});
    }
  }

  public static async get(
    connection: Connection,
    libraryId: string
  ): Promise<ExpressContextLibrarySummary> {
    try {
      return await connection.request<ExpressContextLibrarySummary>({
        method: 'GET',
        url: baseUrl(connection, libraryId),
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_get_failed', error, { libraryId });
    }
  }

  public static async status(
    connection: Connection,
    libraryId: string
  ): Promise<ExpressContextStatusResponse> {
    try {
      return await connection.request<ExpressContextStatusResponse>({
        method: 'GET',
        url: `${baseUrl(connection, libraryId)}/status`,
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_status_failed', error, { libraryId });
    }
  }

  public static async listFiles(
    connection: Connection,
    libraryId: string,
    options?: { pageSize?: number; offset?: number; name?: string; status?: string }
  ): Promise<ExpressContextFileListResponse> {
    try {
      let url = `${baseUrl(connection, libraryId)}/files`;
      const params = new URLSearchParams();
      if (options?.pageSize !== undefined) params.append('pageSize', String(options.pageSize));
      if (options?.offset !== undefined) params.append('offset', String(options.offset));
      if (options?.name) params.append('name', options.name);
      if (options?.status) params.append('status', options.status);
      const queryString = params.toString();
      if (queryString) url += `?${queryString}`;

      return await connection.request<ExpressContextFileListResponse>({ method: 'GET', url });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_list_files_failed', error, { libraryId });
    }
  }

  public static async create(
    connection: Connection,
    input: CreateExpressContextInput
  ): Promise<ExpressContextLibrarySummary> {
    let result: ExpressContextLibrarySummary;
    try {
      result = await connection.request<ExpressContextLibrarySummary>({
        method: 'POST',
        url: baseUrl(connection),
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_create_failed', error, {});
    }
    await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_aec_create_success' });
    return result;
  }

  public static async delete(connection: Connection, libraryId: string): Promise<void> {
    try {
      await connection.request({ method: 'DELETE', url: baseUrl(connection, libraryId) });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_delete_failed', error, { libraryId });
    }
  }

  public static async deleteFile(connection: Connection, libraryId: string, fileId: string): Promise<void> {
    try {
      await connection.request({
        method: 'DELETE',
        url: `${baseUrl(connection, libraryId)}/files/${fileId}`,
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_file_delete_failed', error, { libraryId, fileId });
    }
  }

  /**
   * Upload one or more files into an AEC library.
   *
   * AEC has no upload-readiness gate and indexes in (near-)realtime, so the flow is a
   * three-step: request presigned URLs → PUT the bytes → register the uploaded files so
   * the service starts indexing. This mirrors {@link AgentDataLibrary.addFile}; the register
   * step's contract is pending confirmation on a pre-GA AEC org.
   */
  public static async upload(
    connection: Connection,
    libraryId: string,
    filePaths: string | string[]
  ): Promise<ExpressContextUploadResult> {
    const url = baseUrl(connection, libraryId);
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    if (paths.length === 0) {
      throw new SfError('At least one file is required.', 'NoFilesProvided');
    }

    const files = paths.map((p) => ({ fileName: basename(p) }));
    const uploadEntries = await AgentExpressContext.getUploadUrls(connection, url, files);

    await Promise.all(paths.map((path, i) => AgentExpressContext.uploadToStorage(uploadEntries[i], path)));

    const uploadedFiles = uploadEntries.map((entry, i) => ({
      filePath: entry.filePath,
      fileSize: statSync(paths[i]).size,
    }));

    try {
      // AEC registers uploaded files and triggers (synchronous) indexing via the
      // dedicated /indexing endpoint — NOT POST /files (which returns INVALID_REQUEST_STATE).
      // Body shape is strict: { uploadedFiles: [{ filePath, fileSize }] }. Verified live v68.
      await connection.request({
        method: 'POST',
        url: `${url}/indexing`,
        body: JSON.stringify({ uploadedFiles }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_upload_index_failed', error, { libraryId });
    }

    await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_aec_upload_success' });
    return {
      libraryId,
      fileNames: paths.map((p) => basename(p)),
      filePaths: uploadEntries.map((entry) => entry.filePath),
      status: 'IN_PROGRESS',
    };
  }

  // ── Private helpers ───────────────────────────────────────

  /** Log a static breadcrumb, emit a sliceable failure counter, and return the wrapped error to throw. */
  private static wrapAndReport(eventName: string, error: unknown, fields: Record<string, unknown>): SfError {
    const wrapped = SfError.wrap(error);
    getLogger().debug('Express Context request failed', {
      ...fields,
      statusCode: getHttpStatusCode(error),
      errName: wrapped.name,
      errMsg: wrapped.message,
    });
    void Lifecycle.getInstance().emitTelemetry({
      eventName,
      statusCode: getHttpStatusCode(error) ?? null,
      errName: wrapped.name,
    });
    return wrapped;
  }

  private static async getUploadUrls(
    connection: Connection,
    url: string,
    files: Array<{ fileName: string }>
  ): Promise<FileUploadUrlEntry[]> {
    const response = await connection.request<FileUploadUrlsResponse>({
      method: 'POST',
      url: `${url}/file-upload-urls`,
      body: JSON.stringify({ files }),
      headers: { 'Content-Type': 'application/json' },
    });
    return response.uploadUrls;
  }

  private static async uploadToStorage(uploadEntry: FileUploadUrlEntry, filePath: string): Promise<void> {
    const maxFileSize = 100 * 1024 * 1024; // 100 MB
    const fileSize = statSync(filePath).size;
    if (fileSize > maxFileSize) {
      throw new SfError(`File size (${fileSize} bytes) exceeds maximum of ${maxFileSize} bytes.`, 'FileTooLarge');
    }
    const response = await fetch(uploadEntry.uploadUrl, {
      method: 'PUT',
      headers: uploadEntry.headers,
      body: readFileSync(filePath),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new SfError(`File storage upload failed: HTTP ${response.status}: ${body}`, 'StorageUploadFailed');
    }
  }
}
