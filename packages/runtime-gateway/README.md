# @dshserver/runtime-gateway

部署侧运行模块，不属于演示业务系统。它提供经过验证的 `GatewayPrincipal` 契约、每用户
独立 Runtime 生命周期、受管 Workspace/Preset 注入，以及 DSH HTTP/WebSocket 管理接口
锁定策略。`session.models` 和 `session.selectModel` 保留给用户，Gateway 对选择结果执行
部署模型白名单校验；Provider、凭据和模型目录仍由部署方维护。

该包不负责登录，不保存业务用户、角色或业务数据，也不实现对象级授权。生产接入时由
既有 IAM 提供可信 Principal，由既有策略控制面计算 `RuntimePrincipal`，由业务 API 或
MCP Server 对具体数据执行最终授权。

接入步骤见[集成指南 · 步骤 4](../../docs/integration.md#步骤-4部署-runtime-gateway-并代理-dsh-流量)，
可配置项见[配置参考 · Runtime Gateway 选项](../../docs/configuration.md#runtime-gateway-选项)。
