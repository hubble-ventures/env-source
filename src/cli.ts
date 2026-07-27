#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EnvSourceError } from "./core/errors.js";
import type { Issue } from "./core/types.js";
import { isEmptyDelta, renderDeltaText } from "./core/diff.js";
import { loadConfig } from "./adapters/workspace.js";
import type { ResolveContext } from "./providers/registry.js";
import { diffAll, hasChanges } from "./commands/diff.js";
import { listManifests } from "./commands/list.js";
import { migrateManifest } from "./commands/migrate.js";
import { pullToFiles } from "./commands/pull.js";
import { runWithEnv } from "./commands/run.js";
import { hasErrorResults, validateAll } from "./commands/validate.js";

const USAGE = `env-source — populate .env files from orchestrated secret providers

Usage:
  env-source pull     [ids...] [--env ENV] [--output FILE]
  env-source run      [ids...] [--env ENV] -- <command> [args...]
  env-source validate [ids...] [--env ENV] [--against-providers] [--check-values]
  env-source diff     [ids...] --base REF [--env ENV] [--exit-zero]
  env-source migrate  <secrets.json> [--write]
  env-source list     [--env ENV]

Manifests are the \`.env.source\` files discovered under the current directory;
provider context comes from the nearest \`env-source.toml\`.

Infisical auth: locally, the Infisical CLI (\`infisical login\`); in CI, GitHub
OIDC (set INFISICAL_IDENTITY_ID + \`permissions: id-token: write\`).
Docs: https://github.com/hubble-ventures/env-source
`;

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return;
    case "pull":
      return pull(rest);
    case "run":
      return run(rest);
    case "validate":
      return validate(rest);
    case "diff":
      return diff(rest);
    case "migrate":
      return migrate(rest);
    case "list":
      return list(rest);
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

/**
 * Local resolve context — no OIDC minter, so the provider registry selects the
 * Infisical CLI lane (the developer's own login session).
 */
function localContext(): ResolveContext {
  return { env: process.env };
}

async function pull(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      output: { type: "string" },
      profile: { type: "string" },
    },
  });

  const outcomes = await pullToFiles({
    loaded: loadConfig(),
    ...(values.env ? { environment: values.env } : {}),
    ...(values.output ? { output: values.output } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
    ids: positionals,
    ctx: localContext(),
  });

  if (outcomes.length === 0) {
    console.log("No .env.source manifests found.");
    return;
  }
  for (const outcome of outcomes) {
    console.log(`✅ ${outcome.id}: wrote ${outcome.output} (${outcome.count} vars)`);
  }
}

async function run(args: string[]): Promise<void> {
  // Everything after `--` is the command to exec; parseArgs stops at `--` and
  // exposes the remainder as tokens, but we split manually to keep it explicit.
  const sep = args.indexOf("--");
  if (sep === -1 || sep === args.length - 1) {
    throw new Error("run requires: env-source run [ids...] [--env ENV] -- <command> [args...]");
  }
  const head = args.slice(0, sep);
  const [command, ...commandArgs] = args.slice(sep + 1);

  const { values, positionals } = parseArgs({
    args: head,
    allowPositionals: true,
    options: { env: { type: "string" }, profile: { type: "string" } },
  });

  const code = await runWithEnv({
    loaded: loadConfig(),
    ...(values.env ? { environment: values.env } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
    ids: positionals,
    ctx: localContext(),
    command: command as string,
    args: commandArgs,
  });
  process.exitCode = code;
}

async function validate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      profile: { type: "string" },
      "against-providers": { type: "boolean", default: false },
      "check-values": { type: "boolean", default: false },
    },
  });

  const results = await validateAll({
    loaded: loadConfig(),
    ...(values.env ? { environment: values.env } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
    ids: positionals,
    againstProviders: values["against-providers"] ?? false,
    checkValues: values["check-values"] ?? false,
    ctx: localContext(),
  });

  if (results.length === 0) {
    console.log("No .env.source manifests found.");
    return;
  }
  for (const { file, issues } of results) {
    if (issues.length === 0) {
      console.log(`✅ ${file.id}: valid`);
      continue;
    }
    const errored = issues.some((i) => i.level === "error");
    console.log(`${errored ? "❌" : "⚠️ "} ${file.id}:`);
    for (const issue of issues) {
      const at = issue.line ? `L${issue.line} ` : "";
      const label = issue.level === "error" ? "error" : "warn ";
      console.log(`   ${label} ${at}${issue.message}`);
    }
  }
  if (hasErrorResults(results)) process.exitCode = 1;
}

function diff(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      env: { type: "string" },
      profile: { type: "string" },
      "exit-zero": { type: "boolean", default: false },
    },
  });
  if (!values.base) throw new Error("diff requires --base REF");

  const diffs = diffAll({
    loaded: loadConfig(),
    base: values.base,
    ...(values.env ? { environment: values.env } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
    ids: positionals,
  });

  for (const { file, delta, isNew } of diffs) {
    if (isEmptyDelta(delta)) continue;
    console.log(`\n${file.id}${isNew ? " (new)" : ""}`);
    console.log(renderDeltaText(delta));
  }

  if (!hasChanges(diffs)) {
    console.log("No manifest changes.");
  } else if (!values["exit-zero"]) {
    process.exitCode = 1;
  }
}

function migrate(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { write: { type: "boolean", default: false } },
  });
  const [source] = positionals;
  if (!source) throw new Error("migrate requires a path to a secrets.json file");

  const raw = JSON.parse(readFileSync(resolve(source), "utf8"));
  const { files, warnings } = migrateManifest(raw);
  const outDir = dirname(resolve(source));

  for (const file of files) {
    if (values.write) {
      writeFileSync(join(outDir, file.filename), file.content);
      console.log(`✅ wrote ${join(outDir, file.filename)}`);
    } else {
      console.log(`# ---- ${file.filename} ----`);
      console.log(file.content);
    }
  }
  for (const warning of warnings) console.log(`⚠️  ${warning}`);
  if (!values.write) {
    console.log("# Dry run — re-run with --write to create these files.");
  }
}

function list(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { env: { type: "string" }, profile: { type: "string" } },
  });
  const summaries = listManifests(
    loadConfig(),
    values.env ?? undefined,
    values.profile ?? undefined
  );
  if (summaries.length === 0) {
    console.log("No .env.source manifests found.");
    return;
  }
  for (const s of summaries) {
    const providers = s.providers.length > 0 ? s.providers.join(",") : "—";
    console.log(`${s.id}\t${s.vars} vars\t${providers}`);
  }
}

main().catch((error) => {
  if (error instanceof EnvSourceError) {
    for (const issue of error.issues) reportIssue(issue);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});

function reportIssue(issue: Issue): void {
  const at = issue.line ? `L${issue.line}: ` : "";
  console.error(`error: ${at}${issue.message}`);
}
