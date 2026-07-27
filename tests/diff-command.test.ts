import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/adapters/workspace.js";
import { diffAll, hasChanges } from "../src/commands/diff.js";

// Exercises the git plumbing (resolveRef, readTextAtRef, gitRelativePath) end to
// end against a throwaway repo with two commits.
describe("diffAll (git-backed)", () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeAll(() => {
    // realpath so git's --show-toplevel (which resolves symlinks) agrees with the
    // resolved manifest path on macOS, where tmpdir() is a symlink.
    repo = realpathSync(mkdtempSync(join(tmpdir(), "env-source-diff-")));
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-qm", "root");

    writeFileSync(
      join(repo, "env-source.toml"),
      '[providers.infisical]\nproject = "acme"\n'
    );
    writeFileSync(
      join(repo, ".env.source"),
      ["# infisical", "#     /shared", "A="].join("\n")
    );
    git("add", "-A");
    git("commit", "-qm", "base");

    // Head edit: repoint A to /other and add B.
    writeFileSync(
      join(repo, ".env.source"),
      [
        "# infisical",
        "#     /other",
        "A=",
        "# infisical",
        "#     /shared",
        "B=",
      ].join("\n")
    );
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("diffs the working tree against a base ref", () => {
    const diffs = diffAll({ loaded: loadConfig(repo), base: "HEAD" });
    expect(diffs).toHaveLength(1);
    const delta = diffs[0]?.delta;
    expect(delta?.added.map((b) => b.targetVar)).toEqual(["B"]);
    expect(delta?.changed.map((c) => c.targetVar)).toEqual(["A"]);
    expect(hasChanges(diffs)).toBe(true);
  });

  it("throws on an unknown base ref", () => {
    expect(() =>
      diffAll({ loaded: loadConfig(repo), base: "no-such-ref" })
    ).toThrow(/Unknown base ref/);
  });
});
