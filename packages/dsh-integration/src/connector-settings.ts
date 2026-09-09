/**
 * Tenant-level behavior a platform administrator may change at runtime.
 *
 * This module owns the `dshserver-integration` settings namespace: the value
 * shape, its validation limits, the Host-lifetime installation, and the live
 * read used by tools. Deployment-time connection inputs live in `config.ts`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: this package needs nothing from DSH Settings at runtime, only the
// declaration that puts `settings` on `Context`. A plain side-effect import would
// survive compilation, and a plugin linked into a profile has no `node_modules` of
// its own to resolve it from.
import type {} from '@deepseek-ai/dsh-settings'

/**
 * The namespace this connector owns.
 *
 * A plain literal, and it must stay one: `register` and `get` validate the
 * namespace's shape at the type level, which only works while this keeps its
 * narrow literal type. Widening it to `string` silently disables that check.
 */
export const CONNECTOR_SETTINGS_NAMESPACE = 'dshserver-integration'

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

/**
 * Attach the safe tenant behavior section to DSH Settings.
 *
 * The Host plane only owns the namespace. Tools read the live value through
 * `connectorSettings()` on every call, so this owner keeps no source of its
 * own and has nothing to recompute when the administrator saves a change.
 */
export function installConnectorSettings(ctx: Context, base: ConnectorSettings): void {
  // `register`，不是 `installSection`：后者多出的 setSource/onChange 是给那些缓存配置、
  // 需要在 provider 脱离时回退到组合期入参的消费者用的，而这个消费者两样都不做——
  // `connectorSettings()` 每次调用重新读一次，并自带回退。
  //
  // 也不需要在这里 `ctx.inject(['settings'], …)`：调用方 `settings.ts` 已声明
  // `inject = ['settings']`，没有 provider 时 cordis 不会执行到这里。
  ctx.settings.register(CONNECTOR_SETTINGS_NAMESPACE, ConnectorSettingsSchema, {
    base,
    validate: assertConnectorSettings,
  })
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
