import type { CompiledManifest, Issue, Provider } from "./types.js";

export type ValidateOptions = {
  /**
   * Also flag a source that resolves to a present-but-*empty* value as if it were
   * absent. Implies reading values, so it needs a provider that can (peek only
   * reports existence).
   */
  checkValues?: boolean;
};

/**
 * Check a compiled manifest for problems, optionally against live providers.
 *
 * Structural checks run with no I/O: every source must name a provider container
 * path. When `providers` is supplied, each binding is also checked against the
 * real vault — a binding is satisfied when any source in its chain has the key
 * (peeked, value never read) or it has a default. A binding that resolves nowhere
 * is an error; one that falls back to a default is a warning.
 */
export async function validate(
  compiled: CompiledManifest,
  providers?: Map<string, Provider>,
  options: ValidateOptions = {}
): Promise<Issue[]> {
  const issues: Issue[] = [];

  for (const binding of compiled.bindings) {
    for (const source of binding.sources) {
      if (source.path === "") {
        issues.push({
          level: "error",
          code: "missing_path",
          key: binding.targetVar,
          message: `'${binding.targetVar}' is sourced from '${source.provider}' but declares no container path`,
        });
      }
    }
  }

  if (!providers) return issues;

  const present = await probe(compiled, providers, options.checkValues ?? false);
  for (const binding of compiled.bindings) {
    if (binding.sources.length === 0) continue;
    const found = binding.sources.some(
      (s) => s.path !== "" && present.get(cacheKey(s.provider, s.path))?.has(s.sourceKey)
    );
    if (found) continue;
    const chain = binding.sources
      .map((s) => `${s.provider} ${s.path || "/"}:${s.sourceKey}`)
      .join(" → ");
    if (binding.default !== undefined) {
      issues.push({
        level: "warning",
        code: "unresolved",
        key: binding.targetVar,
        message: `'${binding.targetVar}' resolves nowhere in ${chain} (${compiled.environment}); will use default`,
      });
    } else {
      issues.push({
        level: "error",
        code: "unresolved",
        key: binding.targetVar,
        message: `'${binding.targetVar}' resolves nowhere in ${chain} (${compiled.environment}) and no default`,
      });
    }
  }

  return issues;
}

/** Whether any issue is an error (vs. a warning). */
export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.level === "error");
}

/**
 * Build the set of present keys per (provider, path). With `checkValues`, a
 * present-but-empty value is treated as absent (needs a value read); otherwise
 * existence is asserted with `peek`, which never surfaces a value.
 */
async function probe(
  compiled: CompiledManifest,
  providers: Map<string, Provider>,
  checkValues: boolean
): Promise<Map<string, Set<string>>> {
  const wanted = new Map<string, { provider: string; path: string; keys: Set<string> }>();
  for (const binding of compiled.bindings) {
    for (const source of binding.sources) {
      if (source.path === "") continue;
      const key = cacheKey(source.provider, source.path);
      const entry =
        wanted.get(key) ?? { provider: source.provider, path: source.path, keys: new Set<string>() };
      wanted.set(key, entry);
      entry.keys.add(source.sourceKey);
    }
  }

  const present = new Map<string, Set<string>>();
  for (const [key, { provider: providerId, path, keys }] of wanted) {
    const provider = providers.get(providerId);
    if (!provider) {
      // Surfaced as an "unresolved" per binding below; nothing present here.
      present.set(key, new Set());
      continue;
    }
    if (checkValues) {
      const values = await provider.read(compiled.environment, path, [...keys]);
      present.set(
        key,
        new Set(
          [...keys].filter((k) => Object.hasOwn(values, k) && values[k] !== "")
        )
      );
    } else {
      present.set(key, await provider.peek(compiled.environment, path, [...keys]));
    }
  }
  return present;
}

function cacheKey(provider: string, path: string): string {
  return `${provider} ${path}`;
}
