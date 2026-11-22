# cltWrongTestScope

Conversation-level test spec has `testScope` '%s'. Set `testScope: CONVERSATION_LEVEL`, or remove `testScope` to author a turn-level spec.

# cltUnknownField

Conversation-level test spec has an unrecognized field '%s' in `%s`. Allowed fields there: %s. Check the spelling; field names are case-sensitive.

# cltTurnLevelField

Conversation-level test case %s uses the turn-level field '%s'. Conversation-level tests are driven by a `conversationGoal`; remove '%s' or remove `testScope: CONVERSATION_LEVEL` to author a turn-level spec.

# cltSpecNotObject

Conversation-level test spec must be a YAML mapping with `name`, `testScope`, and `testCases`. Check that the file isn't empty and doesn't start with a list.

# cltFieldNotString

Conversation-level test spec field `%s` must be a string, but it's %s. Quote the value in the YAML (for example `"2026"`).

# cltMissingName

Conversation-level test spec must define a non-blank `name:`.

# cltUnsupportedSubjectType

Conversation-level test spec has `subjectType` '%s'. Conversation-level tests support only `subjectType: AGENT`.

# cltAgentIdentity

Conversation-level test spec must define exactly one of `subjectName:` (a published agent) or `project:` (a draft agent).

# cltProjectIncomplete

Conversation-level test spec `project:` must define both a non-blank `projectId` and `projectVersionId`.

# cltSubjectVersionWithProject

Conversation-level test spec sets `subjectVersion:` together with `project:`. `subjectVersion` applies only to `subjectName`; the draft version comes from `project.projectVersionId`.

# cltInvalidSimulation

Conversation-level test spec has an invalid `simulation:` block. `enabled` must be true or false, and each `excludedActions` entry needs a non-blank `subagent` and a non-empty `actions` list of action names.

# cltAgentNotResolved

Conversation-level test spec names agent '%s', but no resolved agentId and agentVersionId were passed to the converter. Resolve the published agent first and pass its IDs.

# cltMissingTestCases

Conversation-level test spec must define at least one test case under `testCases:`.

# cltTooManyTestCases

Conversation-level test spec has %s test cases. A spec can have at most %s. Split the cases across several specs.

# cltMissingConversationGoal

Conversation-level test case %s must define a non-blank `conversationGoal:`.

# cltInvalidPersona

Conversation-level test spec has `persona` '%s'. Must be one of: %s.

# cltInvalidEvaluationMode

Conversation-level test spec has `evaluationMode` '%s'. Must be one of: %s.

# cltInvalidMaxTurns

Conversation-level test spec has `maxTurns` '%s'. It must be a whole number from 1 to %s.

# cltContextVariableMissingName

Conversation-level test case %s has a context variable without a non-blank `name:`.

# cltContextVariableDuplicate

Conversation-level test case %s defines context variable '%s' more than once. `X` and `$Context.X` name the same variable; keep one.

# cltContextVariableInvalidValue

Conversation-level test case %s context variable '%s' must have a string `value:`, but it's %s. Quote values that look like numbers or true/false (for example `value: "02134"`).

# cltConnectionsMissingSurfaceType

Conversation-level test case %s defines `connections:` without a non-blank `surfaceType:`. Set it to one of the agent's connection types (for example `Messaging`).

# cltScorerMissingName

Conversation-level test case %s has a scorer without a non-blank `name:`.

# cltScorerMissingExpected

Conversation-level scorer '%s' on test case %s requires an `expected:` value.

# cltScorerExpectedNotString

Conversation-level scorer '%s' on test case %s has a non-string `expected:` (%s). Quote the value in the YAML.

# cltScorerWrongTarget

Conversation-level scorer '%s' on test case %s isn't supported %s. Supported %s: %s. Use '%s' %s.

# cltScorerNotAvailable

Conversation-level scorer '%s' on test case %s (%s in Testing Center) isn't available from the CLI yet. The conversation-level test APIs don't score it correctly. Remove it, or run this check in Testing Center.

# cltUnsupportedScorer

Conversation-level scorer '%s' on test case %s isn't supported for conversation-level tests. Supported scorers %s: %s.

# cltEvaluationModeIgnored

`evaluationMode` applies only to saved conversation-level suites. It's ignored when running without saving.
