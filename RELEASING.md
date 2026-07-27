# Releasing

`env-source` ships two consumable artifacts from one repo:

- the **npm package** `@hubble-ventures/env-source` (library + `env-source` CLI), and
- the **GitHub Action** `hubble-ventures/env-source@v1` (the committed
  `action/index.cjs` bundle).

## One-time GitHub / npm setup (needs your credentials)

1. Create the GitHub repo `hubble-ventures/env-source` and add the remote:
   ```bash
   git remote add origin git@github.com:hubble-ventures/env-source.git
   git push -u origin main
   ```
2. Add an npm automation token as the repo secret `NPM_TOKEN` (Settings →
   Secrets → Actions). The release workflow publishes with `--provenance`.

## Cutting a version

1. Bump the version and rebuild (the `version` script runs the build so `dist/`
   and `action/index.cjs` are fresh):
   ```bash
   npm version minor        # or patch / major
   ```
2. Commit the version bump + rebuilt bundle, tag, and push:
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push && git push --tags
   ```
   The tag push triggers `.github/workflows/release.yml`, which tests, builds,
   and `npm publish`es.
3. Move the floating major tag so `uses: hubble-ventures/env-source@v1` picks up
   the release:
   ```bash
   git tag -f v1 vX.Y.Z
   git push -f origin v1
   ```

## Notes

- CI (`.github/workflows/ci.yml`) fails if `action/index.cjs` is out of sync with
  `src/` — always `npm run build` after changing anything under `src/`.
- The npm package excludes `action/`; the Action is consumed from the git repo,
  not the tarball.
