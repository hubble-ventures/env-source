import { compile } from "../core/compile.js";
import { configProviderIds } from "../core/config.js";
import { EnvSourceError } from "../core/errors.js";
import type { CompiledManifest, Issue, Provider } from "../core/types.js";
import { validate } from "../core/validate.js";
import {
  discoverManifests,
  type LoadedConfig,
  loadManifest,
  type ManifestFile,
  selectManifests,
} from "../adapters/workspace.js";
import { type ResolveContext, resolveProviders } from "../providers/registry.js";

export type ValidateOptions = {
  loaded: LoadedConfig;
  environment?: string;
  /** Manifest profile — loads `.env.<profile>.source` where present. */
  profile?: string;
  ids?: string[];
  /** Also check each declared key against the live provider. */
  againstProviders?: boolean;
  /** With `againstProviders`, treat a present-but-empty value as absent. */
  checkValues?: boolean;
  ctx: ResolveContext;
};

export type ValidateResult = { file: ManifestFile; issues: Issue[] };

/**
 * Validate every selected manifest. Structural checks always run; when
 * `againstProviders` is set, each binding is also checked against the live
 * provider — existence via `peek` (values never read), or, with `checkValues`,
 * flagging present-but-empty values too.
 */
export async function validateAll(
  options: ValidateOptions
): Promise<ValidateResult[]> {
  const { loaded, ctx } = options;
  const files = selectManifests(
    discoverManifests(loaded.root),
    options.ids ?? []
  );
  const checkValues = options.checkValues ?? false;
  const useProviders = options.againstProviders || checkValues;
  const knownProviders = configProviderIds(loaded.config);

  // Compile every manifest first, keeping a per-file failure local to that file.
  const entries: CompiledEntry[] = files.map((file) => {
    try {
      return {
        file,
        manifest: compile(
          loadManifest(file, options.profile, knownProviders),
          loaded.config,
          {
            ...(options.environment ? { environment: options.environment } : {}),
          }
        ),
      };
    } catch (error) {
      return { file, issues: toIssues(error) };
    }
  });

  // Then build each referenced provider once for the whole run rather than once
  // per manifest: constructing one costs a CLI probe or an OIDC login, and the
  // Infisical CLI lane memoises folder reads per provider instance — so a fresh
  // provider per manifest re-reads every folder that manifests share. Each id is
  // built independently so one unbuildable provider is reported only against the
  // manifests that reference it.
  const providers = new Map<string, Provider>();
  const providerErrors = new Map<string, unknown>();
  if (useProviders) {
    const ids = new Set(
      entries.flatMap((entry) =>
        "manifest" in entry
          ? entry.manifest.bindings.flatMap((b) =>
              b.sources.map((s) => s.provider)
            )
          : []
      )
    );
    for (const id of ids) {
      try {
        for (const [key, provider] of await resolveProviders(
          [id],
          loaded.config,
          ctx
        )) {
          providers.set(key, provider);
        }
      } catch (error) {
        providerErrors.set(id, error);
      }
    }
  }

  const results: ValidateResult[] = [];
  for (const entry of entries) {
    if (!("manifest" in entry)) {
      results.push({ file: entry.file, issues: entry.issues });
      continue;
    }
    const failed = entry.manifest.bindings
      .flatMap((b) => b.sources.map((s) => s.provider))
      .find((id) => providerErrors.has(id));
    if (failed !== undefined) {
      results.push({ file: entry.file, issues: toIssues(providerErrors.get(failed)) });
      continue;
    }
    try {
      results.push({
        file: entry.file,
        issues: await validate(
          entry.manifest,
          useProviders ? providers : undefined,
          { checkValues }
        ),
      });
    } catch (error) {
      results.push({ file: entry.file, issues: toIssues(error) });
    }
  }
  return results;
}

/** A manifest compiled for validation, or the failure that stopped it. */
type CompiledEntry =
  | { file: ManifestFile; manifest: CompiledManifest }
  | { file: ManifestFile; issues: Issue[] };

/** Whether any result carries an error-level issue. */
export function hasErrorResults(results: ValidateResult[]): boolean {
  return results.some((r) => r.issues.some((i) => i.level === "error"));
}

function toIssues(error: unknown): Issue[] {
  if (error instanceof EnvSourceError) return error.issues;
  return [
    {
      level: "error",
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    },
  ];
}
