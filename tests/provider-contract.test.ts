import { afterEach, vi } from "vitest";
import {
  InfisicalApiProvider,
  InfisicalCliProvider,
  type SpawnFn,
} from "../src/providers/infisical.js";
import {
  OnePasswordProvider,
  type OnePasswordClient,
} from "../src/providers/onepassword.js";
import { FakeProvider } from "./helpers.js";
import {
  ABSENT_PATH,
  CONTRACT_DATA,
  describeProviderContract,
} from "./provider-contract.js";

// One fixture per provider, each serving CONTRACT_DATA over its real transport —
// the REST endpoints, the CLI's argv and stdout, the SDK's client surface — so
// the suite exercises each adapter's own parsing and lookup code, not a shared
// stand-in. Retries are capped at one attempt: nothing here fails transiently,
// and the default policy would only add backoff sleeps to a red test.

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The container at (environment, path), or undefined when there is none. */
function container(
  environment: string,
  path: string
): Record<string, string> | undefined {
  return CONTRACT_DATA[environment]?.[path];
}

// --- Infisical, REST lane (CI) ---------------------------------------------
// Serves the single-secret endpoint the provider actually calls, keyed off the
// query string it builds: an unknown key or an unknown folder is a 404.

function infisicalApiFixture(): InfisicalApiProvider {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      const key = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const folder = container(
        url.searchParams.get("environment") ?? "",
        url.searchParams.get("secretPath") ?? ""
      );
      if (!folder || !Object.hasOwn(folder, key)) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ secret: { secretKey: key, secretValue: folder[key] } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    })
  );
  return new InfisicalApiProvider({
    token: "t",
    project: "acme",
    retry: { attempts: 1 },
  });
}

// --- Infisical, CLI lane (local) -------------------------------------------
// Reads --env/--path off the argv the provider builds and answers as
// `infisical export --format=json` does; an unknown folder exits non-zero with a
// not-found message, which the provider must read as an absent container.

const fakeInfisicalSpawn: SpawnFn = (_command, args) => {
  const flag = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? "";
  const folder = container(flag("env"), flag("path"));
  if (!folder) {
    return { status: 1, stdout: "", stderr: "folder not found" };
  }
  const entries = Object.entries(folder).map(([key, value]) => ({ key, value }));
  return { status: 0, stdout: JSON.stringify(entries), stderr: "" };
};

function infisicalCliFixture(): InfisicalCliProvider {
  return new InfisicalCliProvider({
    projectId: "proj",
    spawn: fakeInfisicalSpawn,
    retry: { attempts: 1 },
  });
}

// --- 1Password (SDK) --------------------------------------------------------
// 1Password has no environment axis of its own, so the fixture uses the mapping
// the provider offers for exactly this: a vault per environment, with the
// manifest path naming only the item.

const VAULTS: Record<string, string> = {
  development: "Dev",
  production: "Prod",
};

function onePasswordClient(): OnePasswordClient {
  const vaults = Object.entries(VAULTS).map(([environment, title]) => ({
    id: `vault-${title}`,
    title,
    environment,
  }));

  const itemsIn = (vaultId: string) => {
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) return [];
    // A container path of `/shared` names the item `shared`.
    return Object.keys(CONTRACT_DATA[vault.environment] ?? {}).map((path) => ({
      id: `item${path}`,
      title: path.replace(/^\//, ""),
      environment: vault.environment,
      path,
    }));
  };

  return {
    vaults: {
      list: () =>
        Promise.resolve(vaults.map(({ id, title }) => ({ id, title }))),
    },
    items: {
      list: (vaultId) =>
        Promise.resolve(itemsIn(vaultId).map(({ id, title }) => ({ id, title }))),
      get: (vaultId, itemId) => {
        const found = itemsIn(vaultId).find((i) => i.id === itemId);
        const folder = found && container(found.environment, found.path);
        if (!folder) return Promise.reject(new Error("item not found"));
        return Promise.resolve({
          id: itemId,
          title: found.title,
          fields: Object.entries(folder).map(([title, value]) => ({
            id: `f-${title}`,
            title,
            value,
          })),
        });
      },
    },
  };
}

function onePasswordFixture(): OnePasswordProvider {
  return new OnePasswordProvider({
    client: () => Promise.resolve(onePasswordClient()),
    vaults: VAULTS,
    retry: { attempts: 1 },
  });
}

// --- The suite, once per implementation -------------------------------------

describeProviderContract("InfisicalApiProvider", infisicalApiFixture);
describeProviderContract("InfisicalCliProvider", infisicalCliFixture);
describeProviderContract("OnePasswordProvider", onePasswordFixture);
// The in-memory double the core's own tests resolve against. Holding it to the
// same contract is what makes those tests evidence about the real providers.
describeProviderContract(
  "FakeProvider (test double)",
  () => new FakeProvider("fake", CONTRACT_DATA)
);

// A path the fixtures deliberately do not define, asserted here so the constant
// can't drift into one that exists and quietly weaken the absent-container test.
if (Object.values(CONTRACT_DATA).some((paths) => ABSENT_PATH in paths)) {
  throw new Error(`ABSENT_PATH ${ABSENT_PATH} must not exist in CONTRACT_DATA`);
}
