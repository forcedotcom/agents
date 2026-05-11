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
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Connection, Logger, SfError, SfProject } from '@salesforce/core';
import { AvailableDefinition, NamedUserJwtResponse, type PlannerResponse, PreviewMetadata } from './types';

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

    // Validate the response contains a valid access token
    if (!response) {
      throw SfError.create({
        name: 'ApiAccessError',
        message: 'Error obtaining API token: empty response.',
      });
    }

    if (!response.access_token || typeof response.access_token !== 'string' || response.access_token.trim() === '') {
      throw SfError.create({
        name: 'ApiAccessError',
        message: 'Error obtaining API token: invalid or missing access token.',
      });
    }

    // Validate token format is JWT (three parts separated by dots)
    const tokenParts = response.access_token.split('.');
    if (tokenParts.length !== 3) {
      throw SfError.create({
        name: 'ApiAccessError',
        message: 'Error obtaining API token: access token does not have valid JWT format.',
      });
    }

    connection.accessToken = response.access_token;
    return connection;
  } catch (error) {
    // If it's already an SfError with our specific message, re-throw it as-is
    if (error instanceof SfError && error.name === 'ApiAccessError') {
      error.actions = [
        'If using your own connected app or ECA, ensure it grants access to the SFAP APIs by providing these scopes:',
        '   * Access chatbot services (chatbot_api)',
        '   * Access the Salesforce API Platform (sfap_api)',
        '   * Manage user data via Web browsers (web)',
      ];
      throw error;
    }
    // Otherwise wrap it with a generic error
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
  reason?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw?: any;
};

export type TurnIndexEntry = {
  turn: number;
  timestamp: string;
  role: TranscriptRole;
  summary: string;
  summaryTruncated: boolean;
  multiModal: string | null;
  traceFile: string | null;
  planId: string | null;
  reason?: string;
};

export type TurnIndex = {
  version: string;
  sessionId: string;
  agentId: string;
  created: string;
  turns: TurnIndexEntry[];
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
 * ├── turn-index.json     # Turn-trace correlation index
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

export type TraceFileInfo = {
  planId: string;
  path: string;
  size: number;
  mtime: Date;
};

/**
 * List trace files for a given agent session.
 *
 * Returns one entry per .json file in the session's traces/ directory.
 * File path is absolute. Returns an empty array if the traces directory does not exist.
 */
export const listSessionTraces = async (agentId: string, sessionId: string): Promise<TraceFileInfo[]> => {
  const historyDir = await getHistoryDir(agentId, sessionId);
  const tracesDir = path.join(historyDir, 'traces');
  try {
    const files = await readdir(tracesDir);
    return await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const filePath = path.join(tracesDir, f);
          const s = await stat(filePath);
          return { planId: path.basename(f, '.json'), path: filePath, size: s.size, mtime: s.mtime };
        })
    );
  } catch {
    return [];
  }
};

/**
 * Read a single trace file by planId. Returns null if the file does not exist or cannot be parsed.
 */
export const readSessionTrace = async (
  agentId: string,
  sessionId: string,
  planId: string
): Promise<PlannerResponse | null> => {
  const historyDir = await getHistoryDir(agentId, sessionId);
  const tracePath = path.join(historyDir, 'traces', `${planId}.json`);
  try {
    const raw = await readFile(tracePath, 'utf-8');
    return JSON.parse(raw) as PlannerResponse;
  } catch {
    return null;
  }
};

/**
 * Read the turn-index.json for a session. Returns null if not found.
 */
