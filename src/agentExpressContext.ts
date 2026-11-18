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

import { Connection, Lifecycle, SfError } from '@salesforce/core';
import { getHttpStatusCode } from './utils';
import { CtxLogger } from './ctxLogger';
import { prepareUploadFiles, requestUploadUrls, uploadAllToStorage } from './presignedUpload';
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

function baseUrl(connection: Connection, libraryId?: string): string {
  const base = `/services/data/v${String(connection.version)}/einstein/aec-libraries`;
  return libraryId ? `${base}/${encodeURIComponent(libraryId)}` : base;
}

/**
 * Client for the Agentforce Express Context (AEC) Connect API.
 *
 * Mirrors {@link AgentDataLibrary} (and shares its presigned-upload helpers) but targets `/einstein/aec-libraries`. AEC bypasses the
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

  /**
   * Delete an AEC library and its indexed files.
   *
   * The service does NOT delete the library's global retriever action (`GenAiFunctionDefinition`,
   * `ExpressContextLibrarySummary.retrieverAction`). Callers that created or wired that action must
   * remove it themselves, or it is left behind pointing at a library that no longer exists.
   */
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
        url: `${baseUrl(connection, libraryId)}/files/${encodeURIComponent(fileId)}`,
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_file_delete_failed', error, { libraryId, fileId });
    }
  }

  /**
   * Upload one or more files into an AEC library.
   *
   * Three steps, all verified live on v68: request presigned URLs → PUT the bytes to storage →
   * POST `{id}/indexing` to register the files and start indexing. All files are validated (unique
   * names, size limit) before any network call. If any storage PUT fails, nothing is registered and
   * the thrown `StorageUploadFailed` error's `data` lists which files landed in storage and which
   * failed. Indexing completes asynchronously; poll {@link AgentExpressContext.status} for progress.
   *
   * `filePaths` are read from the local file system as given; pass only paths the caller trusts.
   */
  public static async upload(
    connection: Connection,
    libraryId: string,
    filePaths: string | string[]
  ): Promise<ExpressContextUploadResult> {
    const url = baseUrl(connection, libraryId);
    const files = prepareUploadFiles(Array.isArray(filePaths) ? filePaths : [filePaths]);
    const fields = { libraryId, fileCount: files.length };

    let pairs: Awaited<ReturnType<typeof requestUploadUrls>>;
    try {
      pairs = await requestUploadUrls(connection, url, files);
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_upload_presign_failed', error, fields);
    }

    let uploaded: Awaited<ReturnType<typeof uploadAllToStorage>>;
    try {
      uploaded = await uploadAllToStorage(pairs, 'StorageUploadFailed');
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_upload_storage_failed', error, fields);
    }

    try {
      // AEC registers uploaded files and triggers indexing via the dedicated /indexing endpoint —
      // NOT POST /files (which returns INVALID_REQUEST_STATE).
      // Body shape is strict: { uploadedFiles: [{ filePath, fileSize }] }. Verified live v68.
      await connection.request({
        method: 'POST',
        url: `${url}/indexing`,
        body: JSON.stringify({ uploadedFiles: uploaded.map((f) => ({ filePath: f.filePath, fileSize: f.fileSize })) }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      throw AgentExpressContext.wrapAndReport('aec_upload_index_failed', error, fields);
    }

    await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_aec_upload_success' });
    return {
      libraryId,
      fileNames: uploaded.map((f) => f.fileName),
      filePaths: uploaded.map((f) => f.filePath),
      files: uploaded.map((f) => ({ localPath: f.localPath, fileName: f.fileName, filePath: f.filePath })),
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
}
