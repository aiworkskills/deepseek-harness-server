# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)，变更按 Keep a Changelog 的类别组织。
公开包锁步发版，共用同一个版本号。

## [Unreleased]

### Fixed

- **三个 Agent Preset 在 0.1.5 上挂不起来。** `@deepseek-ai/dsh-persona` 把 config 键
  `text` 改名成了 `prefix`（并新增可选的 `suffix`），旧名字在新版上不是被忽略，而是
  `$.prefix missing required value`，导致 Preset 挂载失败、会话根本创建不出来。
  三个 Preset 已改名。同时核对了 Preset 引用的全部七个插件，只有 `persona` 这一处变化。
  升级流程补了一步机械比对（`docs/compatibility.md` 第 5 步）——这类改名没有任何编译期
  信号，只在创建会话时才炸。

- **`session/create` 的受管改写打在了错误的层级。** `prepareSessionCreateBody` 仍按
  0.1.1 的扁平 payload 改写，而 0.1.5 的 payload 是 `{ args: { request: … } }`，于是
  `workspaceId` 与 `agentPreset` 被写在了 `args` **旁边**——DSH 以「Remote payload must
  contain exactly one plain-object args field」拒绝整个调用，浏览器侧表现为
  `initial workspace selection failed`。改为改写 `payload.args.request`，并断言 `args`
  仍是 payload 唯一的键。新增一条测试：无法改写的信封必须**抛错**而不是原样放行——
  放行意味着受管工作区与 business Preset 的钉定从未生效。

- **浏览器经网关访问 Runtime 一律 401。** DSH 的浏览器鉴权 cookie 名是
  `dsh-auth-<sha256(authority)>`，authority 就是请求的 `Host`，并且还签进 payload——
  所以在一个 authority 下换到的 cookie，在另一个 authority 下连名字都对不上。网关握手
  用的是 `fetch`，而 `fetch` **会静默丢弃 `Host` 头**，于是 cookie 绑在了 socket 实际
  连接的地址上（容器后端是容器名，进程后端是回环）；而代理转发浏览器请求时保留的是
  调用方的 Host，也就是对外域名。两者不同，DSH 回 401 并附上自己的
  「reopen the URL printed by dsh web」。改用 `node:http` 显式设置 `Host` 为对外
  authority，握手与网关自己的引导 RPC 都绑到同一个上。

- **普通用户的 Runtime 在 DSH 0.1.5 上起不来（EROFS）。** 0.1.5 起
  `dsh-client-connection` 装载时无条件调 `credentials.modifyRecord` 给浏览器鉴权生成
  签名密钥，而 `modifyRecord` **先加锁再判断要不要写**——所以哪怕记录已存在、无需写入，
  创建 `.credentials.yaml.lock` 本身就会在只读挂载上 EROFS，整棵插件树 `failed to load`。
  租户配置目录对普通用户只读是有意的边界（`backend-container` 的 Binds），不为此让步；
  改为**按角色分流凭据路径**：管理员写租户共享的那一份，普通用户写自己 home 里的一份。
  那把密钥本来就是每个 Runtime 自己的——它签的是这个 Runtime 自己的浏览器 cookie。
  `settings.yaml` 不跟着走，仍在只读租户目录里。代价：普通用户的 Runtime 读不到管理员
  存在租户 credentials 里的密钥；模型密钥走环境变量的部署不受影响。

- **接上 DSH 0.1.5 的 Runtime 浏览器鉴权，并改正 RPC 路径形状。** 这四条只有真起一次
  Runtime 才会暴露——`pnpm check`、`release:check`、`example` 在修之前全是绿的。
  - 0.1.5 新增了 `browser-auth`：Runtime 自己鉴权浏览器面，根路径无 token 返回 401。
    就绪探测改为敲 `/manifest.webmanifest`（浏览器按 W3C 规范不带凭据取 manifest，
    所以 DSH 只能让它免鉴权，这比根路径更稳），否则网关轮询 45 秒后放弃一个其实
    起得好好的 Runtime。
  - 网关现在从 Runtime stdout 读启动 token，用 `GET /?token=` 换回 cookie，并注入到
    HTTP 与 WebSocket 两条转发路径。cookie 只在网关内部流转：用户已由网关认证，
    再给一份 Runtime 直接认的凭据等于绕过它。
  - **RPC 端点从 `<ns>.<method>` 变成了 `<ns>/<method>`。** 点号写法在 0.1.5 上指向
    一条不存在的路径，所以 `blockedDshRpc` 的每一条规则都匹配不到任何请求——被锁的
    管理能力（settings 写、cordis、插件安装、工作区变更、Preset、宿主机打开器）实际
    全部敞开；`SESSION_CREATE_PATH` 同样失效，意味着受管工作区与 business Preset 的
    强制改写从不触发。新增形状测试遍历每条前缀，形状退回点号即变红。
  - Remote 调用的 payload 是 `{ args: { <参数名>: … } }`，按方法参数名键控而不是请求
    字段。
