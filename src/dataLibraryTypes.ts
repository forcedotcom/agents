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

export type SourceType = 'SFDRIVE' | 'KNOWLEDGE' | 'RETRIEVER';

export type RetrieverDetail = {
  id: string;
  label: string;
  apiName?: string;
};

export type RetrieverActionDetail = {
  id: string;
  label: string;
  apiName?: string;
};

export type StageArtifact = {
  id: string;
  label: string;
  apiName?: string;
  assetType: string;
};

export type DataLibrarySummary = {
  libraryId: string;
  masterLabel: string;
  developerName: string;
  description?: string;
  sourceType: string;
  status: string;
  retriever?: RetrieverDetail;
  retrieverAction?: RetrieverActionDetail;
};

export type GroundingFileRef = {
  fileId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  createdDate?: string;
  createdBy?: string;
  status?: string;
};

export type DataLibraryDetail = {
  libraryId: string;
  masterLabel: string;
  developerName: string;
  description?: string;
  sourceType: string;
  status?: string;
  retrieverId?: string;
  retrieverLabel?: string;
  dataSpaceScopeId?: string;
  retriever?: RetrieverDetail;
  retrieverAction?: RetrieverActionDetail;
  totalFileCount?: number;
  groundingSource?: {
    [key: string]: unknown;
    groundingSourceType?: string;
    groundingFileRefs?: GroundingFileRef[];
  };
};

export type StageDetail = {
  name: string;
  status: string;
  completedAt?: number;
  startedAt?: number;
  error?: string;
  artifacts?: StageArtifact[];
  errorCode?: string;
};

export type IndexingStatusResponse = {
  indexingStatus: {
    libraryId: string;
    status: string;
    currentStage?: string;
    stageDetails?: StageDetail[];
    lastUpdatedAt?: number;
  };
};

export type GroundingSource = {
  sourceType: SourceType;
  indexMode?: string;
  retrieverId?: string;
  knowledgeConfig?: {
    primaryIndexField1?: string;
    primaryIndexField2?: string;
    contentFields?: string[];
    dataCategoryIds?: string[];
    dataCategoryNames?: string[];
    isRestrictToPublicArticle?: boolean;
  };
};

export type CreateLibraryInput = {
  masterLabel: string;
  developerName: string;
  description?: string;
  groundingSource: GroundingSource;
};

export type UpdateLibraryInput = {
  masterLabel?: string;
  description?: string;
  groundingSource?: {
    sourceType: string;
    knowledgeConfig?: {
      contentFields?: string[];
      isRestrictToPublicArticle?: boolean;
    };
    retrieverId?: string;
  };
};

export type UploadResult = {
  libraryId: string;
  retrieverId?: string;
  ragFeatureConfigId?: string;
  status: string;
};

export type FileAddResult = {
  success: boolean;
  fileName: string;
  fileNames: string[];
  libraryId: string;
};

export type FileListResponse = {
  files: GroundingFileRef[];
  totalSize: number;
  currentPageUrl?: string;
  nextPageUrl?: string;
};
