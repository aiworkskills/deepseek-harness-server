# local-smoke

本机跑通业务连接器全链路的契约检查。**不需要** DeepSeek Harness 进程、模型凭据或任何
网络出口。

```bash
pnpm example        # 从仓库根目录运行
```

## 它做了什么

1. 在 loopback 上拉起一个假的 Token Broker（RFC 8693 Token Exchange）和一个假的业务
   Resource Server。
2. 写入一份格式与 Runtime Manager 一致的短期租约文件。
3. 用真实的 `apply()` 把插件装到一个最小的 `ctx.tools` 桩上（只实现 `register` 与
   `guard` 两个方法）。
4. 驱动五组场景并逐条断言。

## 覆盖的场景

| 场景 | 断言 |
|---|---|
| 团队管理者读取、统计、写入 | 换票 Scope 正确、写请求带幂等键、过短的变更原因被拒绝 |
| 普通员工缺少团队与写 Scope | 守卫拒绝，且不发起任何 Token Exchange |
| 租户写操作总开关关闭 | 即使持有写 Scope 也被拒绝，只读工具不受影响 |
| 执行租约过期 | 所有工具在进程内失败关闭 |
| 身份来源 | 业务 API 观察到的 Subject 始终来自租约，而非模型参数 |

## 为什么不启动真实的 Harness

`ToolRuntime` 有九个 peer 依赖，启动它等于把半个 Harness 拉进这个仓库，而且每次 DSH
发预发布版本都会碎。这里换一个取舍：**只验证本仓库拥有的那段边界**——Scope 派生、
执行前守卫、写开关、换票和下游请求形状——代价是不覆盖 DSH 自己的工具调度。

真实 Harness 中的行为验证属于集成方的验收范围，步骤见
[集成指南 · 步骤 9](../../docs/integration.md#步骤-9接入验收清单)。

## 拿它当参考实现

[`smoke.mjs`](smoke.mjs) 里的 `startBroker()` 是一份可读的最小 Token Exchange 实现：
验证租约、按租约 Scope 降权、签发短期业务 Token。接自己的 IAM 时可以对照它确认契约。

> 示例里的租约和 Token 都是**未签名**的，只为在本机跑通形状。生产环境必须使用签名
> 令牌并在 Broker 侧做完整校验。
