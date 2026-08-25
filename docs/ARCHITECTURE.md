# 插件架构

本文帮你理解插件的模块划分、配置所有权，以及新增一个业务连接器需要改动的位置。

插件按信任边界与变更边界拆分：新增业务工具不应该触碰 OAuth 交换、Runtime 身份或
Gateway 策略代码。

## Runtime 工具插件

```text
index.ts
  -> config.ts             部署方拥有的连接与授权输入
  -> connector-settings.ts 租户设置命名空间：结构、限制、安装与实时读取
  -> settings.ts           Host 平面的设置命名空间拥有者
  -> policy.ts             工具 Scope 与写标记的单一事实来源
  -> catalog.ts            businessTool() 工厂，把策略接进 DSH 工具
  -> business-client.ts    Runtime 租约与 OAuth Token Exchange
  -> customer-tools.ts     CRM 示例目录条目
  -> lease.ts              本地租约解析与有效性判断
```

`index.ts` 是 Agent 平面的组合根。它一次性解析部署输入、读取 Host 拥有的实时设置、安装
唯一的执行前守卫，并注册选定的目录条目。其中不包含任何业务 Schema 或传输实现。

`settings.ts` 由 Host Profile 在任何会话存在之前挂载，因此原生设置页不依赖用户是否已经
启动业务 Agent Preset。

`policy.ts` 是工具 Scope 与写标记的唯一声明处。执行前守卫和 Token Exchange 的 Scope 都
从它派生，因此不可能出现「检查一个 Scope、申请另一个 Scope」的情况。

`catalog.ts` 把一个声明式条目（参数与输出 Schema、展示信息、请求构建器）变成注册好的
DSH 工具，并在同一处完成换票 Scope、写操作总开关、幂等键、超时与结果渲染的接线。

`customer-tools.ts` 是刻意保留的示例领域代码。新的集成应该在它旁边定义自己的目录文件，
并复用配置、策略、租约与委托客户端各层。模型参数只能承载业务输入，身份与凭据始终来自
受信任的运行时上下文。

## Runtime Gateway

```text
packages/runtime-gateway/src/gateway-policy.ts     RPC 允许/拒绝边界
packages/runtime-gateway/src/runtime-identity.ts   稳定的用户键、租户键与重启指纹
packages/runtime-gateway/src/runtime-manager.ts    进程生命周期、就绪等待与租约续期
packages/runtime-gateway/src/runtime-provision.ts  每个 Subject 的文件布局与子进程环境
packages/runtime-gateway/src/types.ts              宿主集成契约
```

Gateway 接受的是已验证的 `GatewayPrincipal`；它不实现登录，也不实现业务对象授权。
Runtime 的重启指纹包含进程启动时捕获的全部策略事实。租户设置在同租户内共享，而进程
状态、`DSH_HOME`、工作区、租约与会话始终按 Subject 隔离。

## 浏览器插件

```text
packages/dsh-preferences/src/client.ts          浏览器组合根：主题、话术接收、设置卡片
packages/dsh-preferences/src/composer-bridge.ts 外部话术协议与暂存状态（纯逻辑）
packages/dsh-preferences/src/settings-card.ts   租户策略配置卡片
packages/dsh-preferences/src/theme.ts           浏览器本地主题偏好
```

`composer-bridge.ts` 不认识 window、cordis 和 DSH 服务：它只做校验、草稿合并和一条
暂存。`client.ts` 负责同源与嵌入方校验、解析当前会话的输入机，并在会话或对话界面就绪
时冲刷暂存。写入使用 DSH 原生输入机的唯一草稿写入路径，因此发送始终是用户动作——嵌入
页面能填写输入框，不能让智能体开口。

## 产物预览

```text
packages/dsh-deliverables/src/contract.ts   路由形状与类型判定（两个平面共享）
packages/dsh-deliverables/src/index.ts      Host 平面：工作区收敛后按只读流服务文件
packages/dsh-deliverables/src/client.ts     浏览器平面：接管 workspaces.openPath
packages/dsh-deliverables/src/client/       预览渲染、选中态与工作区相对路径换算
```

