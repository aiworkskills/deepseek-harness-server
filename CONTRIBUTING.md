# 参与贡献

感谢你改进本项目。这里优先接受能降低接入门槛、增加可复用连接器、完善安全边界或改善
文档的贡献。

## 开始之前

1. 搜索现有 Issue，确认问题尚未被讨论或解决。
2. 对协议、权限模型、公共 API 或大范围重构，先创建设计 Issue。
3. 安全漏洞不要提交公开 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

## 本地开发

要求 Node.js `>=22.19`、pnpm 11。**不需要**本地构建 DeepSeek Harness——本仓库只依赖它
发布到 npm 的包。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm example
```

`pnpm example` 会拉起本机的假 Broker 与假业务 API，跑通授权、换票、写入与失败关闭。
改动授权链路后请务必跑一次——它比类型检查更能发现运行期契约变化。

支持的 DSH 版本见[兼容性](docs/compatibility.md)。升级 `@deepseek-ai/*` 需要同时更新那份
支持矩阵。

## 工程约束

这几条是本项目的安全边界，不接受以「先跑通再说」为由的例外：

- 模型参数不能包含 Subject、Tenant、角色、Access Token 或其他可信身份字段。
- 工具通过业务 API 或 MCP Resource 访问数据，不直接连接业务数据库。
- 新工具必须在 [`policy.ts`](packages/dsh-integration/src/policy.ts) 声明 Scope 与写标记；
  申请的 Scope 必须等于守卫检查的 Scope。
- UI 隐藏不是安全边界；对应的 Gateway、Runtime 或业务 API 必须拒绝越权调用。
- 新配置必须明确属于部署、租户、业务策略还是用户偏好，不能混在同一设置面。
- 写操作必须携带幂等键，并在业务侧留下审计记录。

新增连接器的完整检查表见[插件架构 · 扩展检查表](docs/ARCHITECTURE.md#扩展检查表)。

## 提交 Pull Request

提交前运行：

```bash
corepack pnpm check
corepack pnpm example
corepack pnpm release:check
```

Pull Request 应说明问题、方案、安全影响和验证方式。请保持改动范围集中，不要提交
`dist/`、`.env`、模型凭据或真实业务数据。

行为变化需要测试覆盖。授权相关的改动至少要覆盖：允许执行、缺少 Scope、对象级拒绝、
超时、写操作幂等这五种行为。

提交贡献即表示你同意以本仓库的 [MIT License](LICENSE) 发布该贡献。
