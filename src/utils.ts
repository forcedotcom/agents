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
import * as path from 'node:path';
import { Connection, SfError } from '@salesforce/core';
import { NamedUserJwtResponse } from './types';

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
