# Where this repository came from

This package was extracted from the `dsh-web` monorepo, where it lived at
`packages/dsh-remote-workspace/`. It exists as its own repository so the
device-workspace federation has a release train, an issue tracker, and a commit
history independent of that monorepo — which also carries the pairing plugin,
the tunnels, the mobile adaptation layer, and a self-update panel this package
has nothing to do with.

## What was lifted

| From `dsh-web` | Here | Note |
| --- | --- | --- |
| `packages/dsh-remote-workspace/**` | repository root | the package is the repository |
| `shared/tsdown.client.ts` | `build/tsdown.client.ts` | the client-bundle preset |
| `shared/web-platform.ts` | `build/web-platform.ts` | the platform seed table the preset reads |
| `shared/host/dsh-home.ts` | `src/dsh-home.ts` | was a generated copy; now an ordinary source |
| `shared/host/loopback.ts` | `src/loopback.ts` | was a generated copy; now an ordinary source |
| `LICENSE` | `LICENSE` | Apache-2.0, unchanged |

## What changed in the move

- **The generated-file headers were rewritten.** `src/dsh-home.ts` and
  `src/loopback.ts` used to carry "do not edit this copy; edit the shared source
  and run scripts/sync-shared.mjs". That script and its `shared/` sources are not
  here, so the headers now say these are ordinary sources.
- **`lightningcss` is declared as a devDependency.** In the monorepo it was a
  root-level dependency shared by every package, so no package declared it; a
  standalone build fails without it.
- **`tsdown.config.ts` imports `./build/tsdown.client.ts`** instead of
  `../../shared/tsdown.client.ts`.
- **The build preset resolves the repository root with `new URL('..', import.meta.url)`**,
  which still lands on the repository root from `build/`, so no change was needed
  inside the preset.
- **The monorepo gates are gone**: `sync-shared:check`, `aggregate:check`,
  `verify-version`, `i18n:audit`, `docs:check` and the rest do not exist here, so
  `README.i18n.yaml` is a plain consistency record rather than an enforced gate.

## Relationship to the monorepo going forward

There is none, mechanically. `dsh-web` will not receive changes made here, and
changes there will not arrive here. The runtime relationship is real, though, and
one-directional: this package reads the `remoteWebUiPairing` cordis service that
`@linxin666/dsh-remote-web-ui` publishes, and redeems a pairing token over
`POST /api/pair/accept`. Both packages are installed side by side; their route
tables do not overlap.

## Published as

`@njjpro/dsh-remote-workspace` on npm. The monorepo's release pipeline cannot
publish it (`pnpm -r publish` covers every package under its `packages/`, and its
npm token is scoped to a different account), so releases are manual from this
directory:

```sh
pnpm build
npm publish --access public
```
