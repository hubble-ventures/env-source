// Shared types for the pure core. Nothing here performs I/O; providers (the
// adapters that actually talk to Infisical, 1Password, the process env, …)
// implement the {@link Provider} interface and are supplied from the outside.

/** Severity of a structured problem surfaced while parsing/compiling/validating. */
export type IssueLevel = "error" | "warning";

/** A single structured problem, addressable by a stable machine `code`. */
export type Issue = {
  level: IssueLevel;
  /** Stable machine code, e.g. `duplicate_target`, `missing_in_provider`. */
  code: string;
  message: string;
  /** 1-based line in the `.env.source` file the issue concerns, when known. */
  line?: number;
  /** Emitted variable the issue concerns, when applicable. */
  key?: string;
};

/**
 * One source in a variable's resolution chain: a provider and where inside it to
 * look. A variable may declare several, tried in order until one has a value.
 */
export type DeclSource = {
  /** Provider id from the decorator (e.g. `infisical`). */
  provider: string;
  /** Provider container path from the decorator (e.g. `/payments/stripe`). */
  path?: string;
  /**
   * Source key inside the provider container. `undefined` means the source key
   * equals the declaration's `targetVar` (no aliasing).
   */
  sourceKey?: string;
  /**
   * Environments in which this source is consulted. `undefined` means *all*
   * environments.
   */
  environments?: string[];
};

/**
 * One declaration parsed from a `.env.source` file: an emitted variable plus its
 * ordered source chain (which providers to try, from where). This is the raw
 * authoring surface — {@link compile} turns it into a {@link CompiledBinding} for
 * a specific environment. A declaration with no sources is a *literal*: its value
 * is `default`.
 */
export type Declaration = {
  /** Emitted environment-variable name (left of `=`). */
  targetVar: string;
  /**
   * Baked-in fallback value from the right of `=`, used when no source yields a
   * value. `undefined` when the RHS is empty or a `<placeholder>`.
   */
  default?: string;
  /** Ordered provider sources; empty for a literal. */
  sources: DeclSource[];
  /** 1-based line of the assignment, for diagnostics. */
  line: number;
};

/** A `.env.source` file parsed into declarations plus any structural issues. */
export type ParsedManifest = {
  declarations: Declaration[];
  issues: Issue[];
};

/** A resolved source: a concrete provider + container path + key to read. */
export type CompiledSource = {
  /** Provider id. */
  provider: string;
  /** Provider container path (`""` when the decorator omitted it — a defect). */
  path: string;
  /** Key name as stored in the provider. */
  sourceKey: string;
};

/**
 * A declaration resolved for one concrete environment. `compile` produces a
 * flat, sorted, collision-free list of these; pull / validate consume them.
 *
 * `sources` holds only the sources active in the compiled environment, in
 * priority order. An empty `sources` means the binding resolves to {@link default}
 * (a literal or an out-of-scope fallback), and is dropped when it has none.
 */
export type CompiledBinding = {
  /** Environment-variable name to emit. */
  targetVar: string;
  /** Ordered provider sources consulted for this env; empty = default-only. */
  sources: CompiledSource[];
  /** Baked-in fallback default, if any. */
  default?: string;
};

/** A manifest compiled for a single environment. */
export type CompiledManifest = {
  environment: string;
  /** Output filename (bare, no separators), relative to the manifest directory. */
  output: string;
  bindings: CompiledBinding[];
};

/**
 * A secret provider, abstracted. The core depends only on this interface; the
 * Infisical adapter implements it and tests supply fakes. A provider never
 * returns a value for a key that does not exist.
 */
export interface Provider {
  readonly id: string;
  /**
   * Read values for the requested keys at a container path, for an environment.
   * Keys that do not exist are omitted from the result (never faked).
   */
  read(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Record<string, string>>;
  /**
   * Assert which of the requested keys EXIST at a path, without surfacing their
   * values. Used by `validate` to check a manifest against the live provider
   * with the least possible exposure.
   */
  peek(environment: string, path: string, keys: string[]): Promise<Set<string>>;
}

/** A binding present in both manifests but sourced differently. */
export type BindingChange = {
  targetVar: string;
  from: CompiledBinding;
  to: CompiledBinding;
};

/** A scalar manifest setting that changed (e.g. `output`). */
export type SettingChange = { field: string; from: string; to: string };

/** The structural delta between two compiled manifests, keyed by emitted var. */
export type ManifestDelta = {
  added: CompiledBinding[];
  removed: CompiledBinding[];
  changed: BindingChange[];
  settings: SettingChange[];
};
