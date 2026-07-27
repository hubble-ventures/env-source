import { configEnvironment, configOutput, type EnvSourceConfig } from "./config.js";
import { EnvSourceError } from "./errors.js";
import { normalizePath } from "./path.js";
import type {
  CompiledBinding,
  CompiledManifest,
  Declaration,
  Issue,
  ParsedManifest,
} from "./types.js";

export type CompileOptions = {
  /** Environment to resolve; falls back to the config default, then `development`. */
  environment?: string;
  /** Output filename override (else the config default). */
  output?: string;
};

/**
 * Compile a parsed manifest into a flat, sorted, collision-free list of bindings
 * for a single environment. This is the one place the authoring format is
 * interpreted; pull / validate consume the result.
 *
 * Each source is kept only when its declared environment list includes — or
 * omits, meaning "all" — the compiled environment, preserving priority order. A
 * binding whose sources all drop out resolves to its literal/default value, and
 * is dropped entirely when no default exists.
 *
 * Throws {@link EnvSourceError} on a parse error carried over from the manifest,
 * or a duplicate emitted variable.
 */
export function compile(
  parsed: ParsedManifest,
  config: EnvSourceConfig,
  options: CompileOptions = {}
): CompiledManifest {
  const errors = parsed.issues.filter((i) => i.level === "error");
  if (errors.length > 0) throw new EnvSourceError(errors);

  const environment = options.environment ?? configEnvironment(config);
  const output = options.output ?? configOutput(config);

  const bindings: CompiledBinding[] = [];
  for (const decl of parsed.declarations) {
    bindings.push(compileBinding(decl, environment));
  }
  bindings.sort((a, b) => a.targetVar.localeCompare(b.targetVar));
  assertNoCollisions(bindings, parsed.declarations);

  return { environment, output, bindings };
}

function compileBinding(
  decl: Declaration,
  environment: string
): CompiledBinding {
  const sources = decl.sources
    .filter(
      (s) =>
        s.environments === undefined || s.environments.includes(environment)
    )
    .map((s) => ({
      provider: s.provider,
      // An empty path is left as "" (not normalized to "/") so validate can flag
      // the missing decorator line rather than silently reading the root.
      path: s.path ? normalizePath(s.path) : "",
      sourceKey: s.sourceKey ?? decl.targetVar,
    }));

  const binding: CompiledBinding = { targetVar: decl.targetVar, sources };
  if (decl.default !== undefined) binding.default = decl.default;
  return binding;
}

// Two declarations emitting the same variable is always a bug: one would silently
// overwrite the other. Report every collision at once so a fix is one pass.
function assertNoCollisions(
  bindings: CompiledBinding[],
  declarations: Declaration[]
): void {
  const lineOf = new Map(declarations.map((d) => [d.targetVar, d.line] as const));
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.targetVar)) {
      const issue: Issue = {
        level: "error",
        code: "duplicate_target",
        key: binding.targetVar,
        message: `Duplicate variable '${binding.targetVar}' declared more than once`,
      };
      const line = lineOf.get(binding.targetVar);
      if (line !== undefined) issue.line = line;
      issues.push(issue);
    } else {
      seen.add(binding.targetVar);
    }
  }
  if (issues.length > 0) throw new EnvSourceError(issues);
}
