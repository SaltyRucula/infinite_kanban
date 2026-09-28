export {
  OPENCODE_SERVER_LISTENING_REGEX,
  probeOpenCodeVersion,
  formatOpenCodeV2DetectedError,
  formatOpenCodeUnauthorizedError,
  redactOpenCodeSecrets,
  type OpenCodeVersionProbeResult,
} from './detect.js';

export {
  spawnOpenCodeServer,
  type OpenCodeProcessLike,
  type OpenCodeSpawnFn,
  type SpawnOpenCodeServerOptions,
  type SpawnedOpenCodeServer,
} from './spawn.js';

export {
  createV1Adapter,
  type OpenCodeClientLike,
  type OpenCodePromptBody,
  type CreateV1AdapterInput,
} from './v1-adapter.js';

// NOTE: `createV2Adapter` is intentionally NOT wired into `spawnOpenCodeServer`.
// It is exported here so it can be constructed directly (e.g. by tests, or
// by a future chunk once the form/permission watcher exists) — see the
// safety note on `createV2Adapter` itself for why the default spawn path
// must keep throwing on v2 for now.
export {
  createV2Adapter,
  buildV2PermissionRuleset,
  type CreateV2AdapterInput,
  type FetchLike,
  type V2PermissionRule,
} from './v2-adapter.js';

export type {
  CoreEvent,
  OpenCodeAdapter,
  PendingQuestion,
  SessionSpec,
  SessionSummary,
  TurnOpts,
  TurnResult,
} from './types.js';
