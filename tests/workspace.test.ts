import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadManifest,
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
