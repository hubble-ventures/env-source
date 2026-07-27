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

type Binding = { sourceKey: string; targetVar: string };

/**
 * Render folder blocks into decorated `.env.source` text using the sticky-group
 * form: one `# infisical` / `#  /path` header per container path, then all its
 * keys below it. An aliased key gets a one-shot `#  SOURCE_KEY` line before it.
 */
function renderBlocks(blocks: SecretsBlock[]): string {
  // Group every binding by its (recursively joined) container path, preserving
  // first-seen order of both paths and keys.
  const byPath = new Map<string, Binding[]>();
  const collect = (path: string, entries: KeyEntry[]): void => {
    for (const entry of entries) {
      if (typeof entry === "string") {
        add(byPath, path, entry, entry);
        continue;
      }
      const [pair] = Object.entries(entry);
      if (!pair) throw new Error("empty key entry in secrets.json");
      const [key, value] = pair;
      if (Array.isArray(value)) {
        collect(`${path}/${key}`, value); // nested sub-folder → extend the path
      } else {
        add(byPath, path, key, value); // `{ SOURCE: TARGET }` alias
      }
    }
  };
  for (const block of blocks) {
    for (const [folder, entries] of Object.entries(block)) {
      collect(`/${folder.replace(/^\/+/, "")}`, entries);
    }
  }

  const lines: string[] = [
    "# Migrated from secrets.json by `env-source migrate`.",
    "# Review paths and add environment scopes/defaults as needed.",
    "",
  ];
  for (const [path, bindings] of byPath) {
    lines.push("# infisical", `#     ${path}`);
    for (const { sourceKey, targetVar } of bindings) {
      if (sourceKey !== targetVar) lines.push(`#     ${sourceKey}`);
      lines.push(`${targetVar}=`);
    }
    lines.push(""); // blank line closes the sticky group
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function add(
  byPath: Map<string, Binding[]>,
  path: string,
  sourceKey: string,
  targetVar: string
): void {
  const bindings = byPath.get(path) ?? [];
  byPath.set(path, bindings);
  bindings.push({ sourceKey, targetVar });
}
