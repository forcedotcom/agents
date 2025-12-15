/*
 * Copyright 2025, Salesforce, Inc.
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
import { readdirSync, statSync } from 'node:fs';
import { mkdir, appendFile, readFile, writeFile, cp } from 'node:fs/promises';
import * as path from 'node:path';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { NamedUserJwtResponse, type PlannerResponse } from './types';

export const metric = ['completeness', 'coherence', 'conciseness', 'output_latency_milliseconds'] as const;

/**
 * Sanitize a filename by removing or replacing illegal characters.
 * This ensures the filename is valid across different operating systems.
 *
 * @param filename - The filename to sanitize
 * @returns A sanitized filename safe for use across operating systems
 */
export const sanitizeFilename = (filename: string): string => {
  if (!filename) return '';
  // Replace colons from ISO timestamps with underscores
  const sanitized = filename.replace(/:/g, '_');
  // Replace other potentially problematic characters
  return sanitized.replace(/[<>:"\\|?*]/g, '_');
};

/**
 * Clean a string by replacing HTML entities with their respective characters.
 *
 * @param str - The string to clean.
 * @returns The cleaned string with all HTML entities replaced with their respective characters.
 */
export const decodeHtmlEntities = (str: string = ''): string => {
  const entities: { [key: string]: string } = {
    '&quot;': '"',
    '&#92;': '\\',
    '&apos;': "'",
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&#39;': "'",
    '&deg;': '°',
    '&nbsp;': ' ',
    '&ndash;': '–',
    '&mdash;': '—',
    '&rsquo;': "'",
    '&lsquo;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&hellip;': '…',
    '&trade;': '™',
    '&copy;': '©',
    '&reg;': '®',
    '&euro;': '€',
    '&pound;': '£',
    '&yen;': '¥',
    '&cent;': '¢',
    '&times;': '×',
    '&divide;': '÷',
    '&plusmn;': '±',
    '&micro;': 'µ',
    '&para;': '¶',
    '&sect;': '§',
    '&bull;': '•',
    '&middot;': '·',
  };

  return str.replace(/&[a-zA-Z0-9#]+;/g, (entity) => entities[entity] || entity);
};

/**
 * Find the authoring bundle directory for a given bot name by recursively searching from a starting directory or directories.
 *
 * @param dirOrDirs - The directory or array of directories to start searching from
 * @param botName - The name of the bot to find the authoring bundle directory for
 * @returns The path to the authoring bundle directory if found, undefined otherwise
 */
export const findAuthoringBundle = (dirOrDirs: string | string[], botName: string): string | undefined => {
  // If it's an array of directories, search in each one
  if (Array.isArray(dirOrDirs)) {
    for (const dir of dirOrDirs) {
      const found = findAuthoringBundle(dir, botName);
      if (found) return found;
    }
    return undefined;
  }

  // Single directory search logic
  const dir = dirOrDirs;
  try {
    const files: string[] = readdirSync(dir);

    // If we find aiAuthoringBundles dir, check for the expected directory structure
    if (files.includes('aiAuthoringBundles')) {
      const expectedPath = path.join(dir, 'aiAuthoringBundles', botName);
      const statResult = statSync(expectedPath, { throwIfNoEntry: false });
      if (statResult?.isDirectory()) {
        return expectedPath;
      }
    }

    // Otherwise keep searching directories
    for (const file of files) {
      const filePath = path.join(dir, file);
      const statResult = statSync(filePath, { throwIfNoEntry: false });
      if (statResult?.isDirectory()) {
        const found = findAuthoringBundle(filePath, botName);
        if (found) return found;
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be read
    return undefined;
  }
  return undefined;
};

/**
 * Find all local agent files in a directory by recursively searching for files ending with '.agent'
 *
 * @param dir - The directory to start searching from
 * @returns Array of paths to agent files
 */
export const findLocalAgents = (dir: string): string[] => {
  const results: string[] = [];

  try {
    const files = readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const statResult = statSync(filePath, { throwIfNoEntry: false });

      if (!statResult) continue;

      if (statResult.isDirectory()) {
        results.push(...findLocalAgents(filePath));
      } else if (file.endsWith('.agent')) {
        results.push(filePath);
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be read
    return [];
  }

  return results;
};

export const useNamedUserJwt = async (connection: Connection): Promise<Connection> => {
  // Refresh the connection to ensure we have the latest, valid access token
  try {
    await connection.refreshAuth();
  } catch (error) {
    throw SfError.create({
      name: 'ApiAccessError',
      message: 'Error refreshing connection',
      cause: error,
    });
  }

  const { accessToken, instanceUrl } = connection.getConnectionOptions();
  if (!instanceUrl) {
    throw SfError.create({
      name: 'ApiAccessError',
      message: 'Missing Instance URL for org connection',
    });
  }
  if (!accessToken) {
    throw SfError.create({
      name: 'ApiAccessError',
      message: 'Missing Access Token for org connection',
    });
  }

  const url = `${instanceUrl}/agentforce/bootstrap/nameduser`;
  // For the namdeduser endpoint request to work we need to delete the access token
  delete connection.accessToken;
  try {
    const response = await connection.request<NamedUserJwtResponse>(
      {
        method: 'GET',
        url,
        headers: {
          'Content-Type': 'application/json',
          Cookie: `sid=${accessToken}`,
        },
      },
      { retry: { maxRetries: 3 } }
    );
    connection.accessToken = response.access_token;
    return connection;
  } catch (error) {
    throw SfError.create({
      name: 'ApiAccessError',
      message: 'Error obtaining API token',
      cause: error,
    });
  }
};

// ====================================================
//               Transcript Utilities
// ====================================================

export type TranscriptRole = 'user' | 'agent';

export type TranscriptEntry = {
  timestamp: string;
  agentId: string; // botId for published agents, developerName for .agent files
  sessionId: string;
  role: TranscriptRole;
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw?: any;
  reason?: string;
};

const resolveProjectLocalSfdx = async (): Promise<string | undefined> => {
  try {
    const project = await SfProject.resolve();
    return path.join(project.getPath(), '.sfdx');
  } catch (_e) {
    return undefined;
  }
};

const getConversationDir = async (agentId: string): Promise<string> => {
  const base = (await resolveProjectLocalSfdx()) ?? path.join(process.cwd(), '.sfdx');
  const dir = path.join(base, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  return dir;
};

const getLastConversationPath = async (agentId: string): Promise<string> =>
  path.join(await getConversationDir(agentId), 'history.json');

/**
 * Get the session directory path for a specific session
 */
export const getSessionDir = async (agentId: string, sessionId: string): Promise<string> => {
  const base = (await resolveProjectLocalSfdx()) ?? path.join(process.cwd(), '.sfdx');
  const dir = path.join(base, 'agents', agentId, 'sessions', sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
};

/**
 * Copy a directory recursively
 */
export const copyDirectory = async (src: string, dest: string): Promise<void> => {
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true });
};

/**
 * Append a transcript entry to the session transcript file
 */
export const appendTranscriptEntryToSession = async (entry: TranscriptEntry, sessionDir: string): Promise<void> => {
  const transcriptPath = path.join(sessionDir, 'transcript.jsonl');
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(transcriptPath, line, 'utf-8');
};

/**
 * Write a trace to the session traces directory
 */
export const writeTraceToSession = async (
  planId: string,
  trace: PlannerResponse,
  sessionDir: string
): Promise<void> => {
  const tracesDir = path.join(sessionDir, 'traces');
  await mkdir(tracesDir, { recursive: true });
  const tracePath = path.join(tracesDir, `${planId}.json`);
  await writeFile(tracePath, JSON.stringify(trace, null, 2), 'utf-8');
};

/**
 * Session metadata type
 */
export type SessionMetadata = {
  sessionId: string;
  agentId: string;
  startTime: string;
  endTime?: string;
  apexDebugging?: boolean;
  mockMode?: 'Mock' | 'Live Test';
  planIds: string[];
};

/**
 * Write session metadata to the session directory
 */
export const writeMetadataToSession = async (sessionDir: string, metadata: SessionMetadata): Promise<void> => {
  const metadataPath = path.join(sessionDir, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
};

/**
 * Update session metadata with end time and plan IDs
 */
export const updateMetadataEndTime = async (
  sessionDir: string,
  endTime: string,
  planIds: Set<string>
): Promise<void> => {
  const metadataPath = path.join(sessionDir, 'metadata.json');
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as SessionMetadata;
    metadata.endTime = endTime;
    metadata.planIds = Array.from(planIds);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch {
    // If metadata doesn't exist, create it
    await writeMetadataToSession(sessionDir, {
      sessionId: '',
      agentId: '',
      startTime: '',
      endTime,
      planIds: Array.from(planIds),
    });
  }
};

/**
 * Read and parse the last conversation's transcript entries from JSON.
 * Path: <project>/.sfdx/agents/conversations/<agentId>/history.json
 *
 * @param agentId The agent's API name (developerName)
 * @returns Array of TranscriptEntry in file order (chronological append order).
 */
export const readTranscriptEntries = async (agentId: string): Promise<TranscriptEntry[]> => {
  const filePath = await getLastConversationPath(agentId);
  try {
    const data = await readFile(filePath, 'utf-8');
    return data
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TranscriptEntry);
  } catch (_e) {
    return [];
  }
};
