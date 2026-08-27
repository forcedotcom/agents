# Logging

How we log in this codebase. Follow it for every new or changed log line.

## The bar: the 3am test

Write every log line for an engineer who was paged at 3am to diagnose a production
incident in this service, has never seen the code, cannot run it or read the source, and
has ten minutes. If that person could not tell what happened, why, and what the system did
next from the log line alone, the line is not good enough yet.

## Use `CtxLogger`

Always log through `CtxLogger` (`src/ctxLogger.ts`) — never call `@salesforce/core`'s
`Logger` directly, and never hand-build message strings. Construct one logger per component
(named after that component) and call it like an ordinary logger:

```ts
import { CtxLogger } from './ctxLogger';

const logger = CtxLogger.child('AgentPublisher');

logger.debug('Publishing agent', { developerName });
logger.warn('Failed to trigger data library indexing', { libraryId, errName, errMsg });
```

For a module-scoped logger, use the lazy singleton the codebase already uses:

```ts
let logger: CtxLogger;
const getLogger = (): CtxLogger => {
  if (!logger) {
    logger = CtxLogger.child('AgentDataLibrary');
  }
  return logger;
};
```

Each level method — `trace` / `debug` / `info` / `warn` / `error` — takes a **static
message** and a **fields object**:

```ts
logger.error('Data library create request failed', {
  sourceType,
  statusCode,
  errName: wrapped.name,
  errMsg: wrapped.message,
});
```

`CtxLogger` does two things with that call, and this is the whole point of using it:

1. It emits the fields object as **structured fields** — the machine-parseable source of
   truth.
2. It renders those same fields into a human-readable `key=value, key=value` breadcrumb and
   appends it to the message after ` | `, so the emitted line reads
   `Data library create request failed | sourceType=KNOWLEDGE, statusCode=500, errName=..., errMsg=...`.

Because the message and the breadcrumb are produced from one fields object in one call, they
can never drift apart. Do not replicate this by hand with `Logger` — that reintroduces the
drift `CtxLogger` exists to prevent.

## Keep the message static; put variable data in fields

The message string must be **identical for every occurrence of the event** so it stays
greppable and aggregation/alerting works. All variable data goes in the fields object, never
interpolated into the message.

```ts
// Yes — static message, variable data in fields.
logger.warn('Agent is not yet published', { agentApiName });

// No — variable data baked into the message breaks aggregation.
logger.warn(`Agent ${agentApiName} is not yet published`);
```

Match the existing field-naming convention: **camelCase** (`developerName`, `libraryId`,
`statusCode`, `durationMs`, `errName`, `errMsg`). Reuse the same field name everywhere for
the same concept — inconsistent names break correlation.

### What the fields renderer does (so you log the right things)

`CtxLogger` renders the appended breadcrumb with these rules. Log values that survive them:

- **Non-primitives and empties are dropped** from the breadcrumb — `null`, `undefined`,
  empty string, empty array, and plain objects (including `Error` objects) render nothing.
  So never pass a raw `Error` as a field and expect it to read: log a **primitive
  projection** instead — `errName: wrapped.name, errMsg: wrapped.message` — and, for HTTP
  paths, `statusCode: getHttpStatusCode(error)`. Wrap first with `SfError.wrap(error)`.
- Arrays are joined with `;`; `Date`s render as ISO.
- Control characters (CR/LF/tab) in a value are collapsed to a space, so a field value can
  never forge a second log line.
- A value containing a `,` or `|` is quoted so the pair stays unambiguous.

## Pick the right level

Levels are contracts. Choose by who needs to act, not by how the code feels.

- **error** — an unexpected failure that needs a human. State what failed, why, and what
  happens next. Never generic ("An error occurred" is banned — name the specific failure).
- **warn** — degraded or unexpected but handled. State what might go wrong as a result.
- **info** — a meaningful milestone or state transition an on-call engineer cares about.
- **debug / trace** — a decision or behavior, useful only while actively diagnosing.

Expected failures are **not** errors. A 404, a "no records" lookup, a validation rejection,
an intentional timeout/abort — these are `debug`/`info`/`warn` at most. Reserve `error` for
the genuinely unexpected. (Example: on a not-yet-published agent we `debug` "not yet
published"; only a lookup that actually *failed* is a `warn`.)

## Where to log

- Log at **system boundaries** — service entry points, external/API calls, persistence,
  significant state transitions — not deep inside pure helpers or data transformers. The
  caller already has the context; deep logging just duplicates it and adds noise.
- Log the **decision, not just the data**: `threshold exceeded { value: 95, limit: 90, action: 'shutdown' }`
  beats `value is 95`.
- Log the **start** of an operation only when it can hang and you need "where did it stall?"
  debugging (e.g. a long poll). Otherwise one line on completion is cleaner.
- Include a **duration** (`durationMs`) on anything that can be slow.

## Answer these on every log line

Every `error` must answer all five; `info`/`warn` answer as many as apply:

- **Who** — which component/method is running, and what triggered it.
- **What** — the goal it was pursuing (for errors, what specifically it failed to do).
- **When/Where** — where in the flow this sits; could a reader place it on a sequence diagram?
- **Why** — for errors, the exception type/message and the offending data (scrubbed).
- **What happens next** — required on every `error`: rethrow? retry? fall back? no-op? Is the
  customer affected?

## Loops and batches: aggregate, don't log per item

Never log once per iteration. Make a loop observable by accumulating as it runs and emitting
**one** summary when it ends.

- Declare the accumulator (counts of processed/succeeded/failed/skipped, elapsed, involved
  ids) **before** the loop and **outside** any `try`, so it survives to both the summary and
  the catch.
- On normal completion, log one `info` summary with the full aggregate — capture it fully,
  don't truncate or sample (noise filters downstream; data absent at 3am cannot be rebuilt).
- If the loop throws, the handler logs that same aggregate alongside the error, so the reader
  sees how far it got ("failed on item 5000 of 10000; 4999 succeeded").

## Error handling

- **Don't log *and* re-throw.** Log where you handle (swallow) the error; re-throw where you
  don't — double-logging creates duplicate lines up the stack. Where the codebase logs a
  failure and still rethrows, it does so at `debug` and pairs it with a durable telemetry
  signal (`Lifecycle.getInstance().emitTelemetry({ eventName: '..._failed' })`); the
  telemetry, not the log, is the thing that gets acted on.
- Never let a swallowed error vanish silently. An empty `catch {}` on a path that matters
  needs at least a breadcrumb that distinguishes an **expected** outcome (e.g. an
  intentional `AbortError`/timeout) from a **real** failure.
- At `error` level include the exception detail (via the `errName`/`errMsg` projection
  above). Don't attach stack-trace noise to `warn`/`info`.

## Security and sensitive data

- Never log request or response bodies — they carry PII, tokens, and secrets. Log metadata:
  status code, size, duration.
- Scrub PII from field values.
- Security-sensitive operations (auth, permission changes, data export, admin actions) belong
  in a separate, immutable audit stream — not the application log.

## Hard rules

- No `error` may be safely ignorable. If it can be ignored, downgrade it.
- No message may say only "An error occurred" or any generic equivalent — name the failure.
- No log line may require reading the source to interpret.
- The logger must never throw and must never be the reason a request fails.
