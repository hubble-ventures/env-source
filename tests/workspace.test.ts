import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverManifests,
  loadManifest,
  selectManifests,
  writeSecretFile,
} from "../src/adapters/workspace.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "env-source-ws-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("writeSecretFile", () => {
  it("writes owner-only (0600) content", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    writeSecretFile(path, "A=1\n");
    expect(readFileSync(path, "utf8")).toBe("A=1\n");
    // Low 9 permission bits should be 0600 (rw-------).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("replaces an existing file atomically", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    writeFileSync(path, "OLD=1\n");
    chmodSync(path, 0o600);
    writeSecretFile(path, "NEW=2\n");
    expect(readFileSync(path, "utf8")).toBe("NEW=2\n");
  });
});

describe("loadManifest with profiles", () => {
  it("prefers a sibling .env.<profile>.source when present", () => {
    const dir = tmp();
    writeFileSync(join(dir, ".env.source"), "# infisical\n#     /a\nA=\n");
    writeFileSync(join(dir, ".env.deploy.source"), "# infisical\n#     /b\nB=\n");
    const file = { id: "root", path: join(dir, ".env.source"), dir };

    expect(loadManifest(file).declarations[0]?.targetVar).toBe("A");
    expect(loadManifest(file, "deploy").declarations[0]?.targetVar).toBe("B");
    // Falls back to the base file when the profile variant is absent.
    expect(loadManifest(file, "missing").declarations[0]?.targetVar).toBe("A");
  });
});

describe("discoverManifests", () => {
  function manifest(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env.source"), "# infisical\n#     /a\nA=\n");
  }

  it("finds manifests below the root, skipping vendor and build directories", () => {
    const root = tmp();
    manifest(join(root, "apps", "web"));
    manifest(join(root, "infra", "postgres"));
    manifest(join(root, "node_modules", "pkg"));
    manifest(join(root, "dist"));

    expect(discoverManifests(root).map((f) => f.id)).toEqual([
      "apps/web",
      "infra/postgres",
    ]);
  });

  it("does not descend into a nested checkout (linked worktree or submodule)", () => {
    const root = tmp();
    manifest(join(root, "apps", "web"));

    // A linked worktree: a full copy of the tree whose root holds a `.git`
    // *file* pointing at the real gitdir. Its manifests belong to that checkout,
    // not this one — discovering them fans every vault read out per worktree.
    const worktree = join(root, ".claude", "worktrees", "feature");
    manifest(join(worktree, "apps", "web"));
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/feature\n");

    // A submodule or nested clone marks itself with a `.git` directory instead.
    const nested = join(root, "vendor", "lib");
    manifest(nested);
    mkdirSync(join(nested, ".git"), { recursive: true });

    expect(discoverManifests(root).map((f) => f.id)).toEqual(["apps/web"]);
  });

  it("still discovers the workspace's own manifests when the root is a checkout", () => {
    // The everyday case, and the one the nested-checkout skip must not break:
    // the root of a normal repo holds a `.git` directory of its own.
    const root = tmp();
    mkdirSync(join(root, ".git"), { recursive: true });
    manifest(root);
    manifest(join(root, "apps", "web"));

    expect(discoverManifests(root).map((f) => f.id)).toEqual(["apps/web", "root"]);
  });
});

describe("selectManifests", () => {
  const files = [
    { id: "apps/web", path: "/r/apps/web/.env.source", dir: "/r/apps/web" },
    { id: "infra/postgres", path: "/r/infra/postgres/.env.source", dir: "/r/infra/postgres" },
    { id: "scripts", path: "/r/scripts/.env.source", dir: "/r/scripts" },
  ];

  it("returns everything when no ids are given", () => {
    expect(selectManifests(files, []).map((f) => f.id)).toEqual([
      "apps/web",
      "infra/postgres",
      "scripts",
    ]);
  });

  it("matches a full id, and a leaf directory name as shorthand", () => {
    expect(selectManifests(files, ["apps/web", "postgres"]).map((f) => f.id)).toEqual([
      "apps/web",
      "infra/postgres",
    ]);
  });

  it("rejects an ambiguous shorthand instead of selecting every match", () => {
    const ambiguous = [
      ...files,
      { id: "other/web", path: "/r/other/web/.env.source", dir: "/r/other/web" },
    ];
    expect(() => selectManifests(ambiguous, ["web"])).toThrow(
      /'web' is ambiguous.*apps\/web, other\/web.*full id/s
    );
  });

  it("rejects an id that matches nothing rather than selecting none", () => {
    expect(() => selectManifests(files, ["postgres", "postgress"])).toThrow(
      /'postgress' matches no manifest.*apps\/web, infra\/postgres, scripts/s
    );
  });

  it("prefers an exact id over a same-named leaf elsewhere", () => {
    const ambiguous = [
      ...files,
      { id: "vendor/scripts", path: "/r/vendor/scripts/.env.source", dir: "/r/vendor/scripts" },
    ];
    expect(selectManifests(ambiguous, ["scripts"]).map((f) => f.id)).toEqual(["scripts"]);
  });
});