export const readTurnIndex = async (agentId: string, sessionId: string): Promise<TurnIndex | null> => {
  const historyDir = await getHistoryDir(agentId, sessionId);
  const turnIndexPath = path.join(historyDir, 'turn-index.json');
  try {
    const raw = await readFile(turnIndexPath, 'utf-8');
    return JSON.parse(raw) as TurnIndex;
  } catch {
    return null;
  }
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
 * Helper function to create a summary with truncation
 */
function createSummary(text: string | undefined, multiModal: string | null): { summary: string; truncated: boolean } {
  const MAX_SUMMARY_LENGTH = 100;

  if (multiModal) {
    return { summary: `[${multiModal}]`, truncated: false };
  }

  if (!text) {
    return { summary: '', truncated: false };
  }

  if (text.length <= MAX_SUMMARY_LENGTH) {
    return { summary: text, truncated: false };
  }

  return {
    summary: text.substring(0, MAX_SUMMARY_LENGTH) + '...',
    truncated: true,
  };
}

/**
 * In-memory buffer for session history to minimize file I/O during conversation
 */
export class SessionHistoryBuffer {
  private turnEntries: TurnIndexEntry[] = [];
  private planIds: Set<string> = new Set();

  public constructor(
    private readonly sessionDir: string,
    private readonly sessionId: string,
    private readonly agentId: string,
    private readonly created: string,
    private readonly mockMode?: 'Mock' | 'Live Test'
  ) {}

  /**
   * Create a SessionHistoryBuffer from existing session data on disk
   * Used when resuming an existing session
   */
  public static async fromDisk(
    sessionDir: string,
    sessionId: string,
    agentId: string
  ): Promise<{ buffer: SessionHistoryBuffer; turnCount: number }> {
    // Read existing metadata and turn-index files
    const metadataPath = path.join(sessionDir, 'metadata.json');
    const turnIndexPath = path.join(sessionDir, 'turn-index.json');

    let metadata: PreviewMetadata | null = null;
    let turnIndex: TurnIndex | null = null;

    try {
      const metadataContent = await readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(metadataContent) as PreviewMetadata;
    } catch {
      // Metadata doesn't exist yet - that's ok for a new session
    }

    try {
      const turnIndexContent = await readFile(turnIndexPath, 'utf-8');
      turnIndex = JSON.parse(turnIndexContent) as TurnIndex;
    } catch {
      // Turn index doesn't exist yet - that's ok for a new session
    }

    // Create buffer with metadata
    const buffer = new SessionHistoryBuffer(
      sessionDir,
      sessionId,
      agentId,
      metadata?.startTime ?? new Date().toISOString(),
      metadata?.mockMode
    );

    // Load existing turns and planIds into buffer
    if (turnIndex?.turns) {
      turnIndex.turns.forEach((turn) => buffer.addTurn(turn));
    }
    if (metadata?.planIds) {
      metadata.planIds.forEach((planId) => buffer.addPlanId(planId));
    }

    // Return buffer and current turn count
    const turnCount = turnIndex?.turns.length ?? 0;
    return { buffer, turnCount };
  }

  /**
   * Add a turn to the buffer (no file I/O)
   */
  public addTurn(entry: TurnIndexEntry): void {
    this.turnEntries.push(entry);
  }

  /**
   * Add a planId to the buffer (no file I/O)
   */
  public addPlanId(planId: string): void {
    this.planIds.add(planId);
  }

  /**
   * Update an existing turn with trace info (no file I/O)
   */
  public updateTurnWithTrace(turnNumber: number, planId: string): void {
    const turn = this.turnEntries.find((t) => t.turn === turnNumber);
    if (turn) {
      turn.traceFile = `traces/${planId}.json`;
      turn.planId = planId;
    }
  }

  /**
   * Flush all buffered data to disk
   * Called at session start (to create initial files), after each turn (to keep real-time), and at session end (to finalize)
   */
  public async flush(endTime?: string): Promise<void> {
    const turnIndexPath = path.join(this.sessionDir, 'turn-index.json');
    const metadataPath = path.join(this.sessionDir, 'metadata.json');

    const turnIndex: TurnIndex = {
      version: '1.0',
      sessionId: this.sessionId,
      agentId: this.agentId,
      created: this.created,
      turns: this.turnEntries,
    };

    const metadata: PreviewMetadata = {
      sessionId: this.sessionId,
      agentId: this.agentId,
      startTime: this.created,
      planIds: Array.from(this.planIds),
    };

    if (endTime) {
      metadata.endTime = endTime;
    }
    if (this.mockMode) {
      metadata.mockMode = this.mockMode;
    }

    // Write both files in parallel
    await Promise.all([
      writeFile(turnIndexPath, JSON.stringify(turnIndex, null, 2), 'utf-8'),
      writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8'),
    ]);
  }
}

/**
 * Log a turn to history using buffer (fast, no read-modify-write)
 *
 * @param {TranscriptEntry} entry the transcript entry to log
 * @param {number} turnNumber the turn number (1-based)
 * @param {string} sessionDir path to the session directory
 * @param {SessionHistoryBuffer} buffer buffer for batched writes
 * @returns {Promise<void>}
 */
export const logTurnToHistory = async (
  entry: TranscriptEntry,
  turnNumber: number,
  sessionDir: string,
  buffer: SessionHistoryBuffer
): Promise<void> => {
  // Always append to transcript immediately (fast append-only operation)
  await appendTranscriptToHistory(entry, sessionDir);

  // Add turn to in-memory buffer (no I/O)
  const { summary, truncated } = createSummary(entry.text, null);
  buffer.addTurn({
    turn: turnNumber,
    timestamp: entry.timestamp,
    role: entry.role,
    summary,
    summaryTruncated: truncated,
    multiModal: null,
    traceFile: null,
    planId: null,
    reason: entry.reason,
  });
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
  const logger = Logger.childFromRoot('AgentApiRequest');

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
      logger.debug(`Request failed for url ${modifiedUrl} with status code ${statusCode ?? 'unknown'}`);
      if (statusCode === 404) {
        lastError = error;
        continue; // Try next endpoint
      }
      // Not a 404, throw immediately
      throw error;
    }
  }

  // All endpoints failed with 404
  logger.debug(`Attempted endpoints: ${attemptedEndpoints.join(', ')}`);
  throw SfError.create({
    name: 'AgentApiNotFound',
    message: `Unable to access the Salesforce Agent APIs. Ensure the user '${
      connection.getUsername() ?? ''
    }' has the necessary permissions and authorization to perform this action.`,
    cause: lastError,
  });
}

