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

import { expect } from 'chai';
import { getEndpoint } from '../src/utils';

describe('getEndpoint', () => {
  describe('Workspace orgs (*.crm.dev) → dev.', () => {
    const workspaceUrls = [
      'https://orgfarm-5ba2aa1c0b.my.salesforce-com.86u0trm1dva10isua0s2i92gs0ax.wb.crm.dev',
      'https://something.wa.crm.dev',
      'https://something.wb.crm.dev',
      'https://something.wc.crm.dev',
      'https://something.ac.crm.dev',
      'https://myapp.develop.my.salesforce-app.workspace123.wc.crm.dev',
      'https://instance.my.salesforce-com.hostname.dnsPrefixaz.wb.crm.dev:6101',
      'http://foo.wa.crm.dev',
    ];

    workspaceUrls.forEach((url) => {
      it(`returns 'dev.' for ${url}`, () => {
        expect(getEndpoint(url)).to.equal('dev.');
      });
    });
  });

  describe('OrgFarm orgs (*.pc-rnd.salesforce.com | *.pc-rnd.force.com) → test.', () => {
    const orgFarmUrls = [
      'https://orgfarm-56f61201e7.test2.lightning.pc-rnd.force.com',
      'https://orgfarm-638ed60517.test1.my.pc-rnd.salesforce.com',
      'https://something.test1.lightning.pc-rnd.force.com',
      'https://something.test8.my.pc-rnd.salesforce.com',
      'https://instance.test1-uswest2.my.pc-rnd.salesforce.com',
      'https://instance.sdb6.my.pc-rnd.salesforce.com',
      'https://instance.sdb39.my.pc-rnd.salesforce.com',
      'https://instance.perf1-uswest2.my.pc-rnd.salesforce.com',
      'https://instance.perf1-useast2.my.pc-rnd.salesforce.com',
      'https://instance.dev1-uswest2.my.pc-rnd.salesforce.com',
      'https://instance.aws-dev4-uswest2.my.pc-rnd.salesforce.com',
      'https://foo.pc-rnd.salesforce.com:8443',
      'http://bar.pc-rnd.force.com',
    ];

    orgFarmUrls.forEach((url) => {
      it(`returns 'test.' for ${url}`, () => {
        expect(getEndpoint(url)).to.equal('test.');
      });
    });
  });

  describe('Production / sandbox / other → empty string', () => {
    const productionUrls = [
      'https://mydomain.my.salesforce.com',
      'https://mydomain.lightning.force.com',
      'https://mydomain.sandbox.my.salesforce.com',
      'https://mydomain.develop.my.salesforce.com',
      'https://mydomain.trailblaze.my.salesforce.com',
      'https://api.salesforce.com',
      'https://login.salesforce.com',
    ];

    productionUrls.forEach((url) => {
      it(`returns '' for ${url}`, () => {
        expect(getEndpoint(url)).to.equal('');
      });
    });
  });

  describe('case insensitivity', () => {
    it('treats host as case-insensitive for .crm.dev', () => {
      expect(getEndpoint('https://FOO.WB.CRM.DEV')).to.equal('dev.');
    });

    it('treats host as case-insensitive for .pc-rnd.force.com', () => {
      expect(getEndpoint('https://FOO.TEST1.MY.PC-RND.SALESFORCE.COM')).to.equal('test.');
    });
  });

  describe('SF_TEST_API env override (true | test | dev | false)', () => {
    const productionUrl = 'https://mydomain.my.salesforce.com';
    let saved: string | undefined;

    afterEach(() => {
      if (saved !== undefined) {
        process.env.SF_TEST_API = saved;
      } else {
        delete process.env.SF_TEST_API;
      }
    });

    it('SF_TEST_API=true forces test.', () => {
      saved = process.env.SF_TEST_API;
      process.env.SF_TEST_API = 'true';
      expect(getEndpoint(productionUrl)).to.equal('test.');
    });

    it('SF_TEST_API=test forces test.', () => {
      saved = process.env.SF_TEST_API;
      process.env.SF_TEST_API = 'test';
      expect(getEndpoint(productionUrl)).to.equal('test.');
    });

    it('SF_TEST_API=dev forces dev.', () => {
      saved = process.env.SF_TEST_API;
      process.env.SF_TEST_API = 'dev';
      expect(getEndpoint(productionUrl)).to.equal('dev.');
    });

    it('SF_TEST_API is case-insensitive (TEST → test.)', () => {
      saved = process.env.SF_TEST_API;
      process.env.SF_TEST_API = 'TEST';
      expect(getEndpoint(productionUrl)).to.equal('test.');
    });

    it('SF_TEST_API unset uses URL-based detection', () => {
      saved = process.env.SF_TEST_API;
      delete process.env.SF_TEST_API;
      expect(getEndpoint(productionUrl)).to.equal('');
      expect(getEndpoint('https://foo.wb.crm.dev')).to.equal('dev.');
    });

    it('SF_TEST_API=false or other value falls through to URL-based detection', () => {
      saved = process.env.SF_TEST_API;
      process.env.SF_TEST_API = 'false';
      expect(getEndpoint(productionUrl)).to.equal('');
      process.env.SF_TEST_API = 'production';
      expect(getEndpoint(productionUrl)).to.equal('');
    });
  });
});
