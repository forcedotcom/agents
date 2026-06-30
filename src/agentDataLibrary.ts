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
import {
  type DataLibrarySummary,
  type DataLibraryDetail,
  type IndexingStatusResponse,
  type CreateLibraryInput,
  type UpdateLibraryInput,
  type UploadResult,
  type FileAddResult,
  type FileListResponse,
} from './dataLibraryTypes.js';

export { type DataLibrarySummary, type DataLibraryDetail, type IndexingStatusResponse, type CreateLibraryInput, type UpdateLibraryInput, type UploadResult, type FileAddResult, type FileListResponse } from './dataLibraryTypes.js';

type UploadReadinessResponse = { ready: boolean };
type FileUploadUrlEntry = { uploadUrl: string; filePath: string; headers: Record<string, string> };
type FileUploadUrlsResponse = { uploadUrls: FileUploadUrlEntry[] };
type IndexingResponse = { status: string; filesAccepted?: number };

function baseUrl(connection: Connection, libraryId?: string): string {
  const base = `/services/data/v${String(connection.version)}/einstein/data-libraries`;
  return libraryId ? `${base}/${libraryId}` : base;
}

export class AgentDataLibrary {
  public static async list(
    connection: Connection,
    options?: { sourceType?: string }
  ): Promise<{ libraries: DataLibrarySummary[] }> {
    try {
      let url = baseUrl(connection);
      if (options?.sourceType) {
        url += `?sourceType=${options.sourceType.toUpperCase()}`;
      }
      return await connection.request<{ libraries: DataLibrarySummary[] }>({
        method: 'GET',
        url,
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_list_failed' });
      throw wrapped;
    }
  }

  public static async create(connection: Connection, input: CreateLibraryInput): Promise<DataLibraryDetail> {
    let result: DataLibraryDetail;
    try {
      result = await connection.request<DataLibraryDetail>({
        method: 'POST',
        url: baseUrl(connection),
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_create_failed' });
      throw wrapped;
    }

    await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_create_success' });

    if (input.groundingSource.sourceType === 'KNOWLEDGE') {
      // Trigger indexing — abort after 10s to avoid blocking process exit.
      // Server starts processing on receipt; we don't need the response.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        await fetch(`${String(connection.instanceUrl)}${baseUrl(connection, result.libraryId)}/indexing`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${String(connection.accessToken)}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
      } catch {
        // best-effort — server processes indexing even if aborted/timeout
      } finally {
        clearTimeout(timeout);
      }
    }

    return result;
  }

  public static async get(connection: Connection, libraryId: string): Promise<DataLibraryDetail> {
    try {
      return await connection.request<DataLibraryDetail>({
        method: 'GET',
        url: baseUrl(connection, libraryId),
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_get_failed' });
      throw wrapped;
    }
  }

  public static async update(connection: Connection, libraryId: string, input: UpdateLibraryInput): Promise<DataLibraryDetail> {
    try {
      return await connection.request<DataLibraryDetail>({
        method: 'PATCH',
        url: baseUrl(connection, libraryId),
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_update_failed' });
      throw wrapped;
    }
  }

  public static async delete(connection: Connection, libraryId: string): Promise<void> {
    try {
      await connection.request({
        method: 'DELETE',
        url: baseUrl(connection, libraryId),
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_delete_failed' });
      throw wrapped;
    }
  }

  public static async status(
    connection: Connection,
    libraryId: string,
    options?: { includeArtifacts?: boolean }
  ): Promise<IndexingStatusResponse> {
    try {
      let url = `${baseUrl(connection, libraryId)}/status`;
      if (options?.includeArtifacts) {
        url += '?includeArtifacts=true';
      }
      return await connection.request<IndexingStatusResponse>({
        method: 'GET',
        url,
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_status_failed' });
      throw wrapped;
    }
  }

  public static async listFiles(
    connection: Connection,
    libraryId: string,
    options?: {
      pageSize?: number;
      offset?: number;
      sortBy?: string;
      sortOrder?: string;
      name?: string;
      status?: string;
    }
  ): Promise<FileListResponse> {
    try {
      let url = `${baseUrl(connection, libraryId)}/files`;
      const params = new URLSearchParams();
      if (options?.pageSize !== undefined) params.append('pageSize', String(options.pageSize));
      if (options?.offset !== undefined) params.append('offset', String(options.offset));
      if (options?.sortBy) params.append('sortBy', options.sortBy);
      if (options?.sortOrder) params.append('sortOrder', options.sortOrder);
      if (options?.name) params.append('name', options.name);
      if (options?.status) params.append('status', options.status);

      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }

      return await connection.request<FileListResponse>({
        method: 'GET',
        url,
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_list_files_failed' });
      throw wrapped;
    }
  }

  public static async deleteFile(connection: Connection, libraryId: string, fileId: string): Promise<void> {
    try {
      await connection.request({
        method: 'DELETE',
        url: `${baseUrl(connection, libraryId)}/files/${fileId}`,
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_file_delete_failed' });
      throw wrapped;
    }
  }

  public static async upload(
    connection: Connection,
    libraryId: string,
    filePaths: string | string[],
    options?: { waitMinutes?: number }
  ): Promise<UploadResult> {
    const url = baseUrl(connection, libraryId);
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

    if (paths.length === 0) {
      throw new SfError('At least one file is required.', 'NoFilesProvided');
    }

    await AgentDataLibrary.checkUploadReadiness(connection, url);

    const fileNames = paths.map((p) => ({ fileName: basename(p) }));
    const uploadEntries = await AgentDataLibrary.getUploadUrls(connection, url, fileNames);

    await Promise.all(
      paths.map((path, i) => AgentDataLibrary.uploadToS3(uploadEntries[i], path))
    );

    const uploadedFiles = uploadEntries.map((entry, i) => ({
      filePath: entry.filePath,
      fileSize: statSync(paths[i]).size,
    }));
    await AgentDataLibrary.triggerIndexing(connection, url, uploadedFiles);

    if (options?.waitMinutes) {
      const detail = await AgentDataLibrary.pollForReadiness(connection, url, libraryId, options.waitMinutes * 60);
      return {
        libraryId,
        retrieverId: detail.retrieverId,
        ragFeatureConfigId: `ARFPC_${libraryId}`,
        status: 'READY',
      };
    }

    return { libraryId, status: 'IN_PROGRESS' };
  }

  public static async addFile(
    connection: Connection,
    libraryId: string,
    filePaths: string | string[]
  ): Promise<FileAddResult> {
    const url = baseUrl(connection, libraryId);
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

    if (paths.length === 0) {
      throw new SfError('At least one file is required.', 'NoFilesProvided');
    }

    const fileInfos = paths.map((p) => ({ fileName: basename(p) }));
    const uploadEntries = await AgentDataLibrary.getUploadUrls(connection, url, fileInfos);

    await Promise.all(
      paths.map((path, i) => AgentDataLibrary.uploadToS3(uploadEntries[i], path))
    );

    const uploadedFiles = uploadEntries.map((entry, i) => ({
      filePath: entry.filePath,
      fileSize: statSync(paths[i]).size,
    }));
    await connection.request({
      method: 'POST',
      url: `${url}/files`,
      body: JSON.stringify({ uploadedFiles }),
      headers: { 'Content-Type': 'application/json' },
    });

    await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_file_add_success' });
    const fileNames = paths.map((p) => basename(p));
    const fileName = fileNames.join(', ');
    return { success: true, fileName, fileNames, libraryId };
  }

  // ── Private helpers ───────────────────────────────────────

  private static async checkUploadReadiness(connection: Connection, url: string): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let readiness: UploadReadinessResponse;
      try {
        // eslint-disable-next-line no-await-in-loop
        readiness = await connection.request<UploadReadinessResponse>({
          method: 'GET',
          url: `${url}/upload-readiness?waitMaxTime=120000`,
        });
      } catch (error) {
        throw SfError.wrap(error);
      }

      if (readiness.ready) return;

      if (attempt === maxAttempts) {
        throw new SfError('Library not ready for upload after waiting.', 'UploadNotReady');
      }
    }
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

  private static async uploadToS3(uploadEntry: FileUploadUrlEntry, filePath: string): Promise<void> {
    const maxFileSize = 100 * 1024 * 1024; // 100 MB — SearchIndex limit for chunking/vectorization
    const fileSize = statSync(filePath).size;
    if (fileSize > maxFileSize) {
      throw new SfError(`File size (${fileSize} bytes) exceeds maximum of ${maxFileSize} bytes.`, 'FileTooLarge');
    }
    const fileBuffer = readFileSync(filePath);
    const response = await fetch(uploadEntry.uploadUrl, {
      method: 'PUT',
      headers: uploadEntry.headers,
      body: fileBuffer,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new SfError(`S3 upload failed: HTTP ${response.status}: ${body}`, 'S3UploadFailed');
    }
  }

  private static async triggerIndexing(
    connection: Connection,
    url: string,
    uploadedFiles: Array<{ filePath: string; fileSize: number }>
  ): Promise<IndexingResponse> {
    return connection.request<IndexingResponse>({
      method: 'POST',
      url: `${url}/indexing`,
      body: JSON.stringify({ uploadedFiles }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  public static async waitForReady(connection: Connection, libraryId: string, waitSeconds: number): Promise<DataLibraryDetail> {
    return AgentDataLibrary.pollForReadiness(connection, baseUrl(connection, libraryId), libraryId, waitSeconds);
  }

  private static async pollForReadiness(
    connection: Connection,
    url: string,
    libraryId: string,
    waitSeconds: number
  ): Promise<DataLibraryDetail> {
    const deadline = Date.now() + waitSeconds * 1_000;
    const pollInterval = 10_000;

    // eslint-disable-next-line no-await-in-loop
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const detail = await connection.request<DataLibraryDetail>({ method: 'GET', url });

      if (detail.retrieverId) return detail;
      if (detail.status === 'FAILED') {
        throw new SfError('Library indexing failed.', 'IndexingFailed');
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new SfError(`Indexing did not complete within ${waitSeconds} seconds.`, 'UploadTimeout');
  }
}