- 测试里的假 Runtime 过去对任何路径都回 `ok`，上面四条一条也测不出来。现在它照 0.1.5
  的样子应答：根路径要 cookie、只认 `<ns>/<method>`、校验 args 信封。

- **网关重新挡住宿主机命令执行。** DSH 0.1.5 把「用本机程序打开路径」从 `host.openPath`
  改名成了 `session.openWorkspacePath`，于是 `blockedDshRpc` 里那条 `/api/host.open`
  连同另外三条 `/api/host.*` 一起变成了永远命中不了的死规则，而那个方法会在 Runtime
  宿主机上执行 `open`/`xdg-open`。**`nativeOpen: false` 拦不住它**——上游只把这个配置喂
  给能力探测 `canOpenWorkspacePath`，真正动手的方法不查它。黑名单现已按 0.1.5 的命名
  空间重写（`directoryPicker.` / `cordisInspect.` / `pluginInventory.` /
  `permissionPresets.` / `agentPresets.`，后者过去写成单数，从未命中过），并加入
  `session.openWorkspacePath`。相关测试原本断言的都是当前版本不存在的路径，属于永远
  为真的假绿灯，一并换成真实方法名。
- **两处类型静默退化成 `any`。** `dsh-client-store` 与 `dsh-client-ui-dockkit` 是纯类型
  peer 却没进 `devDependencies`，`skipLibCheck` 吞掉未解析的 import，导致
  `ctx.sessions.list`（dsh-preferences）与 tab body 的 `useTabInfo`/`tab.contentId`
  （dsh-deliverables）完全不受类型检查。补齐依赖后两者恢复为真类型，且现有代码无需改动。
- Runtime 子进程的 `HOME` 指向它自己的目录。此前继承 Gateway 的 `HOME`，同一台机器上
  所有 Runtime 共用一个 dotfile 目录，`git config`、包缓存以及任何回退到 `~` 的工具都会
  跨租户读写同一批文件。
- `/assistant` 映射到 Runtime 的根路径。Runtime 在 `/` 提供其 Web 应用，`/assistant`
  只是部署方暴露它的挂载点，原样转发会得到 404。
- 不再对 `manifest.webmanifest` 要求鉴权。浏览器按规范抓取 manifest 时不带凭据，
  于是每次页面加载都在控制台留下一条 401，而实际什么也没坏。
- 启动失败时回传真实原因:审计事件带上 `cause`，工作区置备失败附上子进程输出并检查
  子进程是否已退出，回传行数从 8 行放宽到 40 行——八行连一条栈回溯都装不下。
- `pnpm check` 先构建再类型检查。跨包依赖的类型检查需要被依赖方的构建产物，
  而干净检出上并不存在，CI 因此失败而本地始终通过。

### Changed

- **验证的 DSH 版本提到 `0.1.5-alpha.1`**（原 `0.1.1-rc.2`），Cordis 提到 `4.0.2`。
  这一跳跨越 2942 个上游提交，含数个破坏性变更，`peerDependencies` 区间下界一并抬到
  `>=0.1.5-alpha.1`。钉的是 alpha 而非 rc：`0.1.3` 与 `0.1.4` 都没等到 rc 就被跳过，
  「等这条线出 rc」不是可靠的计划。
- `@deepseek-ai/dsh-client-runtime` 在上游整包消失，浏览器半边的上下文改回 cordis
  `Context`，各服务由声明它的 UI 包提供：`slots` 来自 `ui-renderer`，`sessions` 来自
  `api-session-controller`（**不是** `ui-session`，后者的 `uiSession` 是另一个服务），
  `SettingsScope` 类型来自 `ui-settings`。
- `dsh-integration`：`settingsNamespace()` 与 `installSettingsSection()` 被上游删除，
  改用字符串字面量与 `ctx.settings.register()`（不是 `installSection`——那多出来的
  setSource/onChange 协议是给缓存配置、需要在 provider 脱离时回退的消费者用的，
  这个消费者两样都不做）。命名空间的合法性现在由类型层校验，所以那个常量必须保持
  字面量类型。
