# @hubble-ventures/env-source

Populate `.env` files from **orchestrated secret providers**, driven by decorated
`.env.source` manifests — one format for local dev and CI.

You declare *where each variable comes from* right next to the variable, in a file
that reads like a `.env`. `env-source` discovers those manifests across a
monorepo, resolves each variable through the right provider (Infisical and
1Password today; the provider layer is pluggable), and writes a plain `.env` next
to each manifest — or, in CI, loads the values straight into the job environment.

```
.env.source            ← the manifest: variables + where they come from (committed)
env-source.toml        ← root, non-secret provider context (committed)
        │
        ▼  env-source pull
.env                   ← resolved values (gitignored)
```

## The `.env.source` format

It's `dotenv` with **sticky decorators** (think frontmatter). A comment block says
which provider sources the variables *below* it, from which container, in which
environments — and that context **applies to every assignment until the next
decorator changes it**. You write the provider and path once, not per key:

```dotenv
# infisical                          ← provider id (opens a group)
# (development,preview,production)    ← environments the provider is consulted in
#     /clerk                         ← provider container path
CLERK_SECRET_KEY=                    ← sourced from /clerk
GOOGLE_IOS_CLIENT_ID=                ← same group — no need to repeat the decorator
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
```

**What is sticky vs. one-shot**

- **Provider, container path, and environments are sticky** — they carry down to
  every assignment until a new decorator replaces them.
- **A source-key alias is one-shot** — a bare `#  SOURCE_KEY` line aliases only
  the *immediately following* key (source keys are inherently per-variable):
  ```dotenv
  # infisical
  #     /clerk
  #     CLERK_PUBLISHABLE_KEY        ← one-shot: applies to the next key only
  VITE_CLERK_PUBLISHABLE_KEY=
  CLERK_SECRET_KEY=                  ← reverts to its own name
  ```
- **Blank lines are cosmetic** — they never end a group. Format for readability
  freely.
- **`# literal`** clears the provider context, so the keys below are literals
  (their value is the right-hand side). Literals also work at the top of a file,
  before any decorator:
  ```dotenv
  # literal
  NODE_ENV=production
  PORT=8080
  ```

**Other rules**

- **No environments line** → the provider is consulted in *all* environments.
- **The right of `=`** is an optional fallback default. An empty RHS or a
  `<placeholder>` means "no concrete default". When no source yields a value, the
  variable falls back to this default (and is dropped if there is none).
- **Several provider blocks with no key between them** stack into a **fallback
  chain** — each is tried in order until one has the key, then the default:
  ```dotenv
  # infisical
  #     /shared
  # onepassword
  #     /vault/item
  API_TOKEN=<optional default>
  ```
- Provider ids come from `env-source.toml`, so a container key that happens to be
  a lowercase word (`token`, `secret`) is never mistaken for a provider.

Putting it together:

```dotenv
# infisical
# (development,preview,production)
#     /payments/stripe
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
#     STRIPE_WEBHOOK_SIGNING_SECRET   ← one-shot alias for the next key
WEBHOOK_SECRET=

# Sourced only in dev; every other environment falls back to the default.
# infisical
# (development)
#     /shared
DEBUG_TOKEN=off

# literal
NODE_ENV=production
```

## Root config — `env-source.toml`

Non-secret provider context, committed at (or above) the workspace root.
Credentials never live here — they come from the environment at resolve time.

```toml
default_environment = "development"
output = ".env"

[providers.infisical]
project = "acme-payments"                          # project slug — CI (REST/OIDC) lane
# project_id = "…uuid…"                             # project id — local CLI lane (or $INFISICAL_PROJECT_ID)
oidc_audience = "https://github.com/your-org"      # CI OIDC audience (optional)

[providers.onepassword]
account = "acme.1password.com"                     # local desktop-app lane (or $OP_ACCOUNT)
vault = "Engineering"                              # used when a path names only an item
[providers.onepassword.vaults]                     # optional per-environment override
production = "Production"
```

## CLI

```bash
npx @hubble-ventures/env-source pull                 # write .env (0600) next to each manifest
npx @hubble-ventures/env-source pull --env preview   # resolve a specific environment
npx @hubble-ventures/env-source run -- npm run dev   # inject into a process; nothing hits disk
npx @hubble-ventures/env-source validate             # structural checks
npx @hubble-ventures/env-source validate --against-providers  # + peek the live vault
npx @hubble-ventures/env-source validate --check-values       # + flag present-but-empty values
npx @hubble-ventures/env-source diff --base origin/main  # what changed in the manifest surface
npx @hubble-ventures/env-source migrate secrets.json     # convert a legacy infisicml manifest
npx @hubble-ventures/env-source list                 # summarize discovered manifests
```

Add `--profile <name>` to any resolving command to load a sibling
`.env.<name>.source` where it exists (e.g. a `deploy` profile).

Infisical auth has exactly two lanes:
- **local** — the Infisical CLI, using your own `infisical login` session.
  env-source shells out to it and never handles a token.
- **CI** — GitHub OIDC (`INFISICAL_IDENTITY_ID` + `permissions: id-token: write`).

### `diff` — review the manifest surface on a PR

`diff` compares each manifest against a git ref and reports what a reviewer cares
about — variables added/removed and any variable whose *source* moved (provider,
container path, source key, or environment scope). It reads no secret values, so
it's safe to run on every PR. It exits non-zero when anything changed (use
`--exit-zero` to report without failing).

