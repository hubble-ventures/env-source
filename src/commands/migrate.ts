// Convert a legacy infisicml `secrets.json` manifest into `.env.source` files.
//
// The legacy format groups keys by Infisical folder and expresses aliases as a
// single-pair map. env-source expresses each key as a decorated assignment.
// Profiles become sibling `.env.<profile>.source` files. Concepts env-source
// does not (yet) model — `environments.*.optionalKeys` and `ci` — are reported
// as warnings rather than silently dropped, so nothing is lost quietly.

/** A single `.env.source` file the migration would write. */
export type MigratedFile = {
  /** Bare filename, e.g. `.env.source` or `.env.deploy.source`. */
  filename: string;
  /** The `.env.source` content. */
  content: string;
};

export type MigrationResult = {
  files: MigratedFile[];
  /** Un-migratable concepts the operator must handle by hand. */
  warnings: string[];
};

// A key entry is a bare key, a `{ SOURCE: TARGET }` alias (string value), or a
// nested sub-folder `{ subfolder: [ ...entries ] }` (array value). The legacy
// format nests folders arbitrarily deep (e.g. apple → paddlesup → keys).
type KeyEntry = string | { [k: string]: string | KeyEntry[] };
type SecretsBlock = Record<string, KeyEntry[]>;
type LegacyManifest = {
  secrets?: SecretsBlock[];
  profiles?: Record<string, { secrets?: SecretsBlock[] }>;
  environments?: Record<string, { optionalKeys?: string[] }>;
  ci?: unknown;
};

/**
 * Convert a parsed legacy `secrets.json` object into one or more `.env.source`
 * files plus a list of warnings. Pure — the caller decides whether to write.
 */
export function migrateManifest(raw: unknown): MigrationResult {
  const manifest = raw as LegacyManifest;
  const warnings: string[] = [];
  const files: MigratedFile[] = [];

  if (manifest.secrets) {
    files.push({
      filename: ".env.source",
      content: renderBlocks(manifest.secrets),
    });
  }

  for (const [name, profile] of Object.entries(manifest.profiles ?? {})) {
    if (profile.secrets) {
      files.push({
        filename: `.env.${name}.source`,
        content: renderBlocks(profile.secrets),
      });
    }
  }

  for (const [env, cfg] of Object.entries(manifest.environments ?? {})) {
    if (cfg.optionalKeys?.length) {
      warnings.push(
        `environments.${env}.optionalKeys is not modeled — mark these optional-in-${env} by hand or give them a default: ${cfg.optionalKeys.join(", ")}`
      );
    }
  }
  if (manifest.ci !== undefined) {
    warnings.push(
      "`ci` (skipWhenEnv / stubInCi) is not modeled — replicate that behavior in your workflow"
    );
  }

  return { files, warnings };
}

/** Render an ordered list of folder blocks into decorated `.env.source` text. */
function renderBlocks(blocks: SecretsBlock[]): string {
  const lines: string[] = [
    "# Migrated from secrets.json by `env-source migrate`.",
    "# Review paths and add environment scopes/defaults as needed.",
    "",
  ];
  for (const block of blocks) {
    for (const [folder, entries] of Object.entries(block)) {
      emitFolder(`/${folder.replace(/^\/+/, "")}`, entries, lines);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Emit every key under `path`, recursing into nested sub-folders so a nested
 * block like `apple → paddlesup → [KEYS]` becomes path `/apple/paddlesup`.
 */
function emitFolder(path: string, entries: KeyEntry[], lines: string[]): void {
  for (const entry of entries) {
    if (typeof entry === "string") {
      pushKey(lines, path, entry, entry);
      continue;
    }
    const [pair] = Object.entries(entry);
    if (!pair) throw new Error("empty key entry in secrets.json");
    const [key, value] = pair;
    if (Array.isArray(value)) {
      // Nested sub-folder: descend, extending the container path.
      emitFolder(`${path}/${key}`, value, lines);
    } else {
      // `{ SOURCE: TARGET }` alias — the emitted var differs from the vault key.
      pushKey(lines, path, key, value);
    }
  }
}

function pushKey(
  lines: string[],
  path: string,
  sourceKey: string,
  targetVar: string
): void {
  lines.push("# infisical", `#     ${path}`);
  if (sourceKey !== targetVar) lines.push(`#     ${sourceKey}`);
  lines.push(`${targetVar}=`, "");
}
