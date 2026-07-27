import { describe, expect, it } from "vitest";
import { compile } from "../src/core/compile.js";
import type { EnvSourceConfig } from "../src/core/config.js";
import { EnvSourceError } from "../src/core/errors.js";
import { materialize } from "../src/core/materialize.js";
import { parseEnvSource } from "../src/core/parse.js";
import type { Provider } from "../src/core/types.js";
import { FakeProvider } from "./helpers.js";

const config: EnvSourceConfig = { providers: { infisical: { project: "acme" } } };

function providers(p: Provider): Map<string, Provider> {
  return new Map([[p.id, p]]);
}

function run(text: string, env: string, provider: Provider) {
  const compiled = compile(parseEnvSource(text), config, { environment: env });
  return materialize(compiled, providers(provider));
}

describe("materialize", () => {
  const vault = new FakeProvider("infisical", {
    development: {
      "/payments/stripe": { STRIPE_SECRET_KEY: "sk_dev", WEBHOOK: "wh_dev" },
      "/shared": { DATABASE_URL: "postgres://dev" },
    },
  });

  it("resolves values, aliases, and literals together", async () => {
    const vars = await run(
      [
        "# infisical",
        "#     /payments/stripe",
        "STRIPE_SECRET_KEY=",
        "# infisical",
        "#     /payments/stripe",
        "#     WEBHOOK",
        "WEBHOOK_SECRET=",
        "# infisical",
        "#     /shared",
        "DATABASE_URL=",
        "NODE_ENV=production",
      ].join("\n"),
      "development",
      vault
    );
    expect(vars).toEqual({
      DATABASE_URL: "postgres://dev",
      NODE_ENV: "production",
      STRIPE_SECRET_KEY: "sk_dev",
      WEBHOOK_SECRET: "wh_dev",
    });
  });

  it("reads each container once, batching keys", async () => {
    const spy = new FakeProvider("infisical", {
      production: { "/shared": { A: "1", B: "2" } },
    });
    await run(
      ["# infisical", "#     /shared", "A=", "# infisical", "#     /shared", "B="].join(
        "\n"
      ),
      "production",
      spy
    );
    expect(spy.reads).toBe(1);
  });

  it("falls back to the default when the provider is out of scope", async () => {
    const vars = await run(
      ["# infisical", "# (development)", "#     /shared", "DEBUG_TOKEN=off"].join(
        "\n"
      ),
      "production",
      vault
    );
    expect(vars).toEqual({ DEBUG_TOKEN: "off" });
  });

  it("drops an out-of-scope binding with no default", async () => {
    const vars = await run(
      ["# infisical", "# (development)", "#     /shared", "ONLY_DEV="].join("\n"),
      "production",
      vault
    );
    expect(vars).toEqual({});
  });

  it("errors when a required key is absent and has no default", async () => {
    await expect(
      run(
        ["# infisical", "#     /shared", "MISSING="].join("\n"),
        "development",
        vault
      )
    ).rejects.toBeInstanceOf(EnvSourceError);
  });

  it("uses the default when the provider lacks a value", async () => {
    const vars = await run(
      ["# infisical", "#     /shared", "MISSING=fallback"].join("\n"),
      "development",
      vault
    );
    expect(vars).toEqual({ MISSING: "fallback" });
  });
});
