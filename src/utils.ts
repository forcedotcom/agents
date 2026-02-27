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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, appendFile, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { NamedUserJwtResponse, type PlannerResponse, PreviewMetadata } from './types';

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
 * Find all local agent files matching the pattern aiAuthoringBundles/<name>/<name>.agent
 * Only descends into aiAuthoringBundles to check direct children (no full tree walk under it).
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

      if (!statResult?.isDirectory()) continue;

      if (file === 'aiAuthoringBundles') {
        const bundlePath = filePath;
        const children = readdirSync(bundlePath);
        for (const name of children) {
          const agentDir = path.join(bundlePath, name);
          const agentFile = path.join(agentDir, `${name}.agent`);
          const fileStat = statSync(agentFile, { throwIfNoEntry: false });
          if (fileStat?.isFile()) {
            results.push(agentFile);
          }
        }
      } else {
        results.push(...findLocalAgents(filePath));
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be read
    return [];
  }

  return results;
};
/**
 * takes a connection and upgrades it to a NamedJWT connection
 *
 * @param {Connection} connection original Connection
 * @returns {Promise<Connection>} upgraded connection
 */
export const useNamedUserJwt = async (connection: Connection): Promise<Connection> => {
  // If the connection has a refresh token, refresh the connection to ensure we have the
  // latest, valid access token.
  const authFields = connection.getAuthInfoFields();
  if (authFields.refreshToken) {
    try {
      await connection.refreshAuth();
    } catch (error) {
      throw SfError.create({
        name: 'ApiAccessError',
        message: 'Error refreshing connection',
        cause: error,
      });
    }
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
  // For the nameduser endpoint request to work we need to delete the access token
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

/**
 * returns a path, and ensures it's created, to the agents history directory
 *
 * Initialize session directory
 * Session directory structure:
 * .sfdx/agents/<agentId>/sessions/<sessionId>/
 * ├── transcript.jsonl    # All transcript entries (one per line)
 * ├── traces/             # Individual trace files
 * │   ├── <planId1>.json
 * │   └── <planId2>.json
 * └── metadata.json       # Session metadata (start time, end time, planIds, etc.)
 *
 * @param {string} agentId gotten from Agent.getAgentIdForStorage()
 * @param {string} sessionId the preview's start call .SessionId
 * @returns {Promise<string>} path to where history/metadata/transcripts are stored inside of local .sfdx
 */
export const getHistoryDir = async (agentId: string, sessionId: string): Promise<string> => {
  const agentIndexDir = await getAgentIndexDir(agentId);
  const dir = path.join(agentIndexDir, 'sessions', sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
};

/**
 * Get the path to the agent index directory.  Create the directory if it doesn't exist.
 *
 * .sfdx/agents/<agentId>/   <-- returns this directory path
 * ├── index.md            # Session index file
 * │── sessions/           # Session directories
 * │   ├── <sessionId1>/   # Session 1 directory
 * │   └── <sessionId2>/   # Session 2 directory
 *
 * @param {string} agentId
 * @returns {Promise<string>} path to the agent index directory
 */
export const getAgentIndexDir = async (agentId: string): Promise<string> => {
  const base = (await resolveProjectLocalSfdx()) ?? path.join(process.cwd(), '.sfdx');
  const dir = path.join(base, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  return dir;
};

/**
 * Append a transcript entry to the transcript.jsonl transcript file
 *
 * @param {TranscriptEntry} entry to save
 * @param {string} sessionDir the preview's start call .SessionId
 * @returns {Promise<void>}
 */
export const appendTranscriptToHistory = async (entry: TranscriptEntry, sessionDir: string): Promise<void> => {
  const transcriptPath = path.join(sessionDir, 'transcript.jsonl');
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(transcriptPath, line, 'utf-8');
};

/**
 * writes a trace to <plan-id>.json in history directory
 *
 * @param {string} planId
 * @param {PlannerResponse | undefined} trace
 * @param {string} historyDir
 * @returns {Promise<void>}
 */
export const writeTraceToHistory = async (
  planId: string,
  trace: PlannerResponse | undefined,
  historyDir: string
): Promise<void> => {
  const tracesDir = path.join(historyDir, 'traces');
  await mkdir(tracesDir, { recursive: true });
  const tracePath = path.join(tracesDir, `${planId}.json`);
  await writeFile(tracePath, JSON.stringify(trace ?? {}, null, 2), 'utf-8');
};

/**
 * Write preview metadata to the history directory
 */
export const writeMetaFileToHistory = async (historyDir: string, metadata: PreviewMetadata): Promise<void> => {
  const metadataPath = path.join(historyDir, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
};

/**
 * Write or append a session line to .sfdx/agents/<agentId>/index.md.
 * If the file does not exist, creates it with a header and the session line.
 * If it exists, appends the new session line.
 */
export const logSessionToIndex = async (
  agentDir: string,
  options: { sessionId: string; startTime: string; simulated: boolean; agentId: string }
): Promise<void> => {
  const indexPath = path.join(agentDir, 'index.md');
  const modeLabel = options.simulated ? 'simulated' : 'live';
  const sessionLine = `- **${options.startTime}** | \`${options.sessionId}\` | ${modeLabel}`;

  if (!existsSync(indexPath)) {
    const initialContent = `# ${options.agentId} - Sessions\n\n${sessionLine}\n`;
    await writeFile(indexPath, initialContent, 'utf-8');
  } else {
    await appendFile(indexPath, `${sessionLine}\n`, 'utf-8');
  }
};

/**
 * Extract HTTP status code from API errors. Supports:
 * - ERROR_HTTP_404 / ERROR_HTTP_500 style (name, errorCode, or data.errorCode)
 * - Numeric statusCode on error, cause, or response
 */
export function getHttpStatusCode(err: unknown): number | undefined {
  return getHttpStatusCodeInternal(err, new Set());
}

/**
 * Internal implementation with circular reference tracking
 */
function getHttpStatusCodeInternal(err: unknown, visited: Set<unknown>): number | undefined {
  // Prevent infinite recursion from circular references
  if (visited.has(err)) {
    return undefined;
  }
  visited.add(err);

  const e = err as {
    name?: string;
    errorCode?: string;
    data?: { errorCode?: string };
    statusCode?: number;
    cause?: unknown;
    response?: { statusCode?: number };
  };
  const codeStr = e?.name ?? e?.errorCode ?? e?.data?.errorCode;
  if (typeof codeStr === 'string') {
    const match = /ERROR_HTTP_(\d+)/i.exec(codeStr);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return e?.statusCode ?? getHttpStatusCodeInternal(e?.cause, visited) ?? e?.response?.statusCode;
}

export type RequestInfo = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
};

/**
 * Makes an API request with automatic endpoint fallback.
 * Tries api.salesforce.com first, then test.api.salesforce.com on 404, then dev.api.salesforce.com on 404.
 *
 * @param connection - The Salesforce connection
 * @param requestInfo - The request information (url, method, headers, body, etc.)
 * @param options - Optional retry/timeout options
 * @returns The API response
 * @throws SfError if all endpoints return 404, or immediately on non-404 errors
 */
export async function requestWithEndpointFallback<T>(
  connection: Connection,
  requestInfo: RequestInfo,
  options?: { retry?: { maxRetries?: number } }
): Promise<T> {
  const endpoints = ['', 'test.', 'dev.']; // Try production, test, dev in that order
  const attemptedEndpoints: string[] = [];

  let lastError: unknown;

  for (const endpoint of endpoints) {
    // Replace the domain with the endpoint variant
    const modifiedUrl = requestInfo.url.replace(
      /https:\/\/(?:test\.|dev\.)?api\.salesforce\.com/,
      `https://${endpoint}api.salesforce.com`
    );
    attemptedEndpoints.push(`${endpoint || 'production '}api.salesforce.com`);

    try {
      // eslint-disable-next-line no-await-in-loop
      return await connection.request<T>(
        {
          ...requestInfo,
          url: modifiedUrl,
        },
        options
      );
    } catch (error) {
      const statusCode = getHttpStatusCode(error);
      if (statusCode === 404) {
        lastError = error;
        continue; // Try next endpoint
      }
      // Not a 404, throw immediately
      throw error;
    }
  }

  // All endpoints failed with 404
  throw SfError.create({
    name: 'AgentApiNotFound',
    message: `API endpoint not found after trying: ${attemptedEndpoints.join(', ')}. Instance URL: ${
      connection.instanceUrl
    }`,
    cause: lastError,
  });
}

/**
 * Update preview metadata with end time and plan IDs
 */
export const updateMetadataEndTime = async (
  historyDir: string,
  endTime: string,
  planIds: Set<string>
): Promise<void> => {
  const metadataPath = path.join(historyDir, 'metadata.json');
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as PreviewMetadata;
    metadata.endTime = endTime;
    metadata.planIds = Array.from(planIds);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch {
    // If metadata doesn't exist, create it
    await writeMetaFileToHistory(historyDir, {
      sessionId: '',
      agentId: '',
      startTime: '',
      endTime,
      planIds: Array.from(planIds),
    });
  }
};

/**
 * Find the most recent session ID for an agent by checking metadata.json startTime
 *
 * @param agentId gotten from Agent.getAgentIdForStorage()
 * @returns The most recent sessionId, or undefined if no sessions found
 */
const findMostRecentSessionId = async (agentId: string): Promise<string | undefined> => {
  const base = (await resolveProjectLocalSfdx()) ?? path.join(process.cwd(), '.sfdx');
  const sessionsDir = path.join(base, 'agents', agentId, 'sessions');

  try {
    const sessionDirs = await readdir(sessionsDir);
    if (sessionDirs.length === 0) {
      return undefined;
    }

    // Get all sessions with their metadata to find the most recent
    const sessionPromises = sessionDirs.map(async (sessionId) => {
      const sessionPath = path.join(sessionsDir, sessionId);
      const metadataPath = path.join(sessionPath, 'metadata.json');

      try {
        const metadataData = await readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(metadataData) as PreviewMetadata;
        const statResult = await stat(sessionPath);

        return {
          sessionId,
          startTime: metadata.startTime ? new Date(metadata.startTime).getTime() : statResult.mtimeMs,
          mtime: statResult.mtimeMs,
        };
      } catch {
        // If metadata doesn't exist or can't be read, use directory modification time
        try {
          const statResult = await stat(sessionPath);
          return {
            sessionId,
            startTime: statResult.mtimeMs,
            mtime: statResult.mtimeMs,
          };
        } catch {
          return null;
        }
      }
    });

    const sessions = (await Promise.all(sessionPromises)).filter(
      (s): s is { sessionId: string; startTime: number; mtime: number } => s !== null
    );

    if (sessions.length === 0) {
      return undefined;
    }

    // Sort by startTime (most recent first), fallback to mtime
    sessions.sort((a, b) => b.startTime - a.startTime);
    return sessions[0].sessionId;
  } catch {
    // Sessions directory doesn't exist or can't be read
    return undefined;
  }
};

/**
 * Get all history data for a session including metadata, transcript, and traces
 *
 * @param agentId gotten from Agent.getAgentIdForStorage()
 * @param sessionId optional - the preview sessions' ID, gotten originally from /start .SessionId. If not provided, returns the most recent conversation
 * @returns Object containing parsed metadata, transcript entries, and traces
 */
export const getAllHistory = async (
  agentId: string,
  sessionId: string | undefined
): Promise<{
  metadata: PreviewMetadata | null;
  transcript: TranscriptEntry[];
  traces: PlannerResponse[];
}> => {
  // If sessionId is not provided, find the most recent session
  let actualSessionId = sessionId;
  if (!actualSessionId) {
    actualSessionId = await findMostRecentSessionId(agentId);
    if (!actualSessionId) {
      throw SfError.create({
        name: 'NoSessionFound',
        message: `No sessions found for agent ${agentId}`,
      });
    }
  }

  const historyDir = await getHistoryDir(agentId, actualSessionId);
  const result: {
    metadata: PreviewMetadata | null;
    transcript: TranscriptEntry[];
    traces: PlannerResponse[];
  } = {
    metadata: null,
    transcript: [],
    traces: [],
  };

  // Read metadata.json
  try {
    const metadataPath = path.join(historyDir, 'metadata.json');
    const metadataData = await readFile(metadataPath, 'utf-8');
    result.metadata = JSON.parse(metadataData) as PreviewMetadata;
  } catch {
    // Metadata file doesn't exist or can't be read - leave as null
  }

  // Read transcript.jsonl
  try {
    const transcriptPath = path.join(historyDir, 'transcript.jsonl');
    const transcriptData = await readFile(transcriptPath, 'utf-8');
    result.transcript = transcriptData
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptEntry);
  } catch {
    // Transcript file doesn't exist or can't be read - leave as empty array
  }

  // Read all trace files from traces/ directory
  try {
    const tracesDir = path.join(historyDir, 'traces');
    const files = await readdir(tracesDir);
    const tracePromises = files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        const tracePath = path.join(tracesDir, file);
        const traceData = await readFile(tracePath, 'utf-8');
        return JSON.parse(traceData) as PlannerResponse;
      });
    result.traces = await Promise.all(tracePromises);
  } catch {
    // Traces directory doesn't exist or can't be read - leave as empty array
  }

  return result;
};

/**
 * Read and parse the last conversation's transcript entries from JSON.
 *
 * @param agentId gotten from Agent.getAgentIdForStorage()
 * @param sessionId the preview sessions' ID, gotten originally from /start .SessionId
 * @returns Array of TranscriptEntry in file order (chronological append order).
 */
export const readTranscriptEntries = async (agentId: string, sessionId: string): Promise<TranscriptEntry[]> => {
  const filePath = await getHistoryDir(agentId, sessionId);
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
