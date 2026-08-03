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

function secretResponse(key: string, value: string): Response {
  return jsonResponse({ secret: { secretKey: key, secretValue: value } });
}

describe("InfisicalApiProvider (CI / OIDC lane)", () => {
  it("fetches only the declared keys, one request per key, and omits 404s", async () => {
    const spy = stubFetch((url) => {
      if (/\/raw\/A\?/.test(url)) return secretResponse("A", "1");
      return new Response("nope", { status: 404 });
    });
    const provider = new InfisicalApiProvider({ token: "t", project: "acme" });
    const values = await provider.read("development", "/shared", ["A", "ABSENT"]);
    expect(values).toEqual({ A: "1" }); // ABSENT omitted, never faked
    expect(spy).toHaveBeenCalledTimes(2); // one request per declared key
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toMatch(/\/secrets\/raw\/(A|ABSENT)\?/); // single-secret endpoint
    expect(url).toContain("workspaceSlug=acme");
    expect(url).toContain("expandSecretReferences=true");
    // No folder-listing endpoint (`/secrets/raw?…`) is ever hit.
    expect(spy.mock.calls.every((c) => /\/secrets\/raw\/[^?]+\?/.test(String(c[0])))).toBe(true);
  });

  it("peeks per key by status alone, never parsing the value body", async () => {
    stubFetch((url) => {
      // Present key returns a body that is NOT valid JSON — if peek tried to
      // parse the value it would throw; asserting success proves it does not.
      if (/\/raw\/A\?/.test(url)) return new Response("<binary>", { status: 200 });
      return new Response("nope", { status: 404 });
    });
    const provider = new InfisicalApiProvider({ token: "t", project: "acme" });
    expect([...(await provider.peek("development", "/shared", ["A", "B"]))]).toEqual([
      "A",
    ]);
  });

  it("exchanges an OIDC JWT for a token via loginWithOidc", async () => {
    const spy = stubFetch((url) => {
      if (url.includes("/auth/oidc-auth/login"))
        return jsonResponse({ accessToken: "minted-token" });
      return secretResponse("A", "1");
    });
    const provider = await InfisicalApiProvider.loginWithOidc({
      identityId: "id-123",
      jwt: "jwt-abc",
      project: "acme",
    });
    await provider.read("development", "/shared", ["A"]);
    const readCall = spy.mock.calls.find((c) =>
      String(c[0]).includes("/secrets/raw/A")
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
  // A spawn that exports a fixed folder, in the shape `infisical export
  // --format=json` returns: an array of records carrying `key` and `value`.
  const vaultSpawn =
    (vault: Record<string, string>): SpawnFn =>
    () => ({
      status: 0,
      stdout: JSON.stringify(
        Object.entries(vault).map(([key, value]) => ({
          key,
          value,
          secretPath: "/shared",
          type: "shared",
        }))
      ),
      stderr: "",
    });

  it("reads a folder in one invocation and returns only the declared keys", async () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      return vaultSpawn({ A: "1", B: "2", UNDECLARED: "3" })(cmd, args);
    };
    const provider = new InfisicalCliProvider({ projectId: "pid", spawn });
    expect(await provider.read("development", "/shared", ["A", "MISSING"])).toEqual({
      A: "1", // MISSING omitted (absent); UNDECLARED never returned
    });
    expect(calls).toHaveLength(1); // one call for the folder, not one per key
    expect(calls[0]).toEqual([
      "infisical",
      "export",
      "--format=json",
      "--projectId=pid",
      "--env=development",
      "--path=/shared",
      "--expand=true",
      "--include-imports=true",
      "--silent",
    ]);
  });

  it("does not re-request a folder it has already read", async () => {
    let calls = 0;
    const spawn: SpawnFn = (cmd, args) => {
      calls++;
      return vaultSpawn({ A: "1", B: "2" })(cmd, args);
    };
    const provider = new InfisicalCliProvider({ projectId: "pid", spawn });
    const [values, present] = await Promise.all([
      provider.read("development", "/shared", ["A"]),
      provider.peek("development", "/shared", ["B"]),
    ]);
    expect(values).toEqual({ A: "1" });
    expect([...present]).toEqual(["B"]);
    expect(calls).toBe(1); // concurrent callers collapse onto one request
  });

  it("requests each distinct folder and environment separately", async () => {
    const paths: string[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      paths.push(args.find((a) => a.startsWith("--path=")) as string);
      return vaultSpawn({ A: "1" })(cmd, args);
    };
    const provider = new InfisicalCliProvider({ projectId: "pid", spawn });
    await provider.read("development", "/one", ["A"]);
    await provider.read("development", "/two", ["A"]);
    await provider.read("production", "/one", ["A"]);
    expect(paths).toEqual(["--path=/one", "--path=/two", "--path=/one"]);
  });

  it("peeks from folder membership", async () => {
    const provider = new InfisicalCliProvider({
      projectId: "pid",
      spawn: vaultSpawn({ A: "1" }),
    });
    expect([...(await provider.peek("development", "/x", ["A", "C"]))]).toEqual(["A"]);
  });

  it("reads an empty folder as absent keys", async () => {
    // `infisical export` formats an empty folder as `[]` (the CLI initialises
    // the slice), so this must parse rather than trip the not-an-array guard.
    const provider = new InfisicalCliProvider({
      projectId: "pid",
      spawn: () => ({ status: 0, stdout: "[]", stderr: "" }),
    });
    expect(await provider.read("development", "/empty", ["A"])).toEqual({});
  });

  it("treats an absent folder as absent keys, not an error", async () => {
    const spawn: SpawnFn = () => ({
      status: 1,
      stdout: "",
      stderr: "folder does not exist",
    });
    const provider = new InfisicalCliProvider({
      projectId: "pid",
      spawn,
      retry: { attempts: 1, baseMs: 0 },
    });
    expect(await provider.read("development", "/gone", ["A"])).toEqual({});
  });

  it("surfaces a real error (e.g. not logged in) rather than treating it as absent", async () => {
    const spawn: SpawnFn = () => ({
      status: 1,
      stdout: "",
      stderr: "You must be logged in to run this command",
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

  it("does not cache a failed folder read", async () => {
    let calls = 0;
    const spawn: SpawnFn = (cmd, args) => {
      calls++;
      if (calls === 1) return { status: 1, stdout: "", stderr: "network is down" };
      return vaultSpawn({ A: "1" })(cmd, args);
    };
    const provider = new InfisicalCliProvider({
      projectId: "pid",
      spawn,
      retry: { attempts: 1, baseMs: 0 },
    });
    await expect(provider.read("development", "/x", ["A"])).rejects.toThrow(
      /infisical export failed/
    );
    // The failure is not replayed from cache: a later read tries again.
    expect(await provider.read("development", "/x", ["A"])).toEqual({ A: "1" });
  });

  it("retries malformed output rather than reading it as an empty folder", async () => {
    let calls = 0;
    const spawn: SpawnFn = (cmd, args) => {
      calls++;
      // Truncated stdout first, then a good response.
      if (calls === 1) return { status: 0, stdout: '[{"key":"A","val', stderr: "" };
      return vaultSpawn({ A: "1" })(cmd, args);
    };
    const provider = new InfisicalCliProvider({
      projectId: "pid",
      spawn,
      retry: { attempts: 2, baseMs: 0 },
    });
    expect(await provider.read("development", "/x", ["A"])).toEqual({ A: "1" });
    expect(calls).toBe(2);
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
