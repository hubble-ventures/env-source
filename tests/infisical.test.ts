import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InfisicalApiProvider,
  InfisicalCliProvider,
  infisicalCliAvailable,
  type SpawnFn,
} from "../src/providers/infisical.js";

type FetchArgs = Parameters<typeof fetch>;

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: FetchArgs[0], init?: FetchArgs[1]) =>
    Promise.resolve(handler(String(input), init as RequestInit))
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InfisicalApiProvider (CI / OIDC lane)", () => {
  it("reads a folder, requesting imports + reference expansion, and selects keys", async () => {
    const spy = stubFetch(() =>
      jsonResponse({
        secrets: [
          { secretKey: "A", secretValue: "1" },
          { secretKey: "B", secretValue: "2" },
        ],
      })
    );
    const provider = new InfisicalApiProvider({ token: "t", project: "acme" });
    const values = await provider.read("development", "/shared", ["A"]);
    expect(values).toEqual({ A: "1" });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("workspaceSlug=acme");
    expect(url).toContain("environment=development");
    expect(url).toContain("include_imports=true");
    expect(url).toContain("expandSecretReferences=true");
  });

  it("merges imported secrets, with the folder's own key winning", async () => {
    stubFetch(() =>
      jsonResponse({
        secrets: [{ secretKey: "SHARED", secretValue: "local" }],
        imports: [{ secrets: [{ secretKey: "SHARED", secretValue: "imported" }] }],
      })
    );
    const provider = new InfisicalApiProvider({ token: "t", project: "acme" });
    expect(await provider.read("development", "/a", ["SHARED"])).toEqual({
      SHARED: "local",
    });
  });

  it("peeks existence without returning values", async () => {
    stubFetch(() =>
      jsonResponse({ secrets: [{ secretKey: "A", secretValue: "secret!" }] })
    );
    const provider = new InfisicalApiProvider({ token: "t", project: "acme" });
    expect([...(await provider.peek("development", "/shared", ["A", "B"]))]).toEqual([
      "A",
    ]);
  });

  it("exchanges an OIDC JWT for a token via loginWithOidc", async () => {
    const spy = stubFetch((url) => {
      if (url.includes("/auth/oidc-auth/login"))
        return jsonResponse({ accessToken: "minted-token" });
      return jsonResponse({ secrets: [] });
    });
    const provider = await InfisicalApiProvider.loginWithOidc({
      identityId: "id-123",
      jwt: "jwt-abc",
      project: "acme",
    });
    await provider.read("development", "/shared", []);
    const readCall = spy.mock.calls.find((c) =>
      String(c[0]).includes("/secrets/raw")
    );
    const headers = (readCall?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer minted-token");
  });

  it("retries then throws on a persistent non-ok read", async () => {
    const spy = stubFetch(() => new Response("boom", { status: 500 }));
    const provider = new InfisicalApiProvider({
      token: "t",
      project: "acme",
      retry: { attempts: 3, baseMs: 0 },
    });
    await expect(provider.read("development", "/shared", ["A"])).rejects.toThrow(
      /500/
    );
    expect(spy.mock.calls.length).toBe(3); // retried to exhaustion
  });
});

describe("InfisicalCliProvider (local lane)", () => {
  const okSpawn =
    (dotenv: string): SpawnFn =>
    () => ({ status: 0, stdout: dotenv, stderr: "" });

  it("reads via `infisical export` and selects keys", async () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: "A=1\nB=2\n", stderr: "" };
    };
    const provider = new InfisicalCliProvider({ projectId: "pid", spawn });
    expect(await provider.read("development", "/shared", ["A"])).toEqual({ A: "1" });
    expect(calls[0]).toContain("export");
    expect(calls[0]).toContain("--projectId=pid");
    expect(calls[0]).toContain("--env=development");
    expect(calls[0]).toContain("--path=/shared");
  });

  it("peeks via export output", async () => {
    const provider = new InfisicalCliProvider({
      projectId: "pid",
      spawn: okSpawn("A=1\nB=2\n"),
    });
    expect([...(await provider.peek("development", "/x", ["A", "C"]))]).toEqual(["A"]);
  });

  it("throws a helpful error when the CLI fails", async () => {
    const spawn: SpawnFn = () => ({
      status: 1,
      stdout: "",
      stderr: "not logged in",
    });
    const provider = new InfisicalCliProvider({
      projectId: "pid",
      spawn,
      retry: { attempts: 2, baseMs: 0 },
    });
    await expect(provider.read("development", "/x", ["A"])).rejects.toThrow(
      /infisical export failed/
    );
  });

  it("detects CLI availability from --version exit status", () => {
    expect(
      infisicalCliAvailable(() => ({ status: 0, stdout: "1.0", stderr: "" }))
    ).toBe(true);
    expect(
      infisicalCliAvailable(() => ({ status: 127, stdout: "", stderr: "" }))
    ).toBe(false);
  });
});
