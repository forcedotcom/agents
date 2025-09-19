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
 * Find the authoring bundle directory for a given bot name by recursively searching from a starting directory.
 *
 * @param dir - The directory to start searching from
 * @param botName - The name of the bot to find the authoring bundle directory for
 * @returns The path to the authoring bundle directory if found, undefined otherwise
 */
export const findAuthoringBundle = (dir: string, botName: string): string | undefined => {
  try {
    const files: string[] = readdirSync(dir);

    // If we find aiAuthoringBundle dir, check for the expected directory structure
    if (files.includes('aiAuthoringBundle')) {
      const expectedPath = path.join(dir, 'aiAuthoringBundle', botName);
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
