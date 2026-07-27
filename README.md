# @hubble-ventures/env-source

Populate `.env` files from **orchestrated secret providers**, driven by decorated
`.env.source` manifests — one format for local dev and CI.

You declare *where each variable comes from* right next to the variable, in a file
that reads like a `.env`. `env-source` discovers those manifests across a
monorepo, resolves each variable through the right provider (Infisical today; the
provider layer is pluggable), and writes a plain `.env` next to each manifest —
or, in CI, loads the values straight into the job environment.

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
| **auth**   | Establish access (Infisical: local CLI session, or GitHub OIDC in CI). |
| **read**   | Resolve values for the declared keys at a container path. |
| **peek**   | Assert a key *exists* without surfacing its value (used by `validate`). |

**Least privilege by construction.** A provider only ever requests the keys a
manifest explicitly declares — one request per key, no folder listing or export.
Nothing you didn't name crosses the wire, and `peek` asserts existence by status
alone, never reading the value.

Infisical ships in the box. The `Provider` interface (`src/core/types.ts`) is the
extension point for 1Password, the process environment, and password managers.

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
