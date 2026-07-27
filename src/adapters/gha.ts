import { appendFileSync, readFileSync } from "node:fs";

// GitHub Actions integration: mint OIDC tokens, mask secret values in the log,
// and export resolved variables to later steps via GITHUB_ENV. Kept dependency-
// free (no @actions/core) so the bundled action stays tiny.

/**
 * Request a GitHub OIDC JWT for `audience` from the Actions token service. The
 * job must set `permissions: id-token: write`, which populates the two request
 * variables read here.
 */
export async function getGithubOidcJwt(audience: string): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN — set `permissions: id-token: write`"
    );
  }
  const url = audience
    ? `${requestUrl}&audience=${encodeURIComponent(audience)}`
    : requestUrl;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`OIDC token request failed (${res.status})`);
  }
  const data = (await res.json()) as { value?: string };
  if (!data.value) throw new Error("OIDC token request returned an empty value");
  return data.value;
}

/** Mask a value so it is redacted everywhere it appears in the job log. */
export function maskValue(value: string): void {
  if (value !== "") process.stdout.write(`::add-mask::${value}\n`);
}

/**
 * Export `{ VAR: value }` to `GITHUB_ENV` so subsequent steps see them, masking
 * each value first. Uses the heredoc form so multi-line values are safe.
 */
export function exportToGithubEnv(vars: Record<string, string>): void {
  const file = process.env.GITHUB_ENV;
  if (!file) throw new Error("GITHUB_ENV is not set — not running in GitHub Actions?");
  let block = "";
  for (const [key, value] of Object.entries(vars)) {
    maskValue(value);
    const delimiter = `__ENV_SOURCE_${key}_EOF__`;
    block += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  if (block) appendFileSync(file, block);
}

/** Set a step output (`GITHUB_OUTPUT`), a no-op outside Actions. */
export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

/** Append Markdown to the job summary (`$GITHUB_STEP_SUMMARY`), a no-op locally. */
export function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

const COMMENT_MARKER = "<!-- env-source:diff -->";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upsert a single sticky PR comment carrying the manifest diff. Idempotent: a
 * repeated run edits the existing comment instead of stacking new ones. No-op
 * outside a pull-request event or without a token.
 */
export async function upsertPrComment(
  token: string,
  markdown: string
): Promise<void> {
  const pr = pullRequestNumber();
  const repo = process.env.GITHUB_REPOSITORY;
  if (pr === undefined || !repo || !token) return;

  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const body = `${COMMENT_MARKER}\n${markdown}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };

  const listRes = await gh(
    `${api}/repos/${repo}/issues/${pr}/comments?per_page=100`,
    { headers }
  );
  const existing = (await listRes.json()) as Array<{ id: number; body?: string }>;
  const mine = existing.find((c) => c.body?.includes(COMMENT_MARKER));

  if (mine) {
    await gh(`${api}/repos/${repo}/issues/comments/${mine.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });
  } else {
    await gh(`${api}/repos/${repo}/issues/${pr}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
  }
}

async function gh(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${url} failed (${res.status}): ${await res.text()}`
    );
  }
  return res;
}

/** Read the PR number from the event payload (only present on pull_request events). */
function pullRequestNumber(): number | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return undefined;
  try {
    const payload = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { number?: number };
    };
    return payload.pull_request?.number;
  } catch {
    return undefined;
  }
}
