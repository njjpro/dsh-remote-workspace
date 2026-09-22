# AGENTS.md — remote-workspace

DSH web GUI plugin dsh-remote-workspace. 包级规则：只写本包特有约定，不重复根 AGENTS.md 与
packages/AGENTS.md 的全局/包级规则。

## 本包要点

- 设备工作区联邦：侧栏的「远程工作区」分组（`src/client/PeerWorkspacesSection.tsx`，
  挂在官方工作区列表之下的挂载点）与中列的远端会话面板
  （`src/client/PeerSessionView.tsx`），二者共享
  `src/client/peer-session-store.ts` 这个无框架状态存储。
- host 半区（`src/index.ts`）持有三类东西：对端清单路由（已配对实例读取）、
  回环嵌入式代理（把对端 GUI 重新发布到 `127.0.0.1:<peerEmbedPort>`），以及本地
  浏览器半区调用的控制路由。`src/peer-remote.ts` 定义两侧路由，
  `src/peer-proxy.ts` 是代理，`src/peer.ts` 是与对端的链路。
- `src/client/embed-shell-css.ts` 与 `embed-shell-focus.ts` 在**嵌入式面板内部**运行
  （本包的客户端半区也随对端文档加载）：前者把对端外壳收成单列，后者做输入提交焦点的
  内半区。两者缺一，面板就是白屏或打不了字。

## 与官方包的关系（重要）

- 构建期**零依赖**：不 import `@linxin666/dsh-remote-web-ui`，也不在
  `package.json` 声明它。跨插件协作只走 cordis 服务。
- 运行期依赖一个事实：官方插件发布的 `remoteWebUiPairing` 服务提供
  `isPairedDevice(request)`，本包用它做对端路由的围栏。服务缺失时路由以 `401`
  失败关闭——**不要**为了「让它能跑」而放宽成 loopback 放行。
- 路由分工固定：本包 `/pair-remote/*` 与 `/api/pair/peer/*`，官方包
  `/api/pair/{issue,accept,stop,revoke,heartbeat,status,events,lan-bind}`、
  `/pair-accept`、`/pair-app`。两边都是 exact-path 注册，占同一路径会冲突。
- 配对流程（签发令牌、撤销、设备 cookie）不属于本包：只在
  `src/peer.ts` 里兑换 `POST /api/pair/accept`。

## 提交前检查

本仓库本身就是一个包（不是单仓的子目录），直接在本目录执行：

```sh
pnpm typecheck   # tsc -b --pretty false
pnpm test        # vitest run
pnpm build       # tsc -b && tsdown
```

## 本仓库与 dsh-web 单仓的关系

本包原本位于 `dsh-web` 单仓的 `packages/dsh-remote-workspace/`，现已拆为独立仓库。因此：

- 本仓库**不使用**单仓的共享机制：`shared/` 同步副本、`pnpm --filter`、`aggregate` 门禁都不存在。原先由 `scripts/sync-shared.mjs` 生成的 `src/dsh-home.ts` 与 `src/loopback.ts` 现在是普通源文件，直接编辑即可（不再需要「改 shared 源后重跑同步」）。
- `build/tsdown.client.ts` 与 `build/web-platform.ts` 是从单仓 `shared/` 摘出的构建预设；它们随本仓库独立演进。
- 原作者 `dsh-web` 仓库不会自动收到这里的改动；如需回馈上游，需要手动移植。

