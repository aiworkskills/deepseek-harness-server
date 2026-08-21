/**
 * Tenant-level behavior a platform administrator may change at runtime.
 *
 * This module owns the `dshserver-integration` settings namespace: the value
 * shape, its validation limits, the Host-lifetime installation, and the live
 * read used by tools. Deployment-time connection inputs live in `config.ts`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const CONNECTOR_SETTINGS_NAMESPACE = settingsNamespace('dshserver-integration')

export const TIMEOUT_LIMITS = { min: 1_000, max: 120_000, fallback: 15_000 } as const
export const WRITE_REASON_LIMITS = { min: 2, max: 200, fallback: 2 } as const

export interface ConnectorSettings {
  readonly requestTimeoutMs: number
  readonly writeOperationsEnabled: boolean
  readonly minimumWriteReasonLength: number
}

export const DEFAULT_CONNECTOR_SETTINGS: ConnectorSettings = {
  requestTimeoutMs: TIMEOUT_LIMITS.fallback,
  writeOperationsEnabled: true,
  minimumWriteReasonLength: WRITE_REASON_LIMITS.fallback,
}

export const ConnectorSettingsSchema: z<ConnectorSettings> = z.object({
  requestTimeoutMs: z.number().step(1).min(TIMEOUT_LIMITS.min).max(TIMEOUT_LIMITS.max).default(TIMEOUT_LIMITS.fallback)
    .description('业务 API 和 Token Exchange 的单次请求超时，单位为毫秒。'),
  writeOperationsEnabled: z.boolean().default(true)
    .description('租户级写操作总开关。关闭后，即使用户拥有写 Scope，Agent 也不能执行写工具。'),
  minimumWriteReasonLength: z.number().step(1).min(WRITE_REASON_LIMITS.min).max(WRITE_REASON_LIMITS.max).default(WRITE_REASON_LIMITS.fallback)
    .description('写工具要求模型提供的最短变更原因字符数。'),
})

export function assertConnectorSettings(settings: ConnectorSettings): void {
  if (!Number.isInteger(settings.requestTimeoutMs)
    || settings.requestTimeoutMs < TIMEOUT_LIMITS.min || settings.requestTimeoutMs > TIMEOUT_LIMITS.max) {
    throw new Error(`dshserver-integration: requestTimeoutMs must be an integer between ${TIMEOUT_LIMITS.min} and ${TIMEOUT_LIMITS.max}`)
  }
  if (!Number.isInteger(settings.minimumWriteReasonLength)
    || settings.minimumWriteReasonLength < WRITE_REASON_LIMITS.min || settings.minimumWriteReasonLength > WRITE_REASON_LIMITS.max) {
    throw new Error(`dshserver-integration: minimumWriteReasonLength must be an integer between ${WRITE_REASON_LIMITS.min} and ${WRITE_REASON_LIMITS.max}`)
  }
}

/** Attach the safe tenant behavior section to DSH Settings and return a live source. */
export function installConnectorSettings(ctx: Context, base: ConnectorSettings): () => ConnectorSettings {
  let current = () => base
  installSettingsSection(ctx, CONNECTOR_SETTINGS_NAMESPACE, ConnectorSettingsSchema, base, {
    validate: assertConnectorSettings,
    setSource: source => { current = source },
    onChange: () => {},
  })
  return () => current()
}

/** Read the Host-owned live section, falling back when this plugin is embedded without the profile owner. */
export function connectorSettings(ctx: Context, fallback: ConnectorSettings): ConnectorSettings {
  const provider = ctx.get('settings') as { get(namespace: typeof CONNECTOR_SETTINGS_NAMESPACE): unknown } | undefined
  const current = provider?.get(CONNECTOR_SETTINGS_NAMESPACE)
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return fallback
  const candidate = current as ConnectorSettings
  assertConnectorSettings(candidate)
  return candidate
}