- **`dsh-deliverables` 从接管改为注册。** 上游删掉了详情面板，也把「交给宿主机桌面」的
  出口从客户端 `workspaces.openPath` 挪到了 Session/Settings 控制器上——装饰客户端方法
  从此拦不到任何东西。插件改为在右侧栏 tab 类型注册表的 `extension` 档注册，按扩展名
  认领网页、图片、PDF/Office；Markdown、JSON、源码交回内置的分页文本预览。
  **升级部署时必须同时关掉宿主机那个出口**：profile 里禁用 `open-in-app` /
  `ui-open-in-app`，并确认网关黑名单含 `session.openWorkspacePath`——`nativeOpen: false`
  只是 UI 提示，拦不住直接发来的 RPC，详见上面 Fixed 一节。

### Removed

- `DETAILS_PRIORITY`、`workspaceRelative`、`createSelectionStore` 及其类型：三者都只为
  详情面板与 `openPath` 装饰而存在，随上述重写一并消失。

### Added

- `@dshserver/gateway-server`：把 Runtime Gateway 补成可运行的服务。此前本仓库只提供
  库，围绕它的服务器留给每个部署自行实现——匹配 DSH 路径、认证、套用策略、拒绝被锁的
  RPC、解析 Runtime、改写 `session.create`、代理，这段顺序写错不会在测试里暴露，
  会变成安全缺陷。认证与策略仍由宿主提供。
- `RuntimeManagerOptions.runtimePlugins`：链接进每个 Runtime Profile 的插件包可配置。
  此前写死为本仓库自己的两个包，第三方插件没有进入托管 Runtime 的入口。
- `RuntimeManagerOptions.permissionMode`：沙箱授权从写死的 `read-only` 提为选项，
  默认不变。产出本身就是文件的 Agent 可用 `workspace-write`。
- `RuntimeManagerOptions.extraEnv`：部署方可向 Runtime 子进程追加环境变量。

## [0.1.0] - 2026-08-22

首次公开发布。

### Added

- `@dshserver/dsh-integration`：OAuth 委托的业务工具、执行前授权守卫、
  `businessTool()` 目录工厂，以及 `dshserver-integration` 租户设置命名空间。
- `@dshserver/runtime-gateway`：每用户独立 Runtime 生命周期、受管 Workspace 与 Preset
  注入、DSH HTTP/WebSocket 管理接口锁定策略。
- `@dshserver/dsh-preferences`：浏览器侧主题偏好、租户配置卡片，以及业务页面向输入框
  送入话术的同源协议。
- `config/`：企业 Profile 补丁与员工、管理者、审计员三套 Agent Preset。
- 四个 CRM 示例工具，演示只读、团队统计与带幂等键的写操作。
- `examples/local-smoke`：无需 Harness、无需模型凭据的端到端契约检查。
- 集成、配置、工具与 API、架构、安全模型、兼容性六份文档。
- `DSHSERVER_TENANT_KEY` 固定租户配置目录名。未设置时目录名仍由 OAuth issuer 与
  `tenant_id` 派生，Gateway 在启动日志中打印当前租户目录，并在旧目录仍有配置时给出
  迁移提示。
- `RuntimeManagerOptions` 的 `pluginRoot`、`preferencesRoot`、`configRoot`：目录结构与
  本仓库不同的宿主应用可以直接指定这三份部署资产，不必按 `<projectRoot>/plugin/...`
  的约定复制目录。
- 部署默认模型独立为 `config/dsh-profile/model-seed.patch.yml`，只在 Profile 根还没有
  持久化条目时追加，管理员在原生 Models 页保存的配置不再被每次 Runtime 启动覆盖。
- 配置持久化回归测试：重新预置 Runtime 目录后，租户设置、凭据与用户状态必须保持不变。
- `@dshserver/dsh-integration` 导出 `BusinessRequestContext` 与 `BusinessToolDependencies`，
  自定义业务工具目录不再需要重新声明这两个出现在公开签名里的类型。

### 支持的 DSH 版本

`0.1.1-rc.2`。该版本删除了 ApiProxy 的设置命名空间白名单，因此企业 Profile 不再需要
`api-gateway.exposedSettingsNamespaces`，远程配置权限完全由 Gateway 的
`assistant:platform:write` 门禁承担。DSH 仍处于预发布阶段，安装时需要精确锁定版本，
peer 区间的下界也要跟着抬，原因见[兼容性](docs/compatibility.md)。

[Unreleased]: https://github.com/aiworkskills/deepseek-harness-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aiworkskills/deepseek-harness-server/releases/tag/v0.1.0
