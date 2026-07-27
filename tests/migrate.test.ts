import { describe, expect, it } from "vitest";
import { compile } from "../src/core/compile.js";
import type { EnvSourceConfig } from "../src/core/config.js";
import { parseEnvSource } from "../src/core/parse.js";
import { migrateManifest } from "../src/commands/migrate.js";

const config: EnvSourceConfig = { providers: { infisical: { project: "acme" } } };

describe("migrateManifest", () => {
  it("converts folder blocks and aliases into a .env.source", () => {
    const { files } = migrateManifest({
      secrets: [
        {
          clerk: [
            "CLERK_SECRET_KEY",
            { CLERK_PUBLISHABLE_KEY: "VITE_CLERK_PUBLISHABLE_KEY" },
          ],
        },
        { stripe: ["STRIPE_SECRET_KEY"] },
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe(".env.source");

    // Round-trip: the emitted manifest parses back to the expected sources.
    const compiled = compile(parseEnvSource(files[0]!.content), config, {});
    const byVar = Object.fromEntries(
      compiled.bindings.map((b) => [b.targetVar, b.sources[0]])
    );
    expect(byVar.CLERK_SECRET_KEY).toEqual({
      provider: "infisical",
      path: "/clerk",
      sourceKey: "CLERK_SECRET_KEY",
    });
    expect(byVar.VITE_CLERK_PUBLISHABLE_KEY).toEqual({
      provider: "infisical",
      path: "/clerk",
      sourceKey: "CLERK_PUBLISHABLE_KEY",
    });
    expect(byVar.STRIPE_SECRET_KEY?.path).toBe("/stripe");
  });

  it("flattens a nested sub-folder into a joined container path", () => {
    const { files } = migrateManifest({
      secrets: [
        { apple: [{ paddlesup: ["APPLE_TEAM_ID", "MATCH_PASSWORD"] }] },
      ],
    });
    const compiled = compile(parseEnvSource(files[0]!.content), config, {});
    expect(compiled.bindings.map((b) => b.targetVar)).toEqual([
      "APPLE_TEAM_ID",
      "MATCH_PASSWORD",
    ]);
    // Both keys resolve under the joined /apple/paddlesup path — no comma-mashed var.
    for (const b of compiled.bindings) {
      expect(b.sources[0]).toEqual({
        provider: "infisical",
        path: "/apple/paddlesup",
        sourceKey: b.targetVar,
      });
    }
  });

  it("emits a profile as a sibling .env.<profile>.source", () => {
    const { files } = migrateManifest({
      secrets: [{ clerk: ["CLERK_SECRET_KEY"] }],
      profiles: { deploy: { secrets: [{ fly: ["FLY_API_TOKEN"] }] } },
    });
    expect(files.map((f) => f.filename)).toEqual([
      ".env.source",
      ".env.deploy.source",
    ]);
    expect(files[1]?.content).toContain("FLY_API_TOKEN");
  });

  it("warns about optionalKeys and ci rather than dropping them", () => {
    const { warnings } = migrateManifest({
      secrets: [{ clerk: ["A"] }],
      environments: { preview: { optionalKeys: ["A"] } },
      ci: { stubInCi: true },
    });
    expect(warnings.some((w) => w.includes("optionalKeys"))).toBe(true);
    expect(warnings.some((w) => w.includes("ci"))).toBe(true);
  });
});
