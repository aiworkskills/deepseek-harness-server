# 安全策略

## 支持范围

安全修复优先发布到最新的次版本。项目进入稳定发布前，`0.x` 版本可能包含不兼容修改，
但已公开版本中的高风险漏洞仍会评估并修复。

三个公开包锁步发版，安全修复会同时发布。

## 私下报告漏洞

请使用本仓库的 **Security > Report a vulnerability** 创建私密 Security Advisory。
不要在公开 Issue、Discussion、Pull Request 或聊天群中披露以下内容：

- 身份伪造、Scope 扩大、对象级授权绕过；
- Runtime、工作区、会话或租户隔离逃逸；
- Token、Runtime 租约、模型凭据或业务数据泄露；
- 可导致宿主代码执行、任意插件安装或配置提权的问题。

报告应包含受影响版本、复现条件、影响、最小复现和建议缓解方式。维护者确认后会在
Security Advisory 中协调修复、版本与披露时间。

## 不属于本项目的漏洞

本仓库不实现登录、不保存业务数据、也不执行最终的对象级授权。以下问题请报告给对应
项目：

- DeepSeek Harness 自身的问题 → [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 集成方 IAM、BFF 或业务 Resource Server 的问题 → 对应系统的维护方

如果不确定边界在哪一侧，仍然请按上面的流程私下报告，我们会协助定位。

## 设计级安全边界

本项目的信任边界、失败关闭行为和上线前自查清单见[安全模型](docs/security-model.md)。
