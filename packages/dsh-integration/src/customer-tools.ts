/**
 * Example CRM catalog. A new integration should define its own catalog file
 * beside this one and reuse the configuration, policy, and delegated client
 * layers unchanged. Model arguments carry business inputs only; identity and
 * credentials always come from trusted runtime context.
 */
import { businessTool, type BusinessToolRegistration } from './catalog.js'

const CUSTOMER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, company: { type: 'string', required: true },
    industry: { type: 'string', required: true }, contactName: { type: 'string', required: true },
    contactTitle: { type: 'string', required: true }, stage: { type: 'string', required: true },
    level: { type: 'string', required: true }, ownerName: { type: 'string', required: true },
    teamName: { type: 'string', required: true }, expectedValue: { type: 'number', required: true },
    nextFollowUp: { type: 'string', required: true }, lastContactAt: { type: 'string', required: true },
    note: { type: 'string', required: true },
  },
} as const

export const CUSTOMER_TOOLS: readonly BusinessToolRegistration[] = [
  businessTool({
    name: 'business_list_customers',
    description: '查询当前登录销售有权查看的 CRM 客户。身份和数据范围由 OAuth 授权自动确定，不接受用户 ID。',
    parameters: {
      stage: { type: 'string', description: '可选销售阶段：潜在客户、需求确认、方案沟通、商务谈判、已成交。' },
      keyword: { type: 'string', description: '可选关键词，匹配客户名称、联系人、行业或备注。' },
    },
    output: {
      type: 'object', additionalProperties: false,
      properties: {
        visibility: { type: 'string', required: true, enum: ['self', 'team'] },
        total: { type: 'integer', required: true },
        items: { type: 'array', required: true, items: CUSTOMER_SCHEMA },
      },
    },
    presentCall: () => ({ card: 'generic', title: '查询授权范围内的客户', kind: 'search' }),
    request(args) {
      const query = new URLSearchParams()
      if (args.stage) query.set('stage', args.stage)
      if (args.keyword) query.set('keyword', args.keyword)
      return { path: query.size === 0 ? '/v1/customers' : `/v1/customers?${query.toString()}` }
    },
  }),
  businessTool({
    name: 'business_get_customer',
    description: '读取一位 CRM 客户。业务 API 会依据当前 OAuth Subject 执行客户级授权。',
    parameters: {
      customer_id: { type: 'string', required: true, description: '客户编号，例如 CUS-1001。' },
    },
    output: {
      type: 'object', additionalProperties: false,
      properties: { record: { ...CUSTOMER_SCHEMA, required: true } },
    },
    presentCall: args => ({ card: 'generic', title: `读取 ${args.customer_id}`, kind: 'read' }),
    request: args => ({ path: `/v1/customers/${encodeURIComponent(args.customer_id)}` }),
  }),
  businessTool({
    name: 'business_customer_overview',
    description: '读取当前登录管理者所在团队的客户与销售管道概览，需要团队分析权限。',
    parameters: {},
    output: {
      type: 'object', additionalProperties: false,
      properties: {
        teamName: { type: 'string', required: true },
        total: { type: 'integer', required: true },
        pipelineValue: { type: 'number', required: true },
        highValue: { type: 'integer', required: true },
        followUpDue: { type: 'integer', required: true },
        byStage: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false,
          properties: { stage: { type: 'string', required: true }, count: { type: 'integer', required: true } },
        } },
      },
    },
    presentCall: () => ({ card: 'generic', title: '读取团队客户概览', kind: 'read' }),
    request: () => ({ path: '/v1/analytics/team-overview' }),
  }),
  businessTool({
    name: 'business_update_customer',
    description: '更新当前团队内一位客户的销售阶段，需要团队写权限；业务 API 执行最终客户级授权和审计。',
    parameters: {
      customer_id: { type: 'string', required: true, description: '客户编号，例如 CUS-1001。' },
      stage: { type: 'string', required: true, enum: ['潜在客户', '需求确认', '方案沟通', '商务谈判', '已成交'], description: '目标销售阶段。' },
      reason: { type: 'string', required: true, description: '变更原因，将写入业务审计记录。' },
    },
    output: {
      type: 'object', additionalProperties: false,
      properties: {
        changeId: { type: 'string', required: true },
        record: { ...CUSTOMER_SCHEMA, required: true },
      },
    },
    presentCall: args => ({ card: 'generic', title: `更新 ${args.customer_id} 为${args.stage}`, kind: 'execute' }),
    request(args, { settings }) {
      const reason = args.reason.trim()
      if (reason.length < settings.minimumWriteReasonLength) {
        throw new Error(`变更原因至少需要 ${settings.minimumWriteReasonLength} 个字符。`)
      }
      return {
        path: `/v1/customers/${encodeURIComponent(args.customer_id)}`,
        method: 'PATCH',
        body: { stage: args.stage, reason },
      }
    },
  }),
]
