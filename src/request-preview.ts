/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { Logger, SfError } from '@salesforce/core';
import got from 'got';

export class RequestPreview {
  private logger: Logger;

  public constructor() {
    this.logger = Logger.childFromRoot(this.constructor.name);
  }

  public async request<Response>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body: Record<string, unknown> | undefined,
    headers?: Record<string, string>
  ): Promise<Response> {
    this.logger.debug(`Making ${method} request to ${url}`);

    switch (method) {
      case 'GET':
        return got.get(url, { headers }).json();
      case 'POST':
        if (!body) {
          throw SfError.create({
            name: 'InvalidBody',
            message: 'POST requests must include a body',
          });
        }
        return got.post(url, { headers, json: body }).json();
      case 'DELETE':
        return got.delete(url, { headers }).json();
    }
  }
}
