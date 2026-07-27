import type { DeclSource, Declaration, Issue, ParsedManifest } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A provider id is a single lowercase, whitespace-free token (no underscore).
// Requiring this shape lets a multi-word prose comment sit above an assignment
// without being mistaken for a decorator.
const PROVIDER_TOKEN = /^[a-z][a-z0-9-]*$/;
const ENV_LIST = /^\(([^)]*)\)$/;

/**
 * Parse `.env.source` text into declarations.
 *
 * The grammar is dotenv with *sticky decorators* (frontmatter): comment lines
 * describe where the variables below them are sourced from, and that context
 * **persists for every following assignment until the next decorator replaces
 * it**. Blank lines are cosmetic — they never change meaning.
 *
 * ```
 * # infisical                         ← provider id (opens a group)
 * # (development,preview,production)   ← environments the provider is consulted in
 * #     /payments/stripe              ← provider container path
 * STRIPE_SECRET_KEY=                  ← sourced from /payments/stripe
 * STRIPE_WEBHOOK_SECRET=              ← same group — no need to repeat the decorator
 * #     ORIGINAL_NAME                 ← one-shot source-key alias for the NEXT key only
 * WEBHOOK_SECRET=<optional default>   ← emitted var + optional fallback default
 *
 * # literal                           ← reset: keys below have no provider
 * NODE_ENV=production                 ← a literal (value is the RHS)
 * ```
 *
 * What is sticky vs. one-shot:
 *  - **Provider, container path, and environment scope are sticky** — they apply
 *    to every assignment below until a new decorator changes them.
 *  - **A bare source-key line is one-shot** — it aliases only the immediately
 *    following assignment (source keys are inherently per-variable).
 *
 * Multiple provider lines with no assignment between them build a fallback
 * *chain*. `# literal` clears the provider context so the keys below are literals
 * (also the state at the top of a file, before any decorator). A comment whose
 * lines are not decorator-shaped is a plain comment and is ignored.
 *
 * `knownProviders` (the ids configured in `env-source.toml`) disambiguates a bare
 * lowercase token *inside* a group: it is a new provider only when known,
 * otherwise it is a source-key alias — so a vault key literally named `token` is
 * not mistaken for a provider. Omit it (as tests may) and every provider-shaped
 * token is treated as a provider, preserving the original behavior.
 */
export function parseEnvSource(
  text: string,
  knownProviders?: Iterable<string>
): ParsedManifest {
  const known = knownProviders ? new Set(knownProviders) : undefined;
  const declarations: Declaration[] = [];
  const issues: Issue[] = [];

  // The sticky group: sources carry provider/path/environments. Source keys are
  // per-variable, so they never live here permanently — see `emit`.
  let group: DeclSource[] = [];
  // The source currently being built (last in `group`), for path/env/alias lines.
  let current: DeclSource | undefined;
  // Whether a provider line has opened/extended the group in the current block
  // (since the last assignment or blank line). Gates chain-extension and whether
  // a source-key line binds the built source vs. the next key.
  let blockHasProvider = false;
  // One-shot source-key alias captured under a sticky group, for the next key.
  let pendingSourceKey: string | undefined;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    const lineNo = i + 1;

    // Blank lines are cosmetic — the sticky context carries across them.
    if (line === "") continue;

    if (line.startsWith("#")) {
      const body = line.replace(/^#+/, "").trim();
      if (body === "") continue;
      applyDecorator(body);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      issues.push({
        level: "error",
        code: "invalid_line",
        line: lineNo,
        message: `Expected 'KEY=value' or a comment, got: ${line}`,
      });
      blockHasProvider = false;
      pendingSourceKey = undefined;
      continue;
    }

    const targetVar = line.slice(0, eq).trim();
    if (!IDENT.test(targetVar)) {
      issues.push({
        level: "error",
        code: "invalid_var_name",
        line: lineNo,
        key: targetVar,
        message: `Invalid variable name '${targetVar}'`,
      });
      blockHasProvider = false;
      pendingSourceKey = undefined;
      continue;
    }

    emit(targetVar, line.slice(eq + 1), lineNo);
  }

  return { declarations, issues };

  /** Fold one decorator comment body into the running group context. */
  function applyDecorator(body: string): void {
    if (body === "literal") {
      // Explicit reset: keys below have no provider (they are literals) until the
      // next decorator opens a group.
      group = [];
      current = undefined;
      blockHasProvider = false;
      pendingSourceKey = undefined;
      return;
    }

    // A provider-shaped token opens/extends a group when it names a known
    // provider, or when we're in provider position (no source is being built, so
    // a source-key would make no sense — e.g. the first line of a group, which
    // downstream reports clearly if the provider is unconfigured). Otherwise it
    // falls through and is read as a source-key alias.
    if (
      PROVIDER_TOKEN.test(body) &&
      (known === undefined || known.has(body) || !current)
    ) {
      // First provider since the last assignment opens a fresh group;
      // a subsequent one extends the fallback chain.
      if (!blockHasProvider) group = [];
      current = { provider: body };
      group.push(current);
      blockHasProvider = true;
      return;
    }

    const env = ENV_LIST.exec(body);
    if (env) {
      if (current) {
        current.environments = env[1]!
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      }
      return; // env with no active source → prose, ignored
    }

    if (body.includes("/")) {
      if (current) current.path = body; // sticky path for the group's source
      return; // path with no active source → prose, ignored
    }

    if (IDENT.test(body)) {
      // A source-key alias. Only meaningful inside an active group; otherwise a
      // bare word is prose. While building a chain it binds the current source;
      // under an inherited sticky group it is a one-shot for the next key.
      if (blockHasProvider && current) current.sourceKey = body;
      else if (group.length > 0) pendingSourceKey = body;
      return;
    }

    // Anything else (multi-word, punctuation) is a human comment — ignored.
  }

  /** Emit a declaration from the sticky group, then clear per-key source keys. */
  function emit(targetVar: string, rawValue: string, lineNo: number): void {
    const sources = group.map((s) => {
      const copy: DeclSource = { provider: s.provider };
      if (s.path !== undefined) copy.path = s.path;
      if (s.sourceKey !== undefined) copy.sourceKey = s.sourceKey;
      if (s.environments !== undefined) copy.environments = [...s.environments];
      return copy;
    });
    if (pendingSourceKey !== undefined && sources.length > 0) {
      sources[sources.length - 1]!.sourceKey = pendingSourceKey;
    }

    const declaration: Declaration = { targetVar, sources, line: lineNo };
    const def = parseDefault(rawValue);
    if (def !== undefined) declaration.default = def;
    declarations.push(declaration);

    // Source keys are per-variable: drop them so a following sticky key reverts
    // to its own name. Provider/path/environments stay sticky.
    for (const s of group) {
      delete s.sourceKey;
    }
    pendingSourceKey = undefined;
    blockHasProvider = false;
  }
}

/**
 * Interpret the right-hand side of an assignment. An empty RHS or an angle-bracket
 * `<placeholder>` both mean "no concrete default"; anything else is a literal
 * value (dotenv quote-stripping applied).
 */
function parseDefault(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (trimmed === "") return undefined;
  if (/^<.*>$/.test(trimmed)) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
