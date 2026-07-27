import { describe, expect, it } from "vitest";
import { parseEnvSource } from "../src/core/parse.js";

describe("parseEnvSource", () => {
  it("parses a decorated infisical binding", () => {
    const { declarations, issues } = parseEnvSource(
      [
        "# infisical",
        "# (development,preview,production)",
        "#     /payments/stripe",
        "STRIPE_SECRET_KEY=<optional default>",
      ].join("\n")
    );
    expect(issues).toEqual([]);
    expect(declarations).toEqual([
      {
        targetVar: "STRIPE_SECRET_KEY",
        sources: [
          {
            provider: "infisical",
            path: "/payments/stripe",
            environments: ["development", "preview", "production"],
          },
        ],
        line: 4,
      },
    ]);
  });

  it("reads the source-key alias line", () => {
    const { declarations } = parseEnvSource(
      ["# infisical", "#     /payments/stripe", "#     STRIPE_WEBHOOK_SECRET", "WEBHOOK_SECRET="].join(
        "\n"
      )
    );
    expect(declarations[0]?.targetVar).toBe("WEBHOOK_SECRET");
    expect(declarations[0]?.sources[0]).toEqual({
      provider: "infisical",
      path: "/payments/stripe",
      sourceKey: "STRIPE_WEBHOOK_SECRET",
    });
  });

  it("parses a multi-provider fallback chain in order", () => {
    const { declarations } = parseEnvSource(
      [
        "# infisical",
        "#     /shared",
        "# vault",
        "#     /team/item",
        "#     FIELD",
        "TOKEN=",
      ].join("\n")
    );
    expect(declarations[0]?.sources).toEqual([
      { provider: "infisical", path: "/shared" },
      { provider: "vault", path: "/team/item", sourceKey: "FIELD" },
    ]);
  });

  it("treats a value with no default and a placeholder value alike (no default)", () => {
    const { declarations } = parseEnvSource(
      ["A=", "B=<optional default value>"].join("\n")
    );
    expect(declarations[0]?.default).toBeUndefined();
    expect(declarations[1]?.default).toBeUndefined();
  });

  it("keeps a concrete default and strips quotes", () => {
    const { declarations } = parseEnvSource(
      ['A=production', 'B="quoted value"', "C='single'"].join("\n")
    );
    expect(declarations.map((d) => d.default)).toEqual([
      "production",
      "quoted value",
      "single",
    ]);
  });

  it("does not treat a prose comment as a decorator", () => {
    const { declarations } = parseEnvSource(
      ["# stripe keys go here", "STRIPE_KEY=abc"].join("\n")
    );
    expect(declarations[0]).toEqual({
      targetVar: "STRIPE_KEY",
      default: "abc",
      sources: [],
      line: 2,
    });
  });

  it("does not attach a comment separated from the assignment by a blank line", () => {
    const { declarations } = parseEnvSource(
      ["# infisical", "#     /shared", "", "A=1"].join("\n")
    );
    expect(declarations[0]?.sources).toEqual([]);
  });

  it("applies a sticky group to every key below it until a blank line", () => {
    const { declarations } = parseEnvSource(
      [
        "# infisical",
        "# (development,production)",
        "#     /clerk",
        "CLERK_SECRET_KEY=",
        "GOOGLE_IOS_CLIENT_ID=",
        "",
        "NODE_ENV=production",
      ].join("\n")
    );
    // Both keys inherit the group's provider/path/env without repeating it.
    expect(declarations[0]?.sources).toEqual([
      {
        provider: "infisical",
        path: "/clerk",
        environments: ["development", "production"],
      },
    ]);
    expect(declarations[1]?.sources).toEqual([
      {
        provider: "infisical",
        path: "/clerk",
        environments: ["development", "production"],
      },
    ]);
    // The blank line ended the group, so NODE_ENV is a literal.
    expect(declarations[2]).toMatchObject({
      targetVar: "NODE_ENV",
      sources: [],
      default: "production",
    });
  });

  it("treats a source-key line as one-shot (aliases only the next key)", () => {
    const { declarations } = parseEnvSource(
      [
        "# infisical",
        "#     /clerk",
        "CLERK_SECRET_KEY=",
        "#     CLERK_PUBLISHABLE_KEY",
        "VITE_CLERK_PUBLISHABLE_KEY=",
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=",
      ].join("\n")
    );
    // First key: plain, no alias.
    expect(declarations[0]?.sources[0]).toEqual({ provider: "infisical", path: "/clerk" });
    // Aliased key: source key overridden for this one only.
    expect(declarations[1]?.sources[0]).toEqual({
      provider: "infisical",
      path: "/clerk",
      sourceKey: "CLERK_PUBLISHABLE_KEY",
    });
    // The alias did NOT leak — the third key reverts to its own name.
    expect(declarations[2]?.sources[0]).toEqual({ provider: "infisical", path: "/clerk" });
  });

  it("keeps per-source aliases in a chain without leaking to later keys", () => {
    const { declarations } = parseEnvSource(
      [
        "# infisical",
        "#     /shared",
        "#     PRIMARY",
        "# vault",
        "#     /team/item",
        "#     FIELD",
        "TOKEN=",
        "PLAIN=",
      ].join("\n")
    );
    expect(declarations[0]?.sources).toEqual([
      { provider: "infisical", path: "/shared", sourceKey: "PRIMARY" },
      { provider: "vault", path: "/team/item", sourceKey: "FIELD" },
    ]);
    // Next sticky key reuses the chain's providers/paths but its own key names.
    expect(declarations[1]?.sources).toEqual([
      { provider: "infisical", path: "/shared" },
      { provider: "vault", path: "/team/item" },
    ]);
  });

  it("flags an invalid variable name", () => {
    const { issues } = parseEnvSource("1BAD=x");
    expect(issues[0]?.code).toBe("invalid_var_name");
  });
});