它只做一件事：改变「打开文件」在托管部署里的**去向**。DSH 的产物徽章、正文里的文件提及
和工具行共用 `workspaces.openPath`，而那个方法把路径交给 Host 的桌面打开器——托管服务器
上没有桌面。接管这一个方法，三个界面一起修好；落在当前会话工作区之外的路径原样交回原
实现，插件卸载时恢复。

`contract.ts` 是两个平面唯一共享的模块，路由**路径式而非查询式**：产物 HTML 用相对路径
引用配图，查询式路由会让每一处相对引用落到本路由不提供的地址上。`index.ts` 的
`confineToWorkspace` 在 realpath **之后**比较，因此工作区内一条指向外面的符号链接不构成
逃逸——这是本包唯一的安全断言。

## 嵌入方 chrome

```text
packages/dsh-embed-chrome/src/contract.ts    路由、消息信封与校验（两个平面共享）
packages/dsh-embed-chrome/src/index.ts       Host 平面：只回答"哪个来源可以说话"
packages/dsh-embed-chrome/src/client/link.ts 三条信任规则，不认识 React 也不认识 cordis
packages/dsh-embed-chrome/src/client.ts      浏览器平面：品牌槽、hero 槽、工作区切换
```

Host 半边只做**信任决定**，因为它是唯一有配置的一半：`hostOrigin` 由运维写死。chrome
本身从不经过它——由嵌入页面在运行时经 `postMessage` 给出，页面改主意不需要重启 Runtime。

页面在另一个来源上（Runtime 走网关，产品在部署方域名），所以「同源」不能当判据。三条
规则合起来才成立：来源由 Host 指定、发送方必须是自己的父窗口、只往那个来源发而绝不用
`'*'`。第二条单独看容易漏——只验来源的话，同一来源上的另一个窗口也能给这个 Runtime
穿衣服并递上工作区名单。

`switch` 是请求而非命令：换工作区意味着换一个 Runtime、换一张令牌，只有页面能重新签发。

## 配置所有权

| 配置 | 拥有者 | 运行期变更 |
|---|---|---|
| Broker / 业务 API 地址、Audience、租约路径 | 部署运维 | 重启 |
| OAuth Scope 与可见工具 | 业务策略控制面 | 策略指纹变化触发 Runtime 重启 |
| 请求超时、写操作总开关、最短变更原因 | 平台管理员 | 通过 DSH Settings 实时生效 |
| 主题等界面偏好 | 当前用户 | 浏览器本地 |

只有第三行注册在 `dshserver-integration` 设置命名空间下。浏览器插件通过 DSH 原生的
`settings.plugin.item` 槽位贡献配置卡片。Gateway 的配置类 API 要求
`assistant:platform:write`；普通用户既不会装载平台设置界面，也无法通过隐藏路由修改租户
行为。

外部话术接收刻意没有配置项：浏览器插件拿不到 Profile 配置，而「谁可以往输入框里写字」是
安全边界，不能由一份可被误设的来源白名单决定。它由页面自身的事实回答：同源，且发送方
是嵌入当前页面的窗口。跨源集成通过统一域名或反向代理满足这一条。

完整参数表见[配置参考](configuration.md)。

## 扩展检查表

新增一个业务连接器时逐项完成：

1. 在 `policy.ts` 的策略表中加入工具名称及其 Scope / 写标记。
2. 用 `businessTool()` 声明目录条目：严格的参数与输出 Schema、展示标题，以及把校验后的
   参数映射为**一次** Resource Server 调用的请求构建器。
3. 在 `index.ts` 的注册循环中加入新目录，并在 Agent Preset 的 `exposedTools` 中开放。
4. 绝不直接读取业务数据库；请求构建器是唯一的传输面。
5. 覆盖允许执行、缺少 Scope、对象级拒绝、超时和写操作幂等五种行为。

配套的接入步骤见[集成指南 · 步骤 6](integration.md#步骤-6把业务接口变成-agent-工具)。
