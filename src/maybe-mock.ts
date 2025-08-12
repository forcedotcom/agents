/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { join, resolve } from 'node:path';
import { type Stats, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { Connection, Logger, SfError } from '@salesforce/core';
import { env } from '@salesforce/kit';
import nock from 'nock';

type HttpHeaders = {
  [name: string]: string;
};
/**
 * If the `SF_MOCK_DIR` environment variable is set, resolve to an absolute path
 * and ensure the directory exits, then return the path.
 *
 * NOTE: THIS SHOULD BE MOVED TO SOME OTHER LIBRARY LIKE `@salesforce/kit`.
 *
 * @returns the absolute path to an existing directory used for mocking behavior
 */
const getMockDir = (): string | undefined => {
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

async function readJson<T extends nock.Body>(path: string): Promise<T | undefined> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function readPlainText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf-8');
}

async function readDirectory<T extends nock.Body>(path: string): Promise<T[] | undefined> {
  const files = await readdir(path);
  const promises = files.map((file) => {
    if (file.endsWith('.json')) {
      return readJson(join(path, file));
    } else {
      return readPlainText(join(path, file));
    }
  });
  return (await Promise.all(promises)).filter((r): r is T => !!r);
}

async function readResponses<T extends nock.Body>(mockDir: string, url: string, logger: Logger): Promise<T[] | null> {
  const mockResponseName = url.replace(/\//g, '_').replace(/:/g, '_').replace(/^_/, '').split('?')[0];
  const mockResponsePath = join(mockDir, mockResponseName);

  // Try all possibilities for the mock response file
  const responses = (
    await Promise.all([
      readJson(`${mockResponsePath}.json`)
        .then((r) => {
          logger.debug(`Found JSON mock file: ${mockResponsePath}.json`);
          return r;
        })
        .catch(() => undefined),
      readPlainText(mockResponsePath)
        .then((r) => {
          logger.debug(`Found plain text mock file: ${mockResponsePath}`);
          return r;
        })
        .catch(() => undefined),
      readDirectory(mockResponsePath)
        .then((r) => {
          logger.debug(`Found directory of mock files: ${mockResponsePath}`);
          return r;
        })
        .catch(() => undefined),
    ])
  )
    .filter((r): r is T[] => !!r)
    .flat();

  if (responses.length === 0) {
    logger.debug(`No mock file found for ${mockResponsePath} - will use real API endpoint`);
    return null;
  }

  logger.debug(`Using responses: ${responses.map((r) => JSON.stringify(r)).join(', ')}`);

  return responses;
}

/**
 * A class to act as an intelligent proxy between your application and Salesforce APIs.
 *
 * **Behavior:**
 * - If `SF_MOCK_DIR` is set AND a mock file exists for the specific endpoint → Mock the response
 * - If `SF_MOCK_DIR` is set BUT no mock file exists for the endpoint → Make real API call
 * - If `SF_MOCK_DIR` is not set → Make real API calls
 *
 * **VS Code Extension Friendly:**
 * Environment variables are checked at runtime, not import time. This allows VS Code extensions
 * to set `SF_MOCK_DIR` dynamically during debugging without import-time errors.
 *
 * This allows you to selectively mock only the endpoints you have mock files for,
 * while letting other endpoints hit the real API. Perfect for mixed development workflows.
 *
 * **Examples**
 *
 * Basic usage:
 * ```typescript
 * process.env.SF_MOCK_DIR = 'test/mocks';
 * const maybeMock = new MaybeMock(connection);
 *
 * // If test/mocks/api_trace_123.json exists → mocked
 * const trace = await maybeMock.request('GET', '/api/trace/123');
 *
 * // If test/mocks/einstein_ai-agent_v1_sessions.json exists → mocked
 * const session = await maybeMock.request('POST', '/einstein/ai-agent/v1/sessions', body);
 *
 * // If no mock file exists for this endpoint → real API call
 * const liveData = await maybeMock.request('GET', '/some/other/endpoint');
 * ```
 *
 * VS Code Extension usage:
 * ```typescript
 * import * as vscode from 'vscode';
 *
 * // Set environment variable at runtime (extension friendly!)
 * const debugCommand = vscode.commands.registerCommand('extension.debugWithMocks', () => {
 *   const mockDir = path.join(context.extensionPath, 'debug-mocks');
 *   process.env.SF_MOCK_DIR = mockDir;  // Runtime setting works!
 *
 *   const maybeMock = new MaybeMock(connection);  // No import-time errors
 *   // ... rest of debugging logic
 * });
 * ```
 *
 * **File Naming Convention:**
 * URLs are converted to filenames by replacing `/` with `_` and `:` with `_`:
 * - `/api/trace/123` → `api_trace_123.json`
 * - `https://api.salesforce.com/einstein/ai-agent/v1/sessions` → `https___api.salesforce.com_einstein_ai-agent_v1_sessions.json`
 */
export class MaybeMock {
  private scopes = new Map<string, nock.Scope>();
  private logger: Logger;

  public constructor(private connection: Connection) {
    this.logger = Logger.childFromRoot(this.constructor.name);
  }

  /**
   * Get the mock directory at runtime (VS Code extension friendly).
   * This checks the SF_MOCK_DIR environment variable when called, not at import time.
   */
  private static getRuntimeMockDir(): string | undefined {
    return getMockDir();
  }

  /**
   * Will either use mocked responses, or the real server response, as the library/APIs become more feature complete,
   * there will be fewer mocks and more real responses
   *
   * @param {"GET" | "POST" | "DELETE"} method
   * @param {string} url
   * @param {nock.RequestBodyMatcher} body
   * @returns {Promise<T>}
   */
  public async request<T extends nock.Body>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body: nock.RequestBodyMatcher = {},
    headers: HttpHeaders = {}
  ): Promise<T> {
    // Check for mock directory at runtime (VS Code extension friendly)
    const mockDir = MaybeMock.getRuntimeMockDir();

    if (mockDir) {
      this.logger.debug(`Checking for mock file for ${method} request to ${url} in ${mockDir}`);
      const responses = await readResponses<T>(mockDir, url, this.logger);

      // If mock file exists, set up nock interceptor
      if (responses) {
        this.logger.debug(`Found mock file - setting up nock interceptor for ${url}`);

        // For agent APIs, we need to use the api.salesforce.com base, not the org-specific URL
        const baseUrl = url.startsWith('https://api.salesforce.com')
          ? 'https://api.salesforce.com'
          : this.connection.baseUrl();

        const scope = this.scopes.get(baseUrl) ?? nock(baseUrl);

        // Look up status code to determine if it's successful or not
        const getCode = (response: T): number =>
          typeof response === 'object' && 'status' in response && typeof response.status === 'number'
            ? response.status
            : 200;

        // Handle SFAP endpoint formatting
        const cleanUrl = url.replace('https://api.salesforce.com', '');
        this.scopes.set(baseUrl, scope);

        switch (method) {
          case 'GET':
            for (const response of responses) {
              scope.get(cleanUrl).reply(getCode(response), response);
            }
            break;
          case 'POST':
            for (const response of responses) {
              scope.post(cleanUrl, body).reply(getCode(response), response);
            }
            break;
          case 'DELETE':
            for (const response of responses) {
              scope.delete(cleanUrl).reply(getCode(response), response);
            }
            break;
        }

        // Continue to make the request - nock will intercept it
      } else {
        this.logger.debug(`No mock file found for ${url} - will make real API call`);
      }
    }

    this.logger.debug(`Making ${method} request to ${url}`);
    switch (method) {
      case 'GET':
        return this.connection.requestGet<T>(url, { retry: { maxRetries: 3 } });
      case 'POST':
        if (!body) {
          throw SfError.create({
            name: 'InvalidBody',
            message: 'POST requests must include a body',
          });
        }
        return this.connection.requestPost<T>(url, body, { retry: { maxRetries: 3 } });
      case 'DELETE':
        // We use .request() rather than .requestDelete() so that we can pass in the headers
        return this.connection.request<T>(
          {
            method: 'DELETE',
            url,
            headers,
          },
          { retry: { maxRetries: 3 } }
        );
    }
  }
}
