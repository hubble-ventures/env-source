// Public library surface. Import the pure core to parse/compile/materialize a
// `.env.source`, the providers to talk to a vault, and the commands to run the
// discover → resolve → write pipeline over a workspace.
export * from "./core/index.js";
export {
  InfisicalApiProvider,
  InfisicalCliProvider,
  infisicalCliAvailable,
  type InfisicalApiOptions,
  type InfisicalCliOptions,
} from "./providers/infisical.js";
export { withRetry, type RetryOptions } from "./providers/retry.js";
export {
  resolveProviders,
  type ResolveContext,
} from "./providers/registry.js";
export {
  discoverManifests,
  gitRelativePath,
  loadConfig,
  loadManifest,
  readTextAtRef,
  resolveRef,
  selectManifests,
  type LoadedConfig,
  type ManifestFile,
} from "./adapters/workspace.js";
export {
  pullToFiles,
  resolveManifests,
  type PullOutcome,
  type ResolvedManifest,
  type ResolveOptions,
} from "./commands/pull.js";
export {
  validateAll,
  hasErrorResults,
  type ValidateOptions,
  type ValidateResult,
} from "./commands/validate.js";
export {
  diffAll,
  hasChanges,
  diffTotals,
  type DiffOptions,
  type ManifestDiff,
} from "./commands/diff.js";
export { runWithEnv, type RunOptions } from "./commands/run.js";
export {
  migrateManifest,
  type MigratedFile,
  type MigrationResult,
} from "./commands/migrate.js";
export { listManifests, type ManifestSummary } from "./commands/list.js";
export {
  writeSecretFile,
  profileManifestPath,
  resolvedManifestPath,
} from "./adapters/workspace.js";
