# @dshserver/runtime-gateway

部署侧运行模块，不属于演示业务系统。它提供经过验证的 `GatewayPrincipal` 契约、每用户
独立 Runtime 生命周期、受管 Workspace/Preset 注入，以及 DSH HTTP/WebSocket 管理接口
锁定策略。`session.models` 和 `session.selectModel` 不在拒绝列表内，保留给用户；可选范围
就是管理员维护的租户模型目录，Runtime 里不存在目录之外的模型，因此 Gateway 不再对选择
结果做二次校验。Provider、凭据和模型目录仍由部署方维护。

该包不负责登录，不保存业务用户、角色或业务数据，也不实现对象级授权。生产接入时由
既有 IAM 提供可信 Principal，由既有策略控制面计算 `RuntimePrincipal`，由业务 API 或
MCP Server 对具体数据执行最终授权。

Runtime 需要三份部署侧资产：已构建的集成插件、已构建的浏览器插件，以及 Agent Preset 与
企业 Profile。默认按参考部署的目录约定从 `projectRoot` 派生（`<projectRoot>/plugin`、
`<pluginRoot>/preferences`、`<pluginRoot>/config`）；宿主应用的目录结构不同时，用
`RuntimeManagerOptions` 的 `pluginRoot`、`preferencesRoot`、`configRoot` 直接指定，不必
复制出一个 `plugin/` 目录。

接入步骤见[集成指南 · 步骤 4](../../docs/integration.md#步骤-4部署-runtime-gateway-并代理-dsh-流量)，
可配置项见[配置参考 · Runtime Gateway 选项](../../docs/configuration.md#runtime-gateway-选项)。
