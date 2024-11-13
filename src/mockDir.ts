/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { join, resolve } from 'node:path';
import { readFileSync, type Stats, statSync } from 'node:fs';
import { Connection, Logger, SfError } from '@salesforce/core';
import { env } from '@salesforce/kit';

/**
 * If the `SF_MOCK_DIR` environment variable is set, resolve to an absolute path
 * and ensure the directory exits, then return the path.
 *
 * NOTE: THIS SHOULD BE MOVED TO SOME OTHER LIBRARY LIKE `@salesforce/kit`.
 *
 * @returns the absolute path to an existing directory used for mocking behavior
 */
export const getMockDir = (): string | undefined => {
  const mockDir = env.getString('SF_MOCK_DIR');
  if (mockDir) {
    let mockDirStat: Stats;
    try {
      mockDirStat = statSync(resolve(mockDir));
    } catch (err) {
      throw SfError.create({
        name: 'InvalidMockDir',
        message: `SF_MOCK_DIR [${mockDir}] not found`,
        cause: err,
        actions: [
          "If you're trying to mock agent behavior you must create the mock directory and add expected mock files to it.",
        ],
      });
    }

    if (!mockDirStat.isDirectory()) {
      throw SfError.create({
        name: 'InvalidMockDir',
        message: `SF_MOCK_DIR [${mockDir}] is not a directory`,
        actions: [
          "If you're trying to mock agent behavior you must create the mock directory and add expected mock files to it.",
        ],
      });
    }
    return mockDir;
  }
};

export function mockOrRequest<T>(
  connection: Connection,
  method: 'GET' | 'POST',
  url: string,
  body?: Record<string, unknown>
): Promise<T> {
  const mockDir = getMockDir();
  const logger = Logger.childFromRoot('mockOrRequest');
  if (mockDir) {
    logger.debug(`Mocking ${method} request to ${url} using ${mockDir}`);
    const mockResponseFileName = url.replace(/\//g, '_').replace(/^_/, '').split('?')[0] + '.json';
    const mockResponseFilePath = join(mockDir, mockResponseFileName);
    logger.debug(`Using mock file: ${mockResponseFilePath} for ${url}`);
    try {
      return Promise.resolve(JSON.parse(readFileSync(mockResponseFilePath, 'utf-8')) as T);
    } catch (err) {
      throw SfError.create({
        name: 'MissingMockFile',
        message: `SF_MOCK_DIR [${mockDir}] must contain a spec file with name ${mockResponseFileName}`,
        cause: err,
      });
    }
  } else {
    logger.debug(`Making ${method} request to ${url}`);
    switch (method) {
      case 'GET':
        return connection.requestGet<T>(url, { retry: { maxRetries: 3 } });
      case 'POST':
        if (!body) {
          throw SfError.create({
            name: 'InvalidBody',
            message: 'POST requests must include a body',
          });
        }
        return connection.requestPost<T>(url, body, { retry: { maxRetries: 3 } });
      default:
        throw SfError.create({
          name: 'InvalidMethod',
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          message: `Invalid method: ${method}`,
        });
    }
  }
}
