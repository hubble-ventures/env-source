import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/adapters/workspace.js";
import { runWithEnv } from "../src/commands/run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(envSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), "env-source-run-"));
  dirs.push(dir);
  writeFileSync(join(dir, "env-source.toml"), '[providers.infisical]\nproject = "acme"\n');
  writeFileSync(join(dir, ".env.source"), envSource);
  return dir;
}

describe("runWithEnv", () => {
  it("injects resolved (literal) vars into the child environment", async () => {
    const dir = workspace("FOO=bar\n");
    const code = await runWithEnv({
      loaded: loadConfig(dir),
      ctx: { env: process.env },
      command: process.execPath, // node
      args: ["-e", "process.exit(process.env.FOO === 'bar' ? 0 : 3)"],
    });
    expect(code).toBe(0);
  });

  it("propagates the child's exit code", async () => {
    const dir = workspace("FOO=bar\n");
    const code = await runWithEnv({
      loaded: loadConfig(dir),
      ctx: { env: process.env },
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    });
    expect(code).toBe(7);
  });
});
