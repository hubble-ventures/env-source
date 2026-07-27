// GitHub Action entrypoint. Bundled to `action/index.cjs` (see tsup.config.ts)
// and run directly by the composite action with no install step.
//
// `pull` resolves every manifest and exports the variables into GITHUB_ENV
// (masked) for later steps. `validate` checks the manifests, optionally peeking
// the live provider. Authentication is GitHub OIDC: the job must set
// `permissions: id-token: write`.
import { isEmptyDelta, renderDeltaMarkdown } from "./core/diff.js";
import { loadConfig } from "./adapters/workspace.js";
import {
  appendSummary,
  exportToGithubEnv,
  getGithubOidcJwt,
  setOutput,
  upsertPrComment,
} from "./adapters/gha.js";
import type { ResolveContext } from "./providers/registry.js";
import { diffAll, diffTotals, hasChanges } from "./commands/diff.js";
import { resolveManifests } from "./commands/pull.js";
import { hasErrorResults, validateAll } from "./commands/validate.js";

/** Read a composite-action input from its `INPUT_*` environment variable. */
function input(name: string): string {
  const key = `INPUT_${name.toUpperCase().replace(/ /g, "_")}`;
  return (process.env[key] ?? "").trim();
}

function boolInput(name: string): boolean {
  return input(name).toLowerCase() === "true";
}

function listInput(name: string): string[] {
  return input(name)
    .split(/[\s,]+/)
    .filter((s) => s !== "");
}

function actionContext(): ResolveContext {
  // Surface action inputs to the provider registry via the same env vars the CLI
  // reads, then hand it the OIDC minter for the CI auth lane.
  const env = { ...process.env };
  const identityId = input("identity-id");
  const audience = input("oidc-audience");
  if (identityId) env.INFISICAL_IDENTITY_ID = identityId;
  if (audience) env.INFISICAL_OIDC_AUDIENCE = audience;
  return { env, getOidcJwt: getGithubOidcJwt };
}

async function run(): Promise<void> {
  const workingDir = input("working-directory");
  if (workingDir) process.chdir(workingDir);

  const command = input("command") || "pull";
  const environment = input("environment");
  const profile = input("profile");
  const ids = listInput("ids");
  const loaded = loadConfig();
  const ctx = actionContext();

  if (command === "pull") {
    const resolved = await resolveManifests({
      loaded,
      ...(environment ? { environment } : {}),
      ...(profile ? { profile } : {}),
      ids,
      ctx,
    });
    let count = 0;
    for (const { vars } of resolved) {
      exportToGithubEnv(vars);
      count += Object.keys(vars).length;
    }
    setOutput("count", String(count));
    setOutput("manifests", String(resolved.length));
    console.log(
      `Loaded ${count} variable(s) from ${resolved.length} manifest(s) into the job environment.`
    );
    return;
  }

  if (command === "validate") {
    const results = await validateAll({
      loaded,
      ...(environment ? { environment } : {}),
      ...(profile ? { profile } : {}),
      ids,
      againstProviders: boolInput("against-providers"),
      checkValues: boolInput("check-values"),
      ctx,
    });
    for (const { file, issues } of results) {
      for (const issue of issues) {
        const level = issue.level === "error" ? "error" : "warning";
        console.log(`::${level}::${file.id}: ${issue.message}`);
      }
    }
    setOutput("manifests", String(results.length));
    if (hasErrorResults(results)) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "diff") {
    const base = input("base");
    if (!base) throw new Error("diff requires the `base` input (a git ref)");
    const diffs = diffAll({
      loaded,
      base,
      ...(environment ? { environment } : {}),
      ...(profile ? { profile } : {}),
      ids,
    });

    const sections = diffs
      .filter((d) => !isEmptyDelta(d.delta))
      .map((d) =>
        renderDeltaMarkdown(d.delta, `${d.file.id}${d.isNew ? " (new)" : ""}`)
      );
    const markdown =
      sections.length > 0
        ? `## env-source manifest diff\n\n${sections.join("\n")}`
        : "## env-source manifest diff\n\n_No manifest changes._\n";

    appendSummary(markdown);
    if (boolInput("comment")) {
      await upsertPrComment(input("github-token"), markdown);
    }

    const totals = diffTotals(diffs);
    const changed = hasChanges(diffs);
    setOutput("changed", String(changed));
    setOutput("added", String(totals.added));
    setOutput("removed", String(totals.removed));
    setOutput("changed-count", String(totals.changed));
    setOutput("manifests", String(diffs.length));

    if (changed && boolInput("fail-on-change")) process.exitCode = 1;
    return;
  }

  throw new Error(
    `Unknown command '${command}' (expected pull | validate | diff)`
  );
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::${message}`);
  process.exitCode = 1;
});
