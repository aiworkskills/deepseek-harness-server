# @dshserver/dsh-preferences

DSH Server 的浏览器侧插件。它做三件事：持久化 DeepSeek Harness 的个人主题选择；接收
嵌入方业务系统送来的一段话并放进 DSH 输入框；在 DSH 原生「设置 > 插件」页注册
`DSH Server 业务集成`配置卡片。卡片只读写已审核的租户行为：请求超时、写操作总开关和
最短变更原因长度；不读取 OAuth Scope、业务数据或模型凭据。

该包具有 Host 占位入口和 `dsh.client` 浏览器入口，以标准 DSH 客户端插件机制加载。
浏览器存储不可用时，主题会安全降级为当前页面状态。租户配置使用 DSH Settings RPC，
只有 Gateway 授予 `assistant:platform:write` 的平台管理员能够读取或修改。

```yaml
- id: dshserver-preferences
  name: '@dshserver/dsh-preferences'
```

## 从业务系统把一段话送进对话框

业务页面常常已经知道用户此刻要问什么。插件监听 `postMessage`，把这段话写进当前会话的
输入框草稿，用户读完再自己按发送。

**插件只填写输入框，不代替用户发送。** 嵌入页面因此无法让智能体自行说话或调用业务
工具；话术进入模型之前一定经过用户确认。

### 发送

```js
frame.contentWindow.postMessage({
  channel: 'dshserver.composer',
  version: 1,
  type: 'insert',
  requestId: crypto.randomUUID(), // 可选；带上它，重发不会重复插入
  text: '查一下 CUS-1011 青屿能源的详情。',
  mode: 'append',                 // 可选，默认 append，不覆盖用户已经写的内容
}, location.origin)
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `channel` | 是 | 固定为 `dshserver.composer`，其余消息一律忽略 |
| `version` | 是 | 当前为 `1`；版本不匹配直接拒绝，不做兼容猜测 |
| `type` | 是 | `insert` 送入话术，`ping` 探测插件是否就绪 |
| `text` | `insert` 必填 | 最长 4000 字符 |
| `mode` | 否 | `append`（默认）追加到用户草稿后，`replace` 覆盖 |
| `requestId` | 否 | 最长 128 字符；同一 id 重发只插入一次 |

### 回复

插件向发送方回 `{ channel, version, type: 'result', status, reason?, requestId? }`：

| `status` | 含义 |
|---|---|
| `applied` | 已放进输入框 |
| `pending` | 会话尚未就绪，已暂存，就绪后自动填入（只保留最后一条） |
| `rejected` | 被拒绝，原因见 `reason` |

`reason` 取值：`unsupported-version`、`malformed`、`empty-text`、`text-too-long`、
`draft-too-long`（合并后草稿超过 8000 字符）、`composer-busy`（输入框正在提交）。

插件激活时会向 `parent` 与 `opener` 各发送一条 `{ type: 'ready' }`；`ping` 也返回同样的
消息。业务页面收不到任何回复时应退回到自己的兜底方案。

### 安全边界

- **同源且是嵌入方**：只接受 `event.origin` 等于当前源、且 `event.source` 是 `parent`
  或 `opener` 的消息。跨源发送被静默忽略，不回复、不报错。部署方用统一域名或
  反向代理把业务页面与嵌入助手放在同一个源。
- **只写草稿**：写入走 DSH 原生输入机的唯一草稿写入路径，不触碰会话、工具或模型。
  正在提交的输入框会被拒绝，不会打断用户已经按下的发送。
- **清洗文本**：剥离控制字符与 U+FFFC（DSH 输入框的引用占位符），换行统一成 `\n`。
- **不使用 URL 参数**：话术不经查询参数传递，避免进入浏览器历史与网关访问日志。

协议实现见 `src/composer-bridge.ts`，完整消息格式见
[工具与 API 参考 · 对话框话术接口](../../docs/tools-and-api.md#对话框话术接口)，集成步骤见
[集成指南 · 步骤 8](../../docs/integration.md#步骤-8从业务页面把一段话送进对话框)。

本包采用 [MIT License](LICENSE)。
