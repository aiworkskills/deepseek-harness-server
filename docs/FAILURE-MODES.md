# 失败模式速查

按**报错原文**索引。卡住时先在本文搜错误里最独特的那个字符串。

收录标准：静态检查（`pnpm check` / `release:check` / `example`）发现不了、只在运行时
暴露的失败。能被类型检查抓到的不在这里。

下面每一条都真实发生过——多数出自 2026-09 那次 `0.1.1-rc.2` → `0.1.5-alpha.1` 升级，
当时三个检查命令**全绿**，七个问题逐个只在真人打开浏览器时才暴露。

---

## `EROFS: read-only file system` … `.credentials.yaml.lock`

**症状** Runtime 起不来，`plugin tree failed to load: failed to apply loader entry
connection (@deepseek-ai/dsh-client-connection)`。

**原因** DSH 0.1.5 起，`dsh-client-connection` 装载时无条件调 `credentials.modifyRecord`
给浏览器鉴权生成签名密钥。`modifyRecord` **先加锁再判断要不要写**，所以哪怕记录已存在、
根本不需要写入，创建 `.lock` 文件本身就会在只读挂载上失败。

**为什么是只读** 租户配置目录对普通用户只读是有意的边界，见 `backend-container.ts`
的 `Binds`。**不要为了让它起来而放开这个挂载。**

**修法** 按角色分流凭据路径（`runtime-provision.ts`）：管理员写租户共享的那份，
普通用户写自己 home 里的一份。那把密钥本来就是每个 Runtime 自己的。

---

## `DSH Runtime did not become ready`（日志里 Runtime 其实起来了）

**症状** 网关轮询 45 秒后放弃，但 `dsh web: http://…` 已经打印出来了。

**原因** 就绪探测打在需要鉴权的路径上。0.1.5 起根路径无 token 返回 401，而探测要求
`response.ok`。

**修法** 探 `/manifest.webmanifest`。浏览器按 W3C 规范取 manifest 不带凭据，所以 DSH
只能让它免鉴权——这比根路径是更稳的契约。API 活没活由紧随其后的工作区引导自己重试。

---

## `dsh web authentication required; reopen the URL printed by dsh web.`

**症状** 前端资源都加载了，但请求被 DSH 自己的 401 页面挡住。注意：如果 provision
成功了而只有浏览器请求失败，问题就在 authority 上。

**原因** DSH 的 cookie 名是 `dsh-auth-<sha256(authority)>`，authority 取自请求的
`Host`，并且还签进 payload。**在一个 authority 下换到的 cookie，在另一个 authority 下
连名字都对不上。** 而 `fetch` 会**静默丢弃** `Host` 头，于是握手时 cookie 绑在了 socket
实际连接的地址上（容器后端是容器名），代理转发时带的却是对外域名。

**修法** 用 `node:http` 显式设 `Host` 为 `publicHost`（`fetch` 做不到）。握手与网关
自己的引导 RPC 要绑到同一个 authority 上。

---

## `Remote payload must contain exactly one plain-object args field`

**原因** DSH 的 Remote 调用 payload 是 `{ args: { <参数名>: … } }`，按方法的**参数名**
键控，不是请求字段。把值写在 `args` 旁边或少嵌一层都会被拒。

**修法** 照方法签名嵌。`WorkspaceController.create(request)` 的参数叫 `request`，
所以是 `{ args: { request: { path } } }`。DSH 的报错会指名缺哪个键、多了哪个，照着改。

**注意** 这个信封在网关里有两处用到（引导 RPC 和 `prepareSessionCreateBody`）。
2026-09 那次只改了一处，另一处过了一整轮部署才暴露。

---

## `session create failed: agent-preset/invalid` / `$.<键> missing required value`

**原因** Preset YAML 里某个插件的 config 键被上游改名了。这类改名**零编译期信号**，
只在创建会话那一刻炸。0.1.5 把 `dsh-persona` 的 `text` 改成了 `prefix`。

