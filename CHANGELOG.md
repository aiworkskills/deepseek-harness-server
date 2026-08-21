# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)，变更按 Keep a Changelog 的类别组织。
三个公开包锁步发版，共用同一个版本号。

## [Unreleased]

## [0.1.0] - 2026-08-21

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

### 支持的 DSH 版本

`0.1.0-rc.8`。DSH 仍处于预发布阶段，安装时需要精确锁定版本，原因见
[兼容性](docs/compatibility.md)。

[Unreleased]: https://github.com/aiworkskills/deepseek-harness-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aiworkskills/deepseek-harness-server/releases/tag/v0.1.0
