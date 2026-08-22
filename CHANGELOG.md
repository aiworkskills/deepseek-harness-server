# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)，变更按 Keep a Changelog 的类别组织。
三个公开包锁步发版，共用同一个版本号。

## [Unreleased]

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
