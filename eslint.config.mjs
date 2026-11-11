import config from 'eslint-config-salesforce-typescript';

// The base config ignores lib/**, but wireit caches compiled .d.ts output under
// .wireit/**; those build artifacts must not be linted. src/scorerSpecSchema.generated.ts is
// generated from the ScorerSpec type at build time (see scripts/gen-scorer-schema.mjs).
export default [...config, { ignores: ['.wireit/**', 'src/scorerSpecSchema.generated.ts'] }];
