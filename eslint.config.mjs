import config from 'eslint-config-salesforce-typescript';

// The base config ignores lib/**, but wireit caches compiled .d.ts output under
// .wireit/**; those build artifacts must not be linted.
export default [...config, { ignores: ['.wireit/**'] }];
