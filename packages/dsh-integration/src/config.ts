/**
 * Deployment-owned connection and authorization inputs.
 *
 * Everything here is fixed at process start by the deployment operator or the
 * business policy control plane. Live tenant behavior belongs to
 * `connector-settings.ts`.
 */
import z from '@deepseek-ai/schemastery'

import {
  assertConnectorSettings, DEFAULT_CONNECTOR_SETTINGS, TIMEOUT_LIMITS, WRITE_REASON_LIMITS,
  type ConnectorSettings,
} from './connector-settings.js'
import { compileGuard, type CompiledGuard, type GuardConfig } from './guard.js'
import { BUSINESS_TOOL_NAMES, type BusinessToolName, type ReadScope } from './policy.js'

const DEFAULT_TOKEN_ENDPOINT_PATH = '/internal/oauth/token'
const DEFAULT_BUSINESS_AUDIENCE = 'urn:dshserver:business-api'

export interface Config {
  readonly brokerUrl: string
  readonly tokenEndpointPath?: string
  readonly businessApiUrl: string
  readonly businessApiAudience?: string
  readonly runtimeLeaseFile: string
  readonly scopes: string[]
  readonly exposedTools: BusinessToolName[]
  readonly readScope: ReadScope
  readonly requestTimeoutMs?: number
  readonly writeOperationsEnabled?: boolean
  readonly minimumWriteReasonLength?: number
  readonly guard?: GuardConfig
}

export interface ResolvedConfig {
  readonly brokerUrl: string
  readonly tokenEndpointPath: string
  readonly businessApiUrl: string
  readonly businessApiAudience: string
  readonly runtimeLeaseFile: string
  readonly scopes: readonly string[]
  readonly exposedTools: readonly BusinessToolName[]
  readonly readScope: ReadScope
  readonly settings: ConnectorSettings
  /** Policy for tools this plugin does not register; undefined when unconfigured. */
  readonly guard: CompiledGuard | undefined
}

export const Config: z<Config> = z.object({
  brokerUrl: z.string().required().description('OAuth Token Broker 的服务地址。'),
  tokenEndpointPath: z.string().default(DEFAULT_TOKEN_ENDPOINT_PATH).description('Broker 上的 Token Exchange 路径。'),
  businessApiUrl: z.string().required().description('业务 Resource Server 的服务地址。'),
  businessApiAudience: z.string().default(DEFAULT_BUSINESS_AUDIENCE).description('交换后 Access Token 的目标资源。'),
  runtimeLeaseFile: z.string().required().description('Runtime Manager 注入的短期执行租约文件。'),
  scopes: z.array(z.string()).default([]).description('已验证 Principal 允许的 OAuth Scope 上限。'),
  exposedTools: z.array(z.union(BUSINESS_TOOL_NAMES)).default([]).description('当前 Agent Preset 可见的业务工具。'),
  readScope: z.union(['customers:read:self', 'customers:read:team'] as const).required().description('当前角色的数据读取范围。'),
  requestTimeoutMs: z.number().step(1).min(TIMEOUT_LIMITS.min).max(TIMEOUT_LIMITS.max).default(TIMEOUT_LIMITS.fallback),
  writeOperationsEnabled: z.boolean().default(true),
  minimumWriteReasonLength: z.number().step(1).min(WRITE_REASON_LIMITS.min).max(WRITE_REASON_LIMITS.max).default(WRITE_REASON_LIMITS.fallback),
  guard: z.object({
    default: z.union(['allow', 'deny'] as const).required().description('未被任何规则匹配的工具如何处理。'),
    denyMessage: z.string().description('default 为 deny 时返回给模型的理由。'),
    rules: z.array(z.object({
      match: z.union([z.string(), z.array(z.string())]).required().description('工具名 glob，* 匹配任意字符。'),
      requireScopes: z.array(z.string()).default([]).description('调用该工具所需的 OAuth Scope。'),
      commandField: z.string().description('shell 类工具承载命令行的参数名，默认 command。'),
      allowCommands: z.array(z.string()).default([]).description('命令白名单正则；一条都不匹配即拒绝。'),
      arguments: z.dict(z.object({
        max: z.number().description('数值上限。'),
        min: z.number().description('数值下限。'),
        pattern: z.string().description('取值需匹配的正则。'),
        forbidden: z.boolean().description('该参数不允许由调用方指定。'),
      })).default({}).description('逐参数约束。'),
      deny: z.string().description('自定义拒绝理由，覆盖自动生成的那句。'),
    })).default([]).description('按顺序全部求值，任一拒绝即拒绝。'),
  }).description('对本插件未注册的工具（MCP、shell、文件、技能）施加的部署策略。'),
})

function requiredText(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`dshserver-integration: ${field} is required`)
  return normalized
}

function settingsOf(config: Config): ConnectorSettings {
  const settings = {
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_CONNECTOR_SETTINGS.requestTimeoutMs,
    writeOperationsEnabled: config.writeOperationsEnabled ?? DEFAULT_CONNECTOR_SETTINGS.writeOperationsEnabled,
    minimumWriteReasonLength: config.minimumWriteReasonLength ?? DEFAULT_CONNECTOR_SETTINGS.minimumWriteReasonLength,
  }
  assertConnectorSettings(settings)
  return settings
}

export function resolveConfig(config: Config): ResolvedConfig {
  const known = new Set<string>(BUSINESS_TOOL_NAMES)
  for (const tool of config.exposedTools) {
    if (!known.has(tool)) throw new Error(`dshserver-integration: unknown exposed tool ${JSON.stringify(tool)}`)
  }
  return {
    brokerUrl: requiredText(config.brokerUrl, 'brokerUrl'),
    tokenEndpointPath: config.tokenEndpointPath?.trim() || DEFAULT_TOKEN_ENDPOINT_PATH,
    businessApiUrl: requiredText(config.businessApiUrl, 'businessApiUrl'),
    businessApiAudience: config.businessApiAudience?.trim() || DEFAULT_BUSINESS_AUDIENCE,
    runtimeLeaseFile: requiredText(config.runtimeLeaseFile, 'runtimeLeaseFile'),
    scopes: [...new Set(config.scopes.filter(Boolean))],
    exposedTools: [...new Set(config.exposedTools)],
    readScope: config.readScope,
    settings: settingsOf(config),
    guard: compileGuard(config.guard),
  }
}
