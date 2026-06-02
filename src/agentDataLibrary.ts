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
  type GroundingFileRef,
} from './dataLibraryTypes.js';

export { type DataLibrarySummary, type DataLibraryDetail, type IndexingStatusResponse, type CreateLibraryInput, type UpdateLibraryInput, type UploadResult, type FileAddResult, type GroundingFileRef } from './dataLibraryTypes.js';

type UploadReadinessResponse = { ready: boolean };
type FileUploadUrlEntry = { uploadUrl: string; filePath: string; headers: Record<string, string> };
type FileUploadUrlsResponse = { uploadUrls: FileUploadUrlEntry[] };
type IndexingResponse = { status: string; filesAccepted?: number };

function baseUrl(connection: Connection, libraryId?: string): string {
  const base = `/services/data/v${String(connection.version)}/einstein/data-libraries`;
  return libraryId ? `${base}/${libraryId}` : base;
}

export class AgentDataLibrary {
  public static async list(connection: Connection): Promise<{ libraries: DataLibrarySummary[] }> {
    try {
      return await connection.request<{ libraries: DataLibrarySummary[] }>({
        method: 'GET',
        url: baseUrl(connection),
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

  public static async status(connection: Connection, libraryId: string): Promise<IndexingStatusResponse> {
    try {
      return await connection.request<IndexingStatusResponse>({
        method: 'GET',
        url: `${baseUrl(connection, libraryId)}/status`,
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_status_failed' });
      throw wrapped;
    }
  }

  public static async listFiles(connection: Connection, libraryId: string): Promise<GroundingFileRef[]> {
    const detail = await AgentDataLibrary.get(connection, libraryId);
    return detail.groundingSource?.groundingFileRefs ?? [];
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
    filePath: string,
    options?: { waitMinutes?: number }
  ): Promise<UploadResult> {
    const url = baseUrl(connection, libraryId);
    const fileName = basename(filePath);

    await AgentDataLibrary.checkUploadReadiness(connection, url);

    const uploadEntry = await AgentDataLibrary.getUploadUrl(connection, url, fileName);

    await AgentDataLibrary.uploadToS3(uploadEntry, filePath);

    const fileSize = statSync(filePath).size;
    await AgentDataLibrary.triggerIndexing(connection, url, uploadEntry.filePath, fileSize);

    if (options?.waitMinutes) {
      const detail = await AgentDataLibrary.pollForReadiness(connection, url, libraryId, options.waitMinutes);
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
    filePath: string
  ): Promise<FileAddResult> {
    const url = baseUrl(connection, libraryId);
    const fileName = basename(filePath);

    const uploadEntry = await AgentDataLibrary.getUploadUrl(connection, url, fileName);
    await AgentDataLibrary.uploadToS3(uploadEntry, filePath);

    const fileSize = statSync(filePath).size;
    await connection.request({
      method: 'POST',
      url: `${url}/files`,
      body: JSON.stringify({ uploadedFiles: [{ filePath: uploadEntry.filePath, fileSize }] }),
      headers: { 'Content-Type': 'application/json' },
    });

    await Lifecycle.getInstance().emitTelemetry({ eventName: 'agent_adl_file_add_success' });
    return { success: true, fileName, libraryId };
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

  private static async getUploadUrl(connection: Connection, url: string, fileName: string): Promise<FileUploadUrlEntry> {
    const response = await connection.request<FileUploadUrlsResponse>({
      method: 'POST',
      url: `${url}/file-upload-urls`,
      body: JSON.stringify({ files: [{ fileName }] }),
      headers: { 'Content-Type': 'application/json' },
    });
    return response.uploadUrls[0];
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
    s3FilePath: string,
    fileSize: number
  ): Promise<IndexingResponse> {
    return connection.request<IndexingResponse>({
      method: 'POST',
      url: `${url}/indexing`,
      body: JSON.stringify({ uploadedFiles: [{ filePath: s3FilePath, fileSize }] }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private static async pollForReadiness(
    connection: Connection,
    url: string,
    libraryId: string,
    waitMinutes: number
  ): Promise<DataLibraryDetail> {
    const deadline = Date.now() + waitMinutes * 60_000;
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

    throw new SfError(`Indexing did not complete within ${waitMinutes} minutes.`, 'UploadTimeout');
  }
}
