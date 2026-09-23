# DSH Remote Workspace

English | [中文](README.zh.md)

> Device-workspace federation for the dsh web GUI: pair into another DSH instance and browse its projects and sessions from the local sidebar, with each peer session opening in the local center column instead of a separate browser window.

This is a standalone plugin package for DeepSeek Harness (DSH). It is a single dual-face package: the host half owns the peer inventory routes a paired instance reads, the loopback embed proxy that republishes the peer GUI, and the control routes the local browser half calls; the browser half renders the collapsible remote-workspace group in the sidebar and hosts each peer session in an iframe.

It is independent of `@linxin666/dsh-remote-web-ui` at build time — no import, no package dependency. It reads that plugin's pairing identity through the `remoteWebUiPairing` cordis service at runtime, which is what makes the two packages installable side by side.

![A peer session open in the local center column, with the paired instance's workspaces and sessions listed under "Remote workspaces" in the sidebar](assets/remote-workspaces.png)

The screenshot is the local GUI: the sidebar lists this machine's own workspaces and, below them, the paired instance's under **远程工作区 / Remote workspaces**; the center column is showing a session running on that other machine. Project names in the capture are pixelated.

## What it does

- Lists the paired instance's workspaces (projects) and their sessions in the sidebar, under the official workspace list.
- Opens a peer session in the local center column, mounted in place of the local conversation rather than in a new browser tab.
- Starts a new conversation inside a remote workspace: the peer creates the session and the local half opens what it returns.
- Keeps at most three peer panes mounted at once, so the per-origin connection budget is not exhausted by long-lived streams.
- Marks each peer surface with `data-dsh-plugin="remote-workspace"` and a bare `data-dsh-part` value, so skins can anchor on it.

## Install

Requires the official `@linxin666/dsh-remote-web-ui` plugin on both machines: it owns pairing, and this package only redeems a token that plugin issued.

### From npm

```sh
dsh plugin --profile web add @njjpro/dsh-remote-workspace
```

### From this repository (development loop)

```sh
git clone <this repository>
cd dsh-remote-workspace
pnpm install
pnpm build
dsh plugin --profile web add file:$(pwd)
```

## Development

```sh
pnpm install
pnpm typecheck   # tsc -b --pretty false
pnpm test        # vitest run
pnpm build       # tsc -b && tsdown
```

`build/tsdown.client.ts` is this repository's client-bundle preset, lifted from the dsh-web monorepo's `shared/tsdown.client.ts` together with the platform seed table it reads, so the package builds without that repository present. `pnpm-workspace.yaml` and the root-level `packages/` layout are not used here: this repository is the package.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch; disabling removes both surfaces. |
| `peerBaseUrl` | string | `''` | Base URL of the paired peer instance; empty means no peer is configured. |
| `peerPairToken` | secret string | `''` | One-time pairing token minted on the peer's panel; exchanged once and persisted. |
| `peerEmbedPort` | number | `43121` | Loopback port the embed proxy binds, on `127.0.0.1` only. |

## Security model

- The peer inventory routes (`/pair-remote/*`) require a live paired-device credential and do **not** treat loopback as a bypass. The predicate is the host's own pairing check, so a request that could not pair with this instance cannot read its inventory.
- The control routes (`/api/pair/peer/*`) are loopback-only: both the socket address and the `Host` header must be loopback, so a LAN origin cannot reach the ticket-minting or session-creating endpoints even with a forged `Host`.
- Pairing itself is never performed here. Minting, revoking, and the device cookie all belong to `@linxin666/dsh-remote-web-ui`; this package redeems `POST /api/pair/accept` and stores the resulting credential per peer base URL.
- The embed proxy binds `127.0.0.1` and republishes the peer GUI with that credential attached. Embed tickets are one-shot and TTL-bounded, and are minted only for sessions the inventory actually lists.
- Without the official plugin installed, the pairing service is absent and every peer route fails closed with `401`.

## Known limitations

- A peer session's document is served by the peer, so its shell, service worker, and injected scripts are the peer's copies. Fixes to those belong on the peer's install, not here.
- The sidebar mount and embed layout overrides anchor on official CSS-module class suffixes, so an official GUI redesign needs a visual QA pass before release.
- Loopback embed proxies are HTTP only; a peer reached over a tunnel still terminates at the peer's own origin.
- The runtime pairing dependency means this package is not usable on its own: the official plugin must be installed for the fences to admit anyone.

## License

Apache-2.0.
