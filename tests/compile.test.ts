import { describe, expect, it } from "vitest";
import { compile } from "../src/core/compile.js";
import type { EnvSourceConfig } from "../src/core/config.js";
import { EnvSourceError } from "../src/core/errors.js";
import { parseEnvSource } from "../src/core/parse.js";

const config: EnvSourceConfig = {
  default_environment: "development",
  output: ".env",
  providers: { infisical: { project: "acme" } },
};

function compileText(text: string, environment?: string) {
  return compile(
    parseEnvSource(text),
    config,
    environment ? { environment } : {}
  );
}

describe("compile", () => {
  it("keeps a source in scope for its environment", () => {
    const { bindings } = compileText(
      ["# infisical", "# (development,production)", "#     /shared", "A="].join("\n"),
      "development"
    );
    expect(bindings[0]?.targetVar).toBe("A");
    expect(bindings[0]?.sources).toEqual([
      { provider: "infisical", path: "/shared", sourceKey: "A" },
    ]);
  });

  it("drops an out-of-scope source, leaving the default", () => {
    const { bindings } = compileText(
      ["# infisical", "# (development)", "#     /shared", "A=fallback"].join("\n"),
      "production"
    );
    expect(bindings[0]?.sources).toEqual([]);
    expect(bindings[0]?.default).toBe("fallback");
  });

  it("treats an undecorated assignment as a source-less literal", () => {
    const { bindings } = compileText("NODE_ENV=production");
    expect(bindings[0]).toMatchObject({
      targetVar: "NODE_ENV",
      sources: [],
      default: "production",
    });
  });

  it("compiles a multi-provider fallback chain in order", () => {
    const { bindings } = compileText(
      [
        "# infisical",
        "#     /shared",
        "#     PRIMARY",
        "# vault",
        "#     /team/item",
        "#     FIELD",
        "TOKEN=",
      ].join("\n")
    );
    expect(bindings[0]?.sources).toEqual([
      { provider: "infisical", path: "/shared", sourceKey: "PRIMARY" },
      { provider: "vault", path: "/team/item", sourceKey: "FIELD" },
    ]);
  });

  it("normalizes the container path", () => {
    const { bindings } = compileText(
      ["# infisical", "#     shared/db/", "A="].join("\n")
    );
    expect(bindings[0]?.sources[0]?.path).toBe("/shared/db");
  });

  it("sorts bindings by target var", () => {
    const { bindings } = compileText(["B=1", "A=2", "C=3"].join("\n"));
    expect(bindings.map((b) => b.targetVar)).toEqual(["A", "B", "C"]);
  });

  it("throws on a duplicate target variable", () => {
    expect(() => compileText(["A=1", "A=2"].join("\n"))).toThrow(EnvSourceError);
  });

  it("propagates parse errors as an EnvSourceError", () => {
    expect(() => compileText("1BAD=x")).toThrow(EnvSourceError);
  });
});