/**
 * Record a trace for a turn using buffer (fast, minimal I/O)
 *
 * @param {string} historyDir path to the session directory
 * @param {number} turnNumber the turn number that generated this trace
 * @param {string} planId the plan ID for this trace
 * @param {PlannerResponse | undefined} trace the trace data to write
 * @param {SessionHistoryBuffer} buffer buffer for batched updates
 * @returns {Promise<void>}
 */
export const recordTraceForTurn = async (
  historyDir: string,
  turnNumber: number,
  planId: string,
  trace: PlannerResponse | undefined,
  buffer: SessionHistoryBuffer
): Promise<void> => {
  // Write the trace file immediately (one-time write)
  const tracesDir = path.join(historyDir, 'traces');
  const tracePath = path.join(tracesDir, `${planId}.json`);
  await mkdir(tracesDir, { recursive: true });
  await writeFile(tracePath, JSON.stringify(trace ?? {}, null, 2), 'utf-8');

  // Update in memory (no I/O)
  buffer.updateTurnWithTrace(turnNumber, planId);
  buffer.addPlanId(planId);
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

// ====================================================
//         Agent Test Runner Detection
// ====================================================

export type TestRunnerType = 'agentforce-studio' | 'testing-center';

const TESTING_CENTER_PREFIX = '4KB';
const AGENTFORCE_STUDIO_PREFIX = '3A2';

/** Detects the test runner from a run ID's Salesforce ID prefix (`3A2` = Agentforce Studio, `4KB` = Testing Center). */
export function detectTestRunnerFromId(runId: string): TestRunnerType | undefined {
  if (runId.startsWith(AGENTFORCE_STUDIO_PREFIX)) return 'agentforce-studio';
  if (runId.startsWith(TESTING_CENTER_PREFIX)) return 'testing-center';
  return undefined;
}

/**
 * Determines which test runner to use based on available metadata types in the org.
 *
 * This function checks for the presence of:
 * - `AiEvaluationDefinition` (Testing Center)
 * - `AiTestingDefinition` (Agentforce Studio)
 *
 * If a test definition with the same name exists in both metadata types, an error is thrown
 * to prevent ambiguity.
 *
 * @param connection - The Salesforce connection
 * @param testDefinitionName - Optional test definition name to check for conflicts
 * @returns 'agentforce-studio' if only Agentforce Studio metadata exists, 'testing-center' if only Testing Center metadata exists
 * @throws {SfError} if both metadata types exist with the same test definition name
 * @throws {SfError} if neither metadata type exists
 *
 * @example
 * ```typescript
 * const runnerType = await determineTestRunner(connection, 'MyTestSuite');
 * if (runnerType === 'agentforce-studio') {
 *   const tester = new AgentforceStudioTester(connection);
 * } else {
 *   const tester = new AgentTester(connection);
 * }
 * ```
 */
export async function determineTestRunner(
  connection: Connection,
  testDefinitionName?: string
): Promise<TestRunnerType> {
  // Query both metadata types in parallel
  const [tcDefs, asDefs] = await Promise.all([
    connection.metadata.list({ type: 'AiEvaluationDefinition' }).catch(() => [] as AvailableDefinition[]),
    connection.metadata.list({ type: 'AiTestingDefinition' }).catch(() => [] as AvailableDefinition[]),
  ]);

  // If a specific test name is provided, check for conflicts
  if (testDefinitionName && tcDefs.length > 0 && asDefs.length > 0) {
    const tcNames = new Set(tcDefs.map((def) => def.fullName));
    const asNames = new Set(asDefs.map((def) => def.fullName));

    if (tcNames.has(testDefinitionName) && asNames.has(testDefinitionName)) {
      throw SfError.create({
        name: 'AmbiguousTestDefinition',
        message: `'${testDefinitionName}' exists in both Testing Center (AiEvaluationDefinition) and Agentforce Studio (AiTestingDefinition).`,
      });
    }

    if (tcNames.has(testDefinitionName)) {
      return 'testing-center';
    }

    if (asNames.has(testDefinitionName)) {
      return 'agentforce-studio';
    }
  }

  if (tcDefs.length > 0 && asDefs.length === 0) {
    return 'testing-center';
  }

  if (asDefs.length > 0 && tcDefs.length === 0) {
    return 'agentforce-studio';
  }

  // Neither exists
  throw SfError.create({
    name: 'NoTestDefinitionsFound',
    message:
      'No test definitions found in the org. Expected either AiEvaluationDefinition (Testing Center) or AiTestingDefinition (Agentforce Studio) metadata.',
  });
}

// ====================================================
//               Preview Session Store
// ====================================================

const SESSION_META_FILE = 'session-meta.json';
const SESSION_INDEX_FILE = 'index.json';

export type SessionType = 'simulated' | 'live' | 'published';
export type PreviewSessionMeta = { displayName?: string; timestamp?: string; sessionType?: SessionType };
type PreviewSessionIndex = Array<{
  sessionId: string;
  displayName?: string;
  timestamp?: string;
  sessionType?: SessionType;
}>;

async function readPreviewSessionIndex(indexPath: string): Promise<PreviewSessionIndex> {
  try {
    const raw = await readFile(indexPath, 'utf-8');
    return JSON.parse(raw) as PreviewSessionIndex;
  } catch {
    return [];
  }
}

/**
 * Atomically read-modify-write the preview sessions index.
 * Writes to a temp file then renames to avoid partial writes and reduce
 * the window for concurrent-write races (last writer wins, no silent drops).
 * Propagates errors so callers are aware of index failures.
 */
async function updatePreviewSessionIndex(
  indexPath: string,
  updater: (index: PreviewSessionIndex) => PreviewSessionIndex
): Promise<void> {
  const index = await readPreviewSessionIndex(indexPath);
  const updated = updater(index);
  const tmpPath = `${indexPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(updated, null, 2), 'utf-8');
  await rename(tmpPath, indexPath);
}

/**
 * Save a marker so send/end can validate that the session was started for this agent.
 * Caller must have started the session (agent has sessionId set). Uses agent.getHistoryDir() for the path.
 * Pass displayName (authoring bundle name or production agent API name) so "agent preview sessions" can show it.
 */
export async function createPreviewSessionCache(
  agent: { getHistoryDir: () => Promise<string> },
  options?: { displayName?: string; sessionType?: SessionType }
): Promise<void> {
  const historyDir = await agent.getHistoryDir();
  const metaPath = path.join(historyDir, SESSION_META_FILE);
  const meta: PreviewSessionMeta = {
    displayName: options?.displayName,
    timestamp: new Date().toISOString(),
    sessionType: options?.sessionType,
  };
  await writeFile(metaPath, JSON.stringify(meta), 'utf-8');

  // Update the sessions index for ordered browsing
  const sessionId = path.basename(historyDir);
  const sessionsDir = path.dirname(historyDir);
  const indexPath = path.join(sessionsDir, SESSION_INDEX_FILE);
  await updatePreviewSessionIndex(indexPath, (index) => {
    if (!index.some((e) => e.sessionId === sessionId)) {
      index.push({
        sessionId,
        displayName: meta.displayName,
        timestamp: meta.timestamp,
        sessionType: meta.sessionType,
      });
    }
    return index;
  });
}

/**
 * Validate that the session was started for this agent (marker file exists in agent's history dir for current sessionId).
 * Caller must set sessionId on the agent (agent.setSessionId) before calling.
 * Throws SfError if the session marker is not found.
 */
export async function validatePreviewSession(agent: { getHistoryDir: () => Promise<string> }): Promise<void> {
  const historyDir = await agent.getHistoryDir();
  const metaPath = path.join(historyDir, SESSION_META_FILE);
  try {
    await readFile(metaPath, 'utf-8');
  } catch (error) {
    throw SfError.create({
      message: 'No preview session found for this session ID. Run "sf agent preview start" first.',
      name: 'PreviewSessionNotFound',
      cause: error,
    });
  }
}

/**
 * Remove the session marker so this session is no longer considered "active" for send/end without --session-id.
 * Call after ending the session. Caller must set sessionId on the agent before calling.
 */
export async function removePreviewSessionCache(agent: { getHistoryDir: () => Promise<string> }): Promise<void> {
  const historyDir = await agent.getHistoryDir();
  const metaPath = path.join(historyDir, SESSION_META_FILE);
  try {
    await unlink(metaPath);
  } catch {
    // already removed or never created
  }

  // Remove entry from the sessions index
  const sessionId = path.basename(historyDir);
  const sessionsDir = path.dirname(historyDir);
  const indexPath = path.join(sessionsDir, SESSION_INDEX_FILE);
  await updatePreviewSessionIndex(indexPath, (index) => index.filter((e) => e.sessionId !== sessionId));
}

/**
 * List session IDs that have a cache marker (started via "agent preview start") for this agent.
 * Uses project path and agent's storage ID to find .sfdx/agents/<agentId>/sessions/<sessionId>/session-meta.json.
 */
export async function getCachedPreviewSessionIds(
  project: SfProject,
  agent: { getAgentIdForStorage: () => string | Promise<string> }
): Promise<string[]> {
  const agentId = await agent.getAgentIdForStorage();
  const base = path.join(project.getPath(), '.sfdx');
  const sessionsDir = path.join(base, 'agents', agentId, 'sessions');
  const sessionIds: string[] = [];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const hasMarker = await Promise.all(
      dirs.map(async (name) => {
        try {
          await readFile(path.join(sessionsDir, name, SESSION_META_FILE), 'utf-8');
          return true;
        } catch {
          return false;
        }
      })
    );
    dirs.forEach((name, i) => {
      if (hasMarker[i]) sessionIds.push(name);
    });
  } catch {
    // sessions dir missing or unreadable
  }
  return sessionIds;
}

/**
 * Return the single "current" session ID when safe: exactly one cached session for this agent.
 * Returns undefined when there are zero or multiple sessions (caller should require --session-id).
 */
export async function getCurrentPreviewSessionId(
  project: SfProject,
  agent: { getAgentIdForStorage: () => string | Promise<string> }
): Promise<string | undefined> {
  const ids = await getCachedPreviewSessionIds(project, agent);
  return ids.length === 1 ? ids[0] : undefined;
}

export type CachedPreviewSessionInfo = { sessionId: string; timestamp?: string; sessionType?: SessionType };
export type CachedPreviewSessionEntry = {
  agentId: string;
  displayName?: string;
  sessions: CachedPreviewSessionInfo[];
};

/**
 * List all cached preview sessions in the project, grouped by agent ID.
 * displayName (when present in session-meta.json) is the authoring bundle name or production agent API name for display.
 * Use this to show users which sessions exist so they can end or clean up.
 */
export async function listCachedPreviewSessions(project: SfProject): Promise<CachedPreviewSessionEntry[]> {
  const base = path.join(project.getPath(), '.sfdx', 'agents');
  const result: CachedPreviewSessionEntry[] = [];
  try {
    const agentDirs = await readdir(base, { withFileTypes: true });
    const entries = await Promise.all(
      agentDirs
        .filter((ent) => ent.isDirectory())
        .map(async (ent) => {
          const agentId = ent.name;
          const sessionsDir = path.join(base, agentId, 'sessions');
          let sessions: CachedPreviewSessionInfo[] = [];
          let displayName: string | undefined;
          try {
            // Prefer the index for ordered, metadata-rich results
            const index = await readPreviewSessionIndex(path.join(sessionsDir, SESSION_INDEX_FILE));
            if (index.length > 0) {
              // Verify each indexed session still has its marker file (guard against manual cleanup)
              const verified = await Promise.all(
                index.map(async (entry) => {
                  try {
                    await readFile(path.join(sessionsDir, entry.sessionId, SESSION_META_FILE), 'utf-8');
                    return entry;
                  } catch {
                    return null;
                  }
                })
              );
              sessions = verified
                .filter((e): e is PreviewSessionIndex[number] => e !== null)
                .map(({ sessionId, timestamp, sessionType }) => ({ sessionId, timestamp, sessionType }));
              displayName = index.find((e) => e.displayName !== undefined)?.displayName;
            } else {
              // Fallback: scan directories (no index yet, e.g. sessions started before this feature)
              const sessionDirs = await readdir(sessionsDir, { withFileTypes: true });
              const sessionInfos = await Promise.all(
                sessionDirs
                  .filter((s) => s.isDirectory())
                  .map(async (s): Promise<(CachedPreviewSessionInfo & { displayName?: string }) | null> => {
                    try {
                      const raw = await readFile(path.join(sessionsDir, s.name, SESSION_META_FILE), 'utf-8');
                      const meta = JSON.parse(raw) as PreviewSessionMeta;
                      return {
                        sessionId: s.name,
                        timestamp: meta.timestamp,
                        sessionType: meta.sessionType,
                        displayName: meta.displayName,
                      };
                    } catch {
                      return null;
                    }
                  })
              );
              const validSessions = sessionInfos.filter(
                (s): s is CachedPreviewSessionInfo & { displayName?: string } => s !== null
              );
              sessions = validSessions.map(({ sessionId, timestamp, sessionType }) => ({
                sessionId,
                timestamp,
                sessionType,
              }));
              displayName = validSessions[0]?.displayName;
            }
          } catch {
            // no sessions dir or unreadable
          }
          return { agentId, displayName, sessions };
        })
    );
    result.push(...entries.filter((e) => e.sessions.length > 0));
  } catch {
    // no agents dir or unreadable
  }
  return result;
}
