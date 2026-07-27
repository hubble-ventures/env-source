import { compile } from "../core/compile.js";
import { configProviderIds } from "../core/config.js";
import { EnvSourceError } from "../core/errors.js";
import type { Issue } from "../core/types.js";
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

  const results: ValidateResult[] = [];
  for (const file of files) {
    try {
      const manifest = compile(
        loadManifest(file, options.profile, knownProviders),
        loaded.config,
        {
        ...(options.environment ? { environment: options.environment } : {}),
      });
      let providers: Awaited<ReturnType<typeof resolveProviders>> | undefined;
      if (useProviders) {
        const ids = manifest.bindings.flatMap((b) =>
          b.sources.map((s) => s.provider)
        );
        providers = await resolveProviders(ids, loaded.config, ctx);
      }
      results.push({
        file,
        issues: await validate(manifest, providers, { checkValues }),
      });
    } catch (error) {
      results.push({ file, issues: toIssues(error) });
    }
  }
  return results;
}

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
