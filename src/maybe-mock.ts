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

async function readResponses<T extends nock.Body>(mockDir: string, url: string, logger: Logger): Promise<T[]> {
  const mockResponseName = url.replace(/\//g, '_').replace(/^_/, '').split('?')[0];
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
    throw SfError.create({
      name: 'MissingMockFile',
      message: `SF_MOCK_DIR [${mockDir}] must contain a spec file with name ${mockResponsePath} or ${mockResponsePath}.json`,
    });
  }

  logger.debug(`Using responses: ${responses.map((r) => JSON.stringify(r)).join(', ')}`);

  return responses;
}

/**
 * A class to act as an in-between the library's request, and the orgs response
 *
 * if `SF_MOCK_DIR` is set it will read from the directory, resolving files as API responses with nock
 *
 * if it is NOT set, it will hit the endpoint and use real server responses
 */
export class MaybeMock {
  private mockDir = getMockDir();
  private scopes = new Map<string, nock.Scope>();
  private logger: Logger;

  public constructor(private connection: Connection) {
    this.logger = Logger.childFromRoot(this.constructor.name);
  }

  /**
   * Will either use mocked responses, or the real server response, as the library/APIs become more feature complete,
   * there will be fewer mocks and more real responses
   *
   * @param {"GET" | "POST"} method
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
    if (this.mockDir) {
      this.logger.debug(`Mocking ${method} request to ${url} using ${this.mockDir}`);
      const responses = await readResponses<T>(this.mockDir, url, this.logger);
      const baseUrl = this.connection.baseUrl();
      const scope = this.scopes.get(baseUrl) ?? nock(baseUrl);
      this.scopes.set(baseUrl, scope);
      switch (method) {
        case 'GET':
          for (const response of responses) {
            scope.get(url).reply(200, response);
          }
          break;
        case 'POST':
          for (const response of responses) {
            scope.post(url, body).reply(200, response);
          }
          break;
        case 'DELETE':
          // Support mocked DELETE when needed
          break;
      }
    }

    this.logger.debug(`Making ${method} request to ${url}`);
    switch (method) {
      case 'GET':
        return this.connection.requestGet<T>(url, { retry: { maxRetries: 10 } });
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
