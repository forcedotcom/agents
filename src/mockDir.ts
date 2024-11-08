/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { resolve } from 'node:path';
import { type Stats, statSync } from 'node:fs';
import { SfError } from '@salesforce/core';
import { env } from '@salesforce/kit';

/**
 * If the `SF_MOCK_DIR` environment variable is set, resolve to an absolue path
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
        actions: ['If you\'re trying to mock agent behavior you must create the mock directory and add expected mock files to it.']
      });
    }
    
    if (!mockDirStat.isDirectory()) {
      throw SfError.create({
        name: 'InvalidMockDir',
        message: `SF_MOCK_DIR [${mockDir}] is not a directory`,
        actions: ['If you\'re trying to mock agent behavior you must create the mock directory and add expected mock files to it.']
      });
    }
    return mockDir;
  }
}