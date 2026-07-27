import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportToGithubEnv,
  setOutput,
  upsertPrComment,
} from "../src/adapters/gha.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "env-source-gha-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("exportToGithubEnv", () => {
  it("writes a heredoc block per var and masks values", () => {
    const dir = tmp();
    const envFile = join(dir, "gh-env");
    writeFileSync(envFile, "");
    vi.stubEnv("GITHUB_ENV", envFile);
    const masks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      masks.push(String(chunk));
      return true;
    });

    exportToGithubEnv({ SECRET: "s3cr3t" });
    const written = readFileSync(envFile, "utf8");
    expect(written).toMatch(/SECRET<<__ENV_SOURCE_SECRET_EOF__\ns3cr3t\n__ENV_SOURCE_SECRET_EOF__/);
    expect(masks.some((m) => m.includes("::add-mask::s3cr3t"))).toBe(true);
  });
});

describe("setOutput", () => {
  it("appends name=value to GITHUB_OUTPUT", () => {
    const dir = tmp();
    const outFile = join(dir, "gh-out");
    writeFileSync(outFile, "");
    vi.stubEnv("GITHUB_OUTPUT", outFile);
    setOutput("count", "3");
    expect(readFileSync(outFile, "utf8")).toBe("count=3\n");
  });
});

describe("upsertPrComment", () => {
  function eventFile(): string {
    const dir = tmp();
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify({ pull_request: { number: 42 } }));
    return path;
  }

  it("creates a new comment when none exists", async () => {
    vi.stubEnv("GITHUB_EVENT_PATH", eventFile());
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app");
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(new Response("[]", { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 201 }));
      })
    );

    await upsertPrComment("token", "## diff");
    expect(calls.find((c) => c.method === "POST")?.url).toContain(
      "/repos/acme/app/issues/42/comments"
    );
  });

  it("patches the existing sticky comment on a repeat run", async () => {
    vi.stubEnv("GITHUB_EVENT_PATH", eventFile());
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve(
            new Response(
              JSON.stringify([{ id: 99, body: "<!-- env-source:diff -->\nold" }]),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );

    await upsertPrComment("token", "## diff");
    const patch = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH"
    );
    expect(String(patch?.[0])).toContain("/repos/acme/app/issues/comments/99");
  });

  it("no-ops outside a pull_request event", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await upsertPrComment("token", "## diff");
    expect(spy).not.toHaveBeenCalled();
  });
});