**修法与预防** 按 [compatibility.md](compatibility.md) 升级流程第 5 步机械比对
preset 里**每个**插件的 Config 键，别只改报错的那一个。

**注意** 包被移出默认 bundle **不等于**包没了。`tool-str-replace-editor` 在 0.1.5 被
移出 bundle，但包仍在，Preset 显式引用没问题。要查的是 config 键，不是 bundle 成员。

---

## 被锁的管理 RPC 实际没被拦（没有任何报错）

**这一条不会报错，只会在被利用时才知道。**

**原因** DSH 的 RPC 端点形状是 `/api/<ns>/<method>`（斜杠）。0.1.1 曾是
`<ns>.<method>`（点号）。点号写法在新版指向一条**不存在的路径**——规则永远为真、请求
永远不来，于是 settings 写、插件安装、工作区变更、Preset 选择、宿主机命令执行全部敞开。
`SESSION_CREATE_PATH` 同样失效，意味着受管工作区与 business Preset 的强制钉定从不触发。

**怎么发现** 拿**真实存在**的方法名去断言，并加反向断言（旧形状现在应当**不**被拦）。
`gateway-policy.spec.ts` 有形状守卫。命名空间取自上游的 `super(ctx, …)` 与
`{ namespace: … }`，升级时重新核对——0.1.1 → 0.1.5 就把「用本机程序打开路径」从
`host.openPath` 改成了 `session.openWorkspacePath`。

**别被 `nativeOpen: false` 误导** 它只喂给能力探测 `canOpenWorkspacePath`，真正动手的
`openWorkspacePath` 不查它。那条配置只是 UI 提示，**网关黑名单才是边界**。

---

## 类型检查全绿但运行时报 `undefined is not a function`

**原因** 只被 `.d.ts` 间接引用的「纯类型 peer」没进 `devDependencies`，
`skipLibCheck: true` 吞掉未解析的 import，对应 API 整个退化成 `any`。

**怎么确认** 关掉 skipLibCheck 数未解析模块：

```bash
tsc -p tsconfig.json --noEmit --skipLibCheck false 2>&1 | grep -c "Cannot find module"
```

再往源码里塞一个**故意写错**的调用（不存在的槽位名、非法命名空间），确认编译器真的
报错。**不报错就说明已经退化了。**

---

## 构建期 `git fetch` 随机失败（TLS 中途断开）

**症状** `GnuTLS recv error`、`Empty reply from server`、`early EOF`，失败点随机，
重试有时就过——看起来像网络抖动。

**原因** `dockerd` 的代理配置**只作用于它拉基础镜像**，BuildKit 执行 `RUN` 时不继承。
所以基础镜像永远拉得下来，只有构建里的 clone 是直连。

**修法** 显式传给构建（`--network host` 下容器里的 `127.0.0.1` 就是宿主机）：

```bash
--build-arg HTTP_PROXY=http://127.0.0.1:<port> --build-arg HTTPS_PROXY=http://127.0.0.1:<port>
```

`HTTP_PROXY` 这一族是 Docker 预定义构建参数，不写进镜像环境变量或历史。

---

## 每次改 commit 都重装一遍 build-essential

**原因** `ARG` 声明在 apt 层**之前**。BuildKit 会让 ARG 之后的所有层失效。

**修法** 把 `ARG *_COMMIT` 挪到它真正被用到的 `git fetch` 前面。**只对经常变的 ARG 这么
做**——移动很少变的 `DSH_COMMIT` 反而会作废已建好的 harness 缓存，逼出一次十几分钟的
重新克隆，净亏。移动 ARG 本身也会让缓存失效一次，属一次性代价。

---

## 镜像导出慢得离谱

**原因** 在几个 GB 的树上 `chown -R`：既要跑十几分钟，又因为改了每个文件而生成**第二份
同样大的层**，导出时再写一遍。

**修法** `COPY --from=… --chown=user:group`，两笔一起省掉。
