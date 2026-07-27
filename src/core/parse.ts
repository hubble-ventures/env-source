import type {
  DeclSource,
  Declaration,
  Issue,
  ParsedManifest,
} from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A provider id is a single lowercase, whitespace-free token (no underscore).
// Requiring this shape lets a prose comment ("# stripe keys below") sit above an
// assignment without being mistaken for a decorator, and lets a source key (by
// convention UPPER_SNAKE, or at least underscore-bearing) never be misread as
// the start of a new provider block.
const PROVIDER_TOKEN = /^[a-z][a-z0-9-]*$/;
const ENV_LIST = /^\(([^)]*)\)$/;

/**
 * Parse `.env.source` text into declarations.
 *
 * The grammar is dotenv with *decorators*: a run of comment lines immediately
 * above an assignment describes where that variable is sourced from. A comment
 * block separated from the assignment by a blank line is a plain comment and is
 * ignored.
 *
 * ```
 * # infisical                         ← provider id (first decorator line)
 * # (development,preview,production)   ← environments the provider is consulted in
 * #     /payments/stripe              ← provider container path
 * #     STRIPE_SECRET                 ← optional source key (when it differs from the var)
 * STRIPE_SECRET_KEY=<optional default>← emitted variable + optional fallback default
 * ```
 *
 * A declaration with no provider decorator is a *literal*: its value is whatever
 * sits on the right of `=`.
 */
export function parseEnvSource(text: string): ParsedManifest {
  const declarations: Declaration[] = [];
  const issues: Issue[] = [];

  // Comment lines accumulated since the last blank line or assignment. Reset to
  // `null` on a blank line so a detached comment block never decorates the next
  // assignment.
  let pending: string[] | null = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    const lineNo = i + 1;

    if (line === "") {
      pending = null;
      continue;
    }

    if (line.startsWith("#")) {
      // Collect the comment body (text after the leading `#`, one strip only so
      // indentation inside the decorator is preserved for the caller if needed).
      (pending ??= []).push(line.replace(/^#\s?/, ""));
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
      pending = null;
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
      pending = null;
      continue;
    }

    const declaration = buildDeclaration(
      targetVar,
      line.slice(eq + 1),
      pending ?? [],
      lineNo,
      issues
    );
    declarations.push(declaration);
    pending = null;
  }

  return { declarations, issues };
}

function buildDeclaration(
  targetVar: string,
  rawValue: string,
  decorator: string[],
  line: number,
  issues: Issue[]
): Declaration {
  const declaration: Declaration = {
    targetVar,
    sources: parseDecorator(decorator, targetVar, line, issues),
    line,
  };
  const def = parseDefault(rawValue);
  if (def !== undefined) declaration.default = def;
  return declaration;
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

/**
 * Parse a decorator comment block into an ordered list of provider sources.
 *
 * Each provider-shaped line (e.g. `infisical`) opens a new source; the lines
 * under it are matched by shape — parenthesized → environments, `/`-bearing →
 * container path, bare identifier → source-key alias. Listing several provider
 * blocks builds a fallback chain, tried in order. A block whose first content
 * line is not provider-shaped is a plain comment and yields no sources.
 */
function parseDecorator(
  decorator: string[],
  targetVar: string,
  line: number,
  issues: Issue[]
): DeclSource[] {
  const content = decorator.map((l) => l.trim()).filter((l) => l !== "");
  if (content.length === 0) return [];

  const sources: DeclSource[] = [];
  let current: DeclSource | undefined;

  for (const raw of content) {
    if (PROVIDER_TOKEN.test(raw)) {
      current = { provider: raw };
      sources.push(current);
      continue;
    }
    if (!current) {
      // Leading non-provider line — the block is a human comment, not a decorator.
      return [];
    }

    const envMatch = ENV_LIST.exec(raw);
    if (envMatch) {
      current.environments = (envMatch[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      continue;
    }
    if (raw.includes("/")) {
      // Any `/`-bearing line is a container path (source-key aliases are bare
      // identifiers and never contain a slash).
      current.path = raw;
      continue;
    }
    if (IDENT.test(raw)) {
      current.sourceKey = raw;
      continue;
    }
    issues.push({
      level: "warning",
      code: "unrecognized_decorator",
      line,
      key: targetVar,
      message: `Ignored unrecognized decorator line for '${targetVar}': ${raw}`,
    });
  }

  return sources;
}
