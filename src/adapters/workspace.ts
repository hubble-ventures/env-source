import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type EnvSourceConfig, parseConfig } from "../core/config.js";
import { parseEnvSource } from "../core/parse.js";
import type { ParsedManifest } from "../core/types.js";

const CONFIG_FILE = "env-source.toml";
const MANIFEST_FILE = ".env.source";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".turbo", "coverage"]);

/**
 * Whether `dir` is the root of a *different* checkout — a linked git worktree, a
 * submodule, or a nested clone — and so not part of this workspace.
 *
 * Tools that place worktrees inside the repo (Claude Code defaults to
 * `.claude/worktrees/<name>`) otherwise get every manifest discovered once per
 * worktree: 11 real manifests became 134, and a pull fanned out to ~910 vault
 * reads and wrote `.env.secrets` into checkouts on unrelated branches.
 *
 * The test is the presence of a `.git` entry, which for a linked worktree or a
 * submodule is a *file* (a gitdir pointer) rather than a directory. Checking for
 * the entry either way costs one `existsSync` per directory and is right no
 * matter how the path came to be ignored — notably, matching `.gitignore` would
 * not have caught the case above, where `.claude/worktrees/` was ignored through
 * `.git/info/exclude`.
 */
function isNestedCheckout(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** A discovered `.env.source` manifest and where it lives. */
export type ManifestFile = {
  /** Stable id derived from the containing directory (repo-relative, or `root`). */
  id: string;
  /** Absolute path to the `.env.source` file. */
  path: string;
  /** Absolute directory the manifest (and its output `.env`) lives in. */
  dir: string;
};

/** Where the root config was found and its validated contents. */
export type LoadedConfig = {
  /** Directory containing `env-source.toml` (the workspace root). */
  root: string;
  config: EnvSourceConfig;
};

/**
 * Find and load the root `env-source.toml`, walking up from `startDir`. Throws a
 * clear error when none is found — every command needs one for provider context.
 */
export function loadConfig(startDir: string = process.cwd()): LoadedConfig {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) {
      const raw = parseToml(readFileSync(candidate, "utf8"));
      return { root: dir, config: parseConfig(raw) };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find ${CONFIG_FILE} in ${startDir} or any parent directory`
      );
    }
    dir = parent;
  }
}

/** Discover every `.env.source` under `root`, skipping build/vendor directories. */
export function discoverManifests(root: string): ManifestFile[] {
  const found: ManifestFile[] = [];
  walk(resolve(root), (filePath) => {
    if (basename(filePath) !== MANIFEST_FILE) return;
    const dir = dirname(filePath);
    found.push({ id: manifestId(root, dir), path: filePath, dir });
  });
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Read and parse a discovered manifest. With a `profile`, a sibling
 * `.env.<profile>.source` in the same directory overrides the base file when it
 * exists; otherwise the base `.env.source` is used. `knownProviders` (from the
 * config's `[providers.*]`) lets the parser tell a provider from a source key.
 */
export function loadManifest(
  file: ManifestFile,
  profile?: string,
  knownProviders?: Iterable<string>
): ParsedManifest {
  const path =
    profile && existsSync(profileManifestPath(file.dir, profile))
      ? profileManifestPath(file.dir, profile)
      : file.path;
  return parseEnvSource(readFileSync(path, "utf8"), knownProviders);
}

/** Path of a profile-suffixed manifest, e.g. `.env.deploy.source`. */
export function profileManifestPath(dir: string, profile: string): string {
  return join(dir, `.env.${profile}.source`);
}

/** The absolute path {@link loadManifest} would read for this file + profile. */
export function resolvedManifestPath(
  file: ManifestFile,
  profile?: string
): string {
  return profile && existsSync(profileManifestPath(file.dir, profile))
    ? profileManifestPath(file.dir, profile)
    : file.path;
}

/**
 * Restrict discovered manifests to the requested ids (all when `ids` is empty).
 *
 * An id is either a full manifest id (`infra/postgres`) or, as a shorthand, the
 * name of its leaf directory (`postgres`). The shorthand must identify exactly
 * one manifest: matching it against every same-named directory made `pull` write
 * secrets to paths the caller never named. When it is ambiguous we fail and ask
 * for the full id rather than guessing, or worse, pulling all of them.
 */
export function selectManifests(
  files: ManifestFile[],
  ids: string[]
): ManifestFile[] {
  if (ids.length === 0) return files;

  const selected = new Map<string, ManifestFile>();
  for (const id of ids) {
    const exact = files.find((f) => f.id === id);
    if (exact) {
      selected.set(exact.id, exact);
      continue;
    }
    const byName = files.filter((f) => basename(f.dir) === id);
    if (byName.length > 1) {
      throw new Error(
        `'${id}' is ambiguous — it matches ${byName.length} manifests: ${byName
          .map((f) => f.id)
          .join(", ")}. Use the full id.`
      );
    }
    for (const match of byName) selected.set(match.id, match);
  }
  // Preserve discovery order rather than the order the ids were given.
  return files.filter((f) => selected.has(f.id));
}

/**
 * Resolve `ref` to a fixed commit SHA, or `null` if it doesn't resolve. Diffing
 * pins the base to this SHA once so every manifest is read from the same tree,
 * even if the branch moves mid-run.
 */
export function resolveRef(ref: string, cwd?: string): string | null {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...(cwd ? { cwd } : {}) }
    ).trim();
  } catch {
    return null;
  }
}

/** The path of `absPath` relative to the git repo root, in posix form. */
export function gitRelativePath(absPath: string, cwd?: string): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...(cwd ? { cwd } : {}),
    }).trim();
    return relative(top, absPath).split(sep).join("/");
  } catch {
    return null;
  }
}

/**
 * Read a file's content at a git ref (for diffing a PR against its base).
 * Returns `null` only when git proves the path was absent at that commit (a newly
 * added manifest, rendered as an all-added diff); any other git failure throws
 * rather than being misread as "absent".
 */
export function readTextAtRef(
  ref: string,
  repoRelativePath: string,
  cwd?: string
): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${repoRelativePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
      // Pin the locale so the stderr matched below is always English.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/does not exist in|exists on disk, but not in/i.test(stderr)) return null;
    throw error;
  }
}

/**
 * Write secret content to `path` atomically and owner-only. The content is
 * written to a fresh temp file created at mode 0600, then renamed over the
 * destination — so the secret is never momentarily visible at a looser mode
 * (which a plain overwrite + chmod would allow), and a crash mid-write never
 * replaces a good file with a partial one.
 */
export function writeSecretFile(path: string, content: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp); // best-effort cleanup of the temp file on failure
    } catch {
      /* already gone */
    }
    throw error;
  }
}

function manifestId(root: string, dir: string): string {
  const rel = relative(resolve(root), dir);
  if (rel === "" || rel === ".") return "root";
  return rel.split(sep).join("/");
}

function walk(dir: string, onFile: (path: string) => void): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip rather than abort discovery
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Never descend into another checkout. The workspace root itself is not
      // subject to this — `walk` is only ever called on directories below it.
      if (isNestedCheckout(full)) continue;
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}
