import { compile } from "../core/compile.js";
import { diffCompiled, isEmptyDelta } from "../core/diff.js";
import { parseEnvSource } from "../core/parse.js";
import type { CompiledManifest, ManifestDelta } from "../core/types.js";
import {
  discoverManifests,
  gitRelativePath,
  type LoadedConfig,
  loadManifest,
  type ManifestFile,
  readTextAtRef,
  resolvedManifestPath,
  resolveRef,
  selectManifests,
} from "../adapters/workspace.js";

export type DiffOptions = {
  loaded: LoadedConfig;
  /** Git ref (branch/sha/tag) to compare against, e.g. `origin/main`. */
  base: string;
  environment?: string;
  /** Manifest profile — loads `.env.<profile>.source` where present. */
  profile?: string;
  ids?: string[];
};

export type ManifestDiff = {
  file: ManifestFile;
  delta: ManifestDelta;
  /** True when the manifest did not exist at the base ref (newly added). */
  isNew: boolean;
};

/**
 * Diff every selected head manifest against its state at `base`, for one
 * environment. Both sides compile with the current `env-source.toml` (provider
 * context is committed and non-secret), so the delta reflects only manifest edits.
 *
 * A manifest absent at the base renders as all-added. Deletions are not
 * discovered here — diffing covers additions and modifications, the change
 * surface a reviewer cares about.
 */
export function diffAll(options: DiffOptions): ManifestDiff[] {
  const root = options.loaded.root;
  // Resolve the base to a fixed commit once: rejects a bad `--base` up front and
  // pins every read to one tree even if the branch moves mid-run.
  const baseSha = resolveRef(options.base, root);
  if (!baseSha) throw new Error(`Unknown base ref: ${options.base}`);

  const files = selectManifests(discoverManifests(root), options.ids ?? []);
  const compileOpts = options.environment
    ? { environment: options.environment }
    : {};

  const diffs: ManifestDiff[] = [];
  for (const file of files) {
    const head = compile(
      loadManifest(file, options.profile),
      options.loaded.config,
      compileOpts
    );

    // Diff the same file (profile variant included) on both sides.
    const resolvedPath = resolvedManifestPath(file, options.profile);
    const repoRelative = gitRelativePath(resolvedPath, root);
    const baseRaw =
      repoRelative === null ? null : readTextAtRef(baseSha, repoRelative, root);
    const isNew = baseRaw === null;
    // An absent base has head's settings but no bindings, so the whole surface
    // renders as added (no phantom settings diff).
    const base: CompiledManifest = isNew
      ? { ...head, bindings: [] }
      : compile(parseEnvSource(baseRaw), options.loaded.config, compileOpts);

    diffs.push({ file, delta: diffCompiled(base, head), isNew });
  }
  return diffs;
}

export function hasChanges(diffs: ManifestDiff[]): boolean {
  return diffs.some((d) => !isEmptyDelta(d.delta));
}

/** Totals across every manifest diff, for CI outputs. */
export function diffTotals(diffs: ManifestDiff[]): {
  added: number;
  removed: number;
  changed: number;
} {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const { delta } of diffs) {
    added += delta.added.length;
    removed += delta.removed.length;
    changed += delta.changed.length;
  }
  return { added, removed, changed };
}
