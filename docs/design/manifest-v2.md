# Manifest v2 — separating the emitted surface from secret sourcing

**Status:** draft / WIP — design only, no implementation yet
**Motivates:** [#5](https://github.com/hubble-ventures/env-source/issues/5)

## Problem

A `.env.source` line binds two independent concerns at once:

- **the emitted surface** — which environment variable names get written
- **the resolution** — which provider, container path, source key and
  environments produce each value

Profiles today swap the *whole file*: `--profile deploy` reads
`.env.deploy.source` in place of `.env.source`
([`workspace.ts:82`](../../src/adapters/workspace.ts)). Because a profile
replaces rather than layers, both concerns move together, and three defects
follow.

**Nothing enumerates profiles.** `discoverManifests` matches the exact basename
`.env.source` ([`workspace.ts:64`](../../src/adapters/workspace.ts)), so a
profile manifest is reachable only when the caller already knows to name it.
`diff`, `validate` and `list` — the commands that answer whole-workspace
questions — silently answer for a subset. `diff` prints `No manifest changes.`
for a PR that changed nothing but profile manifests, which is indistinguishable
from having looked and found nothing.

**Profile-only keys are validated by nothing.** A key declared in
`.env.<profile>.source` but not in `.env.source` is covered only if a `validate`
run names that profile. As reported in #5, this left an entire release lane's
credentials unchecked against the vault for as long as the check had existed,
and the gap surfaced only when a missing production key was found by accident.

**`--profile` does not scope.** `resolvedManifestPath` falls back to the base
file wherever the profile file is absent
([`workspace.ts:99`](../../src/adapters/workspace.ts)), so `--profile X`
still processes every manifest in the workspace — redundant provider round
trips for `validate`, and misattributed output for `diff`.

There is also a case no flag recovers: a `.env.<profile>.source` with no
`.env.source` sibling is unreachable by every command, because discovery never
yields its directory. It parses, it is committed, it looks declared, and it is
inert.

## Direction

Split the two concerns into two files.

| File | Owns |
|---|---|
| `.env.source.yaml` | the secret graph: keys, providers, paths, source keys, environments, per-profile variation |
| `.env.source` | the projection: which env var names are emitted, and which manifest key feeds each |
| `env-source.toml` | unchanged — provider *connection* context, plus per-profile `output` |

This is a breaking format change. It is proposed for 0.x on the grounds that
the current format cannot express the above correctly without one.

### What it buys

- Discovery becomes trivially correct: exactly one `.env.source` and one
  `.env.source.yaml` per directory, both always found.
- Profiles are data, so `discoverProfiles()` is a read rather than a scan, and
  `--profile X` scopes to the directories that declare X.
- The full set of env vars a directory can emit is auditable in one file,
  always — no key can hide inside a profile nobody named.
- `diff` splits into the two questions a reviewer actually asks separately:
  *did the emitted surface move?* (`.env.source`) and *did a secret's origin
  move?* (`.env.source.yaml`).
- [`parse.ts`](../../src/core/parse.ts) — 217 lines, the largest core file,
  almost entirely a sticky-decorator state machine — collapses to a
  line-per-entry parser.

### What it costs

- Every existing manifest must be converted. Mechanically, via
  `migrate --format v2`: decorators become manifest entries, assignments become
  projections, and each `.env.<profile>.source` becomes a profile column by
  diffing it against its base.
- A directory with no profiles now needs two files where one sufficed.
- Key-major layout gives up "write the provider and path once per group". YAML
  anchors restore it for authors who want it (see below).

## `.env.source.yaml`

A flat map: manifest key → profile → source. `default` is the reserved profile
name used when no `--profile` is passed.

```yaml
KEY:
  default: /container/path
  <profile>:
    path: /other/path
    environments:
      - production
```

### Value forms

| Form | Meaning |
|---|---|
| string | container path; provider defaults from `env-source.toml`, all environments |
| map | `path`, `provider`, `key`, `environments`, `literal` as needed |
| list of maps | fallback chain, tried in order |
| `null` | key explicitly excluded from this profile |

`provider` may be omitted whenever exactly one provider is configured under
`[providers.*]`, which is the common case. `key` is needed only when the name
in the vault differs from the manifest key.

A fallback chain, for the rare key that needs one:

```yaml
API_TOKEN:
  default:
    - path: /shared
    - provider: onepassword
      path: /vault/item
```

The `=` fallback default from v1 becomes the last entry in the chain:

```yaml
DEBUG_TOKEN:
  default:
    - path: /shared
      environments:
        - development
    - literal: "off"
```

### Profile semantics

Four rules, no additional syntax:

1. `default` is the profile used when none is named.
2. A profile that does not list a key inherits that key's `default`.
3. A key with **no** `default` exists only in the profiles it lists — this is
   how a key becomes profile-only, and it replaces any need for `only:` /
   `except:` markers.
4. `<profile>: null` excludes a key that `default` would otherwise provide.

### Anchors

Top-level entries whose name is not a valid environment variable
(`[A-Z_][A-Z0-9_]*`) are ignored by the loader, reserving them as anchor scratch
space — the `x-` convention from Docker Compose. This restores real grouping for
authors who want the path written once:

```yaml
x-auth: &auth
  path: /auth

AUTH_PUBLISHABLE_KEY:
  default: *auth
AUTH_SECRET_KEY:
  default: *auth
```

A typo is then a YAML error rather than a wrong lookup. Opt-in; nobody who does
not want anchors ever sees them.

## `.env.source`

Maps manifest keys to emitted names. No decorators, no providers, no paths.

```dotenv
PAYMENTS_SECRET_KEY=
WEBHOOK_SECRET=
VITE_PAYMENTS_KEY=${PAYMENTS_PUBLISHABLE_KEY}
PORT=${SERVER_PORT:-8080}
NODE_ENV=production
```

| Form | Meaning |
|---|---|
| `VAR=` | references manifest key `VAR` |
| `VAR=${KEY}` | references manifest key `KEY` under a different emitted name |
| `VAR=${KEY:-fallback}` | reference with a projection-level fallback |
| `VAR=text` | inline constant, no manifest involvement |

The `${…}` sigil separates a reference from a constant, so `NODE_ENV=production`
keeps meaning what it means in any dotenv file.

**One projection file per directory, listing the full possible surface.** When
the active profile does not define a referenced key, that projection is dropped
from the output. This is how per-profile surfaces work without per-profile
projection files.

## Resolution order

1. Load `.env.source.yaml`.
2. For each key, select the active profile's source, falling back to `default`
   per rule 2 above; drop keys resolving to `null` or absent per rule 3.
3. → a key table: manifest key → sources, environments.
4. Parse `.env.source` → projections.
5. Drop projections whose key is not in the table; bind the rest.
6. `compile()` for the target environment — unchanged from today.

## Validation

| Condition | Code | Level |
|---|---|---|
| Projection references a key defined in no profile | `unknown_manifest_key` | error |
| Projection references a key absent from the active profile | `key_not_in_profile` | info — expected; reported in coverage |
| Manifest key projected by nothing | `unprojected_key` | warning |
| Two projections emitting the same name | `duplicate_target` | error (exists today) |
| Profile referenced that `env-source.toml` does not declare | `unknown_profile` | error |

`unprojected_key` is the orphan case from #5, now catchable: a key can no longer
be declared, reviewed, merged and silently inert.

## `env-source.toml`

Gains per-profile output. Nothing else changes.

```toml
[profiles.deploy]
output = ".env.deploy"
```

`output` defaults to `.env.<profile>` rather than `.env`. This is a deliberate
break: today `pull --profile deploy` writes `.env`
([`pull.ts:85`](../../src/commands/pull.ts)) and clobbers the base output.
Conversions should set `output = ".env"` explicitly where the current behaviour
is load-bearing.

Declaring profiles here also makes `discoverProfiles()` a read of config that
every command already loads, and gives `validate` a declared list to check
coverage against — so a profile that exists but is never validated becomes a
reportable gap.

## Worked conversion

Modelled on a real manifest pair — a service package with a `deploy` profile,
48 lines of `.env.source` plus 49 of `.env.deploy.source`. The lanes differ by
four declarations out of nineteen: `deploy` adds three keys and drops one.
Everything else is duplication.

### `.env.source.yaml`

```yaml
AUTH_PUBLISHABLE_KEY:
  default: /auth
AUTH_SECRET_KEY:
  default: /auth
NEXT_PUBLIC_AUTH_PUBLISHABLE_KEY:
  default: /auth

# Native OAuth client ids are not set in the preview vault.
OAUTH_IOS_CLIENT_ID:
  default:
    path: /auth
    environments:
      - development
      - production
OAUTH_SERVER_CLIENT_ID:
  default:
    path: /auth
    environments:
      - development
      - production

PARTNER_ENCRYPTION_KEY:
  default: /partner
PARTNER_EMAIL:
  default: /partner
PARTNER_PASSWORD:
  default: /partner
PARTNER_REFRESH_TOKEN:
  default: /partner

NEXT_PUBLIC_PAYMENTS_PUBLISHABLE_KEY:
  default: /payments
PAYMENTS_CONNECT_CLIENT_ID:
  default: /payments
PAYMENTS_SECRET_KEY:
  default: /payments
PAYMENTS_WEBHOOK_SIGNING_SECRET:
  default: /payments

ANALYTICS_PROJECT_TOKEN:
  default: /analytics

BLOB_READ_WRITE_TOKEN:
  default: /storage

# Runtime-only: this service proxies to the sync engine and needs the secret at
# request time, so it must reach the deployment runtime. Preview included — the
# per-PR engine enforces it too. Not in `development`: the local engine runs
# without a secret. The deploy lane does not carry it.
SYNC_ENGINE_SECRET:
  default:
    path: /sync
    environments:
      - preview
      - production
  deploy: null

HOST_API_TOKEN:
  deploy: /host

# Preview deploys resolve these from the deploy job, not from the vault.
SYNC_ENGINE_URL:
  deploy:
    path: /host
    environments:
      - development
      - production
WRITE_API_URL:
  deploy:
    path: /host
    environments:
      - development
      - production
```

### `.env.source`

```dotenv
AUTH_PUBLISHABLE_KEY=
AUTH_SECRET_KEY=
NEXT_PUBLIC_AUTH_PUBLISHABLE_KEY=
OAUTH_IOS_CLIENT_ID=
OAUTH_SERVER_CLIENT_ID=

PARTNER_ENCRYPTION_KEY=
PARTNER_EMAIL=
PARTNER_PASSWORD=
PARTNER_REFRESH_TOKEN=

NEXT_PUBLIC_PAYMENTS_PUBLISHABLE_KEY=
PAYMENTS_CONNECT_CLIENT_ID=
PAYMENTS_SECRET_KEY=
PAYMENTS_WEBHOOK_SIGNING_SECRET=

ANALYTICS_PROJECT_TOKEN=
BLOB_READ_WRITE_TOKEN=

SYNC_ENGINE_SECRET=
HOST_API_TOKEN=
SYNC_ENGINE_URL=
WRITE_API_URL=
```

### Observations from the conversion

Fourteen of nineteen keys are two lines. The five that are not are the five that
carry extra information.

The entire semantic difference between the lanes is now four lines
(`deploy: null` plus three `deploy:` entries). Today it is expressed as the
*absence* of text in a 49-line near-copy, which is why `diff` on a PR touching
the deploy manifest conveys so little.

The duplication drifts in practice. In the pair this example is drawn from, the
deploy manifest's header comment still names the package it was originally
copied from. Harmless in itself, and exactly the failure mode two files that
must agree produce.

## Open questions

1. **Multi-profile activation.** `--profile a,b` is expressible (both columns
   merge) but needs a conflict rule when both define the same key. Proposal:
   ship single-profile, leave the syntax free.
2. **Sharing between sibling profiles.** A family of related profiles must each
   list themselves on every key they share, since key-major layout has no
   equivalent of `extends`. Profile globbing (`release-*:`) would fix it;
   proposal is to ship without and see whether the repetition actually grates.
3. **Single-file usage.** A directory with no profiles now needs two files. An
   inline `projection:` block in the YAML would restore one-file usage; proposal
   is not to build it until someone asks.
4. **v1 support window.** Whether the v1 loader stays for a deprecation period
   or `migrate --format v2` is required at the version boundary.

## Not in this document

Implementation. No parser, schema or command changes are proposed here — the
purpose is to agree the format before any of that is written. The natural first
increment is the zod schema plus the v2 loader behind a flag, with
`migrate --format v2` and the conversion of a real multi-package workspace as
the acceptance test.
