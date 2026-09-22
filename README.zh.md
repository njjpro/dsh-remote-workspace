# DSH 远程工作区（Remote Workspace）

[English](README.md) | 中文

> 为 dsh web GUI 提供设备工作区联邦：配对到另一台 DSH 实例后，在本地侧栏浏览它的项目与会话，每个远端会话直接在本地中列打开，而不是另开浏览器窗口。

本仓库是 DeepSeek Harness（DSH）的独立插件包，为单一双面包：host 半区持有对端清单路由（供已配对实例读取）、把对端 GUI 重新发布到回环端口的嵌入式代理，以及本地浏览器半区调用的控制路由；浏览器半区渲染侧栏中可折叠的远程工作区分组，并把每个远端会话承载在 iframe 中。

本包在构建期独立于 `@linxin666/dsh-remote-web-ui`（不 import、不声明包依赖）。它在运行期通过 cordis 服务 `remoteWebUiPairing` 读取该插件的配对身份，因此两个包可以并存安装。

## 功能

- 在侧栏官方工作区列表之下，列出已配对实例的工作区（项目）及其会话。
- 在本地中列打开远端会话，就地取代本地对话，而不是打开新的浏览器标签页。
- 在远端工作区里新建对话：由对端创建会话，本地半区打开它返回的结果。
- 同时最多挂载三个远端面板，避免常驻流耗尽同源连接预算。
- 每个远端界面输出 `data-dsh-plugin="remote-workspace"` 与裸值 `data-dsh-part`，供皮肤锚定。

## 安装

两台机器都需要官方 `@linxin666/dsh-remote-web-ui` 插件：配对由它负责，本包只兑换它签发的令牌。

### 从 npm 安装

```sh
dsh plugin --profile web add @njjpro/dsh-remote-workspace
```

### 从本仓库安装（开发回路）

```sh
git clone <本仓库>
cd dsh-remote-workspace
pnpm install
pnpm build
dsh plugin --profile web add file:$(pwd)
```

## 开发

```sh
pnpm install
pnpm typecheck   # tsc -b --pretty false
pnpm test        # vitest run
pnpm build       # tsc -b && tsdown
```

`build/tsdown.client.ts` 是本仓库自带的客户端打包预设，连同它读取的平台种子表一起从 dsh-web 单仓的 `shared/tsdown.client.ts` 摘出，因此本包在没有那个仓库时也能构建。这里不使用 `pnpm-workspace.yaml` 与根级 `packages/` 布局：本仓库本身就是那个包。

## 配置

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；关闭后两个界面都不挂载。 |
| `peerBaseUrl` | string | `''` | 已配对对端实例的基址；为空表示未配置对端。 |
| `peerPairToken` | secret string | `''` | 在对端面板生成的一次性配对令牌；兑换一次并持久化。 |
| `peerEmbedPort` | number | `43121` | 嵌入式代理绑定的回环端口，仅 `127.0.0.1`。 |

## 安全模型

- 对端清单路由（`/pair-remote/*`）要求有效的已配对设备凭据，且**不**把回环当作绕过通道。判定用的是宿主自身的配对检查，因此无法与本实例配对的请求读不到清单。
- 控制路由（`/api/pair/peer/*`）仅限回环：套接字地址与 `Host` 头都必须是回环，因此局域网来源即便伪造 `Host` 也无法触达票据铸造与会话创建端点。
- 配对本身不在这里进行。令牌签发、撤销与设备 cookie 都归 `@linxin666/dsh-remote-web-ui`；本包只是兑换 `POST /api/pair/accept`，并按对端基址分别存储凭据。
- 嵌入式代理绑定 `127.0.0.1`，附带该凭据重新发布对端 GUI。嵌入票据一次性且有 TTL 上限，且只为清单实际列出的会话铸造。
- 未安装官方插件时配对服务缺失，所有对端路由以 `401` 失败关闭。

## 已知限制

- 远端会话的文档由对端提供，因此它的外壳、service worker 与注入脚本都是对端的那一份。这些部分的修复属于对端的安装，不在本包。
- 侧栏挂载点与嵌入布局覆盖以官方 CSS Modules 类名后缀为锚，官方界面重构后需要先做一轮真实 GUI 视觉 QA 再发版。
- 回环嵌入式代理仅支持 HTTP；经隧道访问的对端仍在它自己的源上终结。
- 运行期依赖官方插件意味着本包无法单独使用：必须安装官方插件，围栏才会放行任何请求。

## 许可

Apache-2.0。