```
apps/api
+ B         ← infisical /shared:B
+ NODE_ENV  ← literal
~ A         infisical /shared:A → infisical /other:A
```

### `migrate` — from legacy infisicml `secrets.json`

`migrate secrets.json` converts a legacy manifest into `.env.source` (plus a
sibling `.env.<profile>.source` per profile). It prints a dry run by default;
add `--write` to create the files. Concepts env-source doesn't model
(`environments.*.optionalKeys`, `ci`) are reported as warnings, not dropped
silently.

## GitHub Action

Load resolved secrets into the job environment for later steps. Authentication is
GitHub OIDC — no long-lived credential.

```yaml
permissions:
  id-token: write            # required — mints the OIDC token
steps:
  - uses: actions/checkout@v4
  - uses: hubble-ventures/env-source@v1
    with:
      command: pull
      environment: production
      identity-id: ${{ vars.INFISICAL_IDENTITY_ID }}
  - run: node server.js      # secrets are now in the environment (masked in logs)
```

Gate manifest changes on a PR (no secrets read; posts a sticky comment + job summary):

```yaml
permissions:
  contents: read
  pull-requests: write       # for the sticky comment
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 } # diff needs the base ref
  - uses: hubble-ventures/env-source@v1
    with:
      command: diff
      base: ${{ github.event.pull_request.base.sha }}
      comment: 'true'
      fail-on-change: 'false'
```

## Providers

A provider defines three capabilities the core orchestrates over:

| Capability | Purpose |
| ---------- | ------- |
| **auth**   | Establish access (a local session — CLI or desktop app — or a CI credential). |
| **read**   | Resolve values for the declared keys at a container path. |
| **peek**   | Assert a key *exists* without surfacing its value (used by `validate`). |

**Least privilege, as far as the lane allows.** Nothing you didn't declare is
ever written to a `.env` — a provider returns the declared keys and drops the
rest. How little crosses the wire depends on what the backend actually offers:

- **Infisical over REST (CI).** `/secrets/raw/{key}` is a genuine single-secret
  endpoint, so each declared key is fetched by name, one request per key, and
  nothing else leaves the vault. `peek` asserts existence from the response
  status without reading the value.
- **Infisical over the CLI (local).** `infisical secrets get <KEY>` resolves
  server-side to `GET /secrets/raw?secretPath=P` — the *folder* endpoint, with no
  key filter — and filters client-side. The whole folder crosses the wire
  whichever way you ask, so asking per key buys no privacy and multiplies the
  requests by the number of declared keys (74 keys once cost 74 full-folder
  reads and a `429`). This lane therefore reads each folder once via
  `infisical export`, memoised per environment and path, and selects the declared
  keys from it — strictly less data over the wire than per-key. The trade is that
  the folder's other values pass through memory for the life of the command, and
  `peek` here is membership in that folder rather than a value-free status check.
- **1Password over the SDK.** `items.get` returns a whole item whichever way you
  ask — there is no single-field endpoint — so each declared item is read once,
  memoised per environment and path, and the declared field names are selected
  from it. Reading per key would cost one request per key and buy no privacy.
  That matters more here than elsewhere: 1Password meters *per request*, and the
  per-account daily ceiling is 1,000 reads/24h on Individual, Families and Teams
  plans (50,000 on Business). For the same reason a rate-limited read is not
  retried: repeating a request the vault refused for exceeding a *per-request*
  quota only spends more of a budget that is already gone, and the backoff is far
  shorter than the reset window. Name → id lookups use the overview endpoints,
  which never return field values. As with the Infisical CLI lane, the item's other
  fields pass through memory for the life of the command, and `peek` is
  membership in the fetched item rather than a value-free status check.

### 1Password

Paths address an item, optionally qualified by vault and section. `{env}` is
replaced with the environment being resolved, and the declared keys are field
names inside the item:

```dotenv
# onepassword
#     /Engineering/stripe-{env}       ← vault / item
STRIPE_SECRET_KEY=
#     /Engineering/stripe/webhooks    ← vault / item / section
SIGNING_SECRET=
#     /stripe                         ← item in the configured vault
API_KEY=
```

Without a section segment every field in the item is eligible and the first
occurrence of a name wins; add the section when two sections share a field name.
A path segment may be a 26-character 1Password id instead of a name; titles are
matched first, so a vault or item genuinely *named* like an id still resolves to
itself.

Auth has two lanes, both through the SDK:
- **local** — the 1Password desktop app, using your own unlocked session
  (biometric or password approval). env-source never handles a token. The client
  is built on the first read, so `list` and `diff` never prompt.
- **CI** — a service account token in `OP_SERVICE_ACCOUNT_TOKEN`.

Two caveats worth stating plainly. Unlike the Infisical lane, **CI here holds a
long-lived credential** — 1Password's workload-identity (OIDC) auth is in public
preview and not wired up yet; `ResolveContext.getOidcJwt` is where it will go.
And the SDK is an **optional peer dependency**, so a workspace that uses this
provider installs it itself:

```bash
npm install @1password/sdk
```

Infisical and 1Password ship in the box. The `Provider` interface
(`src/core/types.ts`) is the extension point for the process environment,
password managers, and anything else.

## Library

```ts
import {
  loadConfig,
  parseEnvSource,
  compile,
  materialize,
  resolveProviders,
} from "@hubble-ventures/env-source";
```

`parse → compile → materialize` is a pure pipeline over a `Provider`; the adapters
(`workspace`, `gha`) and the concrete providers sit around that core.

## License

MIT
