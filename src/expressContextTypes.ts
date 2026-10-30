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
 * Types for the Agentforce Express Context (AEC) Connect API.
 *
 * AEC is a realtime BM25 index/retrieval service that bypasses the Data Cloud
 * DLO/DMO/SearchIndex pipeline used by Agentforce Data Libraries (ADL). Because of
 * that, AEC libraries are lighter-weight than ADL libraries: there is no data-space
 * scope, no downstream DMO/SearchIndex assets, and indexing is (near-)realtime rather
 * than a multi-stage provisioning pipeline.
 *
 * Connect API base: /services/data/v{version}/einstein/aec-libraries
 */

export type ExpressContextRetrieverDetail = {
  id: string;
  label: string;
  apiName?: string;
};

/**
 * A single AEC library as returned by GET /aec-libraries.
 *
 * NOTE: `developerName` includes the 8-char hash suffix the platform appends on
 * creation (e.g. `General_FAQ_Express_6def866f`). Path-style lookups by the plain,
 * un-suffixed name 404; use the full developerName or the 18-char Id (key prefix 1JD).
 */
export type ExpressContextLibrarySummary = {
  libraryId: string;
  masterLabel: string;
  developerName: string;
  description?: string;
  status: string;
  retriever?: ExpressContextRetrieverDetail;
  retrieverAction?: ExpressContextRetrieverDetail;
  createdDate?: string;
};

/**
 * Metadata for a file indexed into an AEC library, from GET /aec-libraries/{id}/files.
 *
 * The AEC Connect API returns file METADATA only — there is no presigned download
 * endpoint. `filePath` is the logical SFDrive path (e.g. `$agentforce_express_context$/...`),
 * not a fetchable URL.
 */
export type ExpressContextFileRef = {
  fileId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  status?: string;
  createdDate?: string;
  createdBy?: string;
};

export type ExpressContextFileListResponse = {
  files: ExpressContextFileRef[];
  totalSize?: number;
  currentPageUrl?: string;
  nextPageUrl?: string;
};

/**
 * Richer indexing status from GET /aec-libraries/{id}/status. Returns more than /files —
 * adds the retriever/retriever-action wiring and per-run indexing counts.
 */
export type ExpressContextStatusResponse = {
  libraryId: string;
  developerName?: string;
  masterLabel?: string;
  status: string;
  retriever?: ExpressContextRetrieverDetail;
  retrieverAction?: ExpressContextRetrieverDetail;
  /** Per-file indexing status (e.g. INDEXING, INDEXED). Verified live v68. */
  files?: ExpressContextFileRef[];
  filesTotal?: number;
  filesIndexed?: number;
  filesFailed?: number;
  lastIndexedAt?: string;
};

export type CreateExpressContextInput = {
  masterLabel: string;
  developerName: string;
  description?: string;
};

export type ExpressContextUploadResult = {
  libraryId: string;
  fileNames: string[];
  /** SFDrive paths of the uploaded files (`$agentforce_express_context$/<Lib>/<file>`), in input order. */
  filePaths: string[];
  status: string;
};
