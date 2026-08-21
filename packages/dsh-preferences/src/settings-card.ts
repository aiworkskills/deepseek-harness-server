/**
 * Native DSH settings card for the tenant connector policy. Rendering and
 * draft validation are UX-level only; the Runtime settings namespace remains
 * the authority and rejects out-of-range writes.
 */
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createElement as h, useEffect, useState, useSyncExternalStore,
  type ChangeEvent, type CSSProperties, type ReactNode,
} from 'react'

export const CONNECTOR_SETTINGS_NAMESPACE = 'dshserver-integration'

export interface ConnectorSettings {
  readonly requestTimeoutMs: number
  readonly writeOperationsEnabled: boolean
  readonly minimumWriteReasonLength: number
}

export interface ConnectorDraft {
  readonly requestTimeoutMs: string
  readonly writeOperationsEnabled: boolean
  readonly minimumWriteReasonLength: string
}

const card: CSSProperties = {
  listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
}
const header: CSSProperties = {
  width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
  border: 0, borderRadius: 12, background: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer',
}
const body: CSSProperties = {
  margin: '0 16px', paddingBottom: 8, borderTop: '1px solid var(--dsw-alias-border-l2)',
}
const field: CSSProperties = {
  padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 6,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}
const input: CSSProperties = {
  height: 34, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
  font: 'inherit', fontSize: 13,
}
const quietButton: CSSProperties = {
  padding: '5px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
  background: 'none', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 13,
  cursor: 'pointer',
}
const saveButton: CSSProperties = {
  ...quietButton, borderColor: 'transparent', background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
}

function draftOf(settings: ConnectorSettings): ConnectorDraft {
  return {
    requestTimeoutMs: String(settings.requestTimeoutMs),
    writeOperationsEnabled: settings.writeOperationsEnabled,
    minimumWriteReasonLength: String(settings.minimumWriteReasonLength),
  }
}

export function connectorDraftProblem(draft: ConnectorDraft): string | undefined {
  const timeout = Number(draft.requestTimeoutMs)
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    return '请求超时必须是 1000 到 120000 之间的整数。'
  }
  const reasonLength = Number(draft.minimumWriteReasonLength)
  if (!Number.isInteger(reasonLength) || reasonLength < 2 || reasonLength > 200) {
    return '变更原因长度必须是 2 到 200 之间的整数。'
  }
  return undefined
}

function sameDraft(left: ConnectorDraft, right: ConnectorDraft): boolean {
  return left.requestTimeoutMs === right.requestTimeoutMs
    && left.writeOperationsEnabled === right.writeOperationsEnabled
    && left.minimumWriteReasonLength === right.minimumWriteReasonLength
}

function useSettingsSnapshot(scope: SettingsScope<ConnectorSettings>): SettingsScopeSnapshot<ConnectorSettings> {
  return useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
}

function FieldLabel({ children }: { children?: ReactNode }) {
  return h('span', {
    style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  }, children)
}

function FieldHint({ children, problem = false }: { children?: ReactNode; problem?: boolean }) {
  return h('span', {
    style: {
      fontSize: 12, lineHeight: 1.5,
      color: problem ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-label-tertiary)',
    },
  }, children)
}

function hasOwn(value: unknown, fieldName: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, fieldName)
}

export function ConnectorSettingsCard({ scope }: { scope: SettingsScope<ConnectorSettings> }) {
  const snapshot = useSettingsSnapshot(scope)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ConnectorDraft>()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const effective = snapshot.value
  const current = effective === undefined ? undefined : draftOf(effective)
  const displayed = draft ?? current
  const dirty = displayed !== undefined && current !== undefined && !sameDraft(displayed, current)
  const problem = displayed === undefined ? undefined : connectorDraftProblem(displayed)

  useEffect(() => {
    if (!dirty && effective !== undefined) setDraft(draftOf(effective))
  }, [dirty, effective?.minimumWriteReasonLength, effective?.requestTimeoutMs, effective?.writeOperationsEnabled])

  if (snapshot.status !== 'ready' || displayed === undefined || current === undefined) {
    return h('li', { style: card }, h('div', { style: header },
      h('span', { style: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } },
        h('strong', { style: { fontSize: 15, color: 'var(--dsw-alias-label-primary)' } }, 'DSH Server 业务集成'),
        h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '配置暂不可用，请检查 Gateway 设置权限与 namespace 白名单。'))))
  }

  async function save(): Promise<void> {
    if (!dirty || problem !== undefined || !snapshot.writable || saving) return
    setSaving(true)
    setFailed(false)
    try {
      const timeout = Number(displayed!.requestTimeoutMs)
      const reasonLength = Number(displayed!.minimumWriteReasonLength)
      if (displayed!.requestTimeoutMs !== current!.requestTimeoutMs) {
        await scope.set('requestTimeoutMs', timeout)
        if (scope.getSnapshot().value?.requestTimeoutMs !== timeout) throw new Error('requestTimeoutMs was rejected')
      }
      if (displayed!.writeOperationsEnabled !== current!.writeOperationsEnabled) {
        await scope.set('writeOperationsEnabled', displayed!.writeOperationsEnabled)
        if (scope.getSnapshot().value?.writeOperationsEnabled !== displayed!.writeOperationsEnabled) throw new Error('writeOperationsEnabled was rejected')
      }
      if (displayed!.minimumWriteReasonLength !== current!.minimumWriteReasonLength) {
        await scope.set('minimumWriteReasonLength', reasonLength)
        if (scope.getSnapshot().value?.minimumWriteReasonLength !== reasonLength) throw new Error('minimumWriteReasonLength was rejected')
      }
      setDraft(undefined)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  async function restoreDefaults(): Promise<void> {
    if (!snapshot.writable || saving) return
    setSaving(true)
    setFailed(false)
    try {
      for (const fieldName of ['requestTimeoutMs', 'writeOperationsEnabled', 'minimumWriteReasonLength']) {
        await scope.unset(fieldName)
        if (hasOwn(scope.getSnapshot().user, fieldName)) throw new Error(`${fieldName} was not cleared`)
      }
      setDraft(undefined)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return h('li', { style: card },
    h('button', {
      type: 'button', style: header, 'aria-expanded': open,
      'aria-label': `${open ? '收起' : '展开'} DSH Server 业务集成`,
      onClick: () => { setOpen(!open) },
    },
    h('span', { style: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } },
      h('strong', { style: { fontSize: 15, color: 'var(--dsw-alias-label-primary)' } }, 'DSH Server 业务集成'),
      h('span', { style: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } }, '租户级业务请求与写操作安全策略。')),
    dirty ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '未保存') : null,
    h('span', { 'aria-hidden': true, style: { fontSize: 18, color: 'var(--dsw-alias-label-tertiary)' } }, open ? '-' : '+')),
    open ? h('div', { style: body },
      !snapshot.writable ? h(FieldHint, {}, '当前 Runtime 只允许平台管理员修改此配置。') : null,
      h('label', { style: field },
        h(FieldLabel, {}, '业务请求超时（毫秒）'),
        h('input', {
          style: input, type: 'number', min: 1000, max: 120000, step: 1,
          value: displayed.requestTimeoutMs, disabled: !snapshot.writable || saving,
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            setDraft({ ...displayed, requestTimeoutMs: event.target.value }); setFailed(false)
          },
        }),
        h(FieldHint, {}, '同时限制 Token Exchange 与业务 API 的单次请求时间。')),
      h('label', { style: { ...field, flexDirection: 'row', alignItems: 'center' } },
        h('input', {
          type: 'checkbox', checked: displayed.writeOperationsEnabled,
          disabled: !snapshot.writable || saving,
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            setDraft({ ...displayed, writeOperationsEnabled: event.target.checked }); setFailed(false)
          },
        }),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(FieldLabel, {}, '允许 Agent 执行业务写操作'),
          h(FieldHint, {}, '关闭后，所有写工具立即失效，即使用户拥有写 Scope。'))),
      h('label', { style: field },
        h(FieldLabel, {}, '最短变更原因长度'),
        h('input', {
          style: input, type: 'number', min: 2, max: 200, step: 1,
          value: displayed.minimumWriteReasonLength, disabled: !snapshot.writable || saving,
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            setDraft({ ...displayed, minimumWriteReasonLength: event.target.value }); setFailed(false)
          },
        }),
        h(FieldHint, {}, '写工具必须给出达到该长度的业务变更原因。')),
      problem !== undefined ? h(FieldHint, { problem: true }, problem) : null,
      failed ? h(FieldHint, { problem: true }, '保存失败，配置已重新从 Runtime 同步。') : null,
      h('div', { style: { padding: '12px 0 4px', display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        h('button', { type: 'button', style: quietButton, disabled: !snapshot.writable || saving, onClick: () => { void restoreDefaults() } }, '恢复默认'),
        h('button', { type: 'button', style: quietButton, disabled: !dirty || saving, onClick: () => { setDraft(current); setFailed(false) } }, '放弃修改'),
        h('button', { type: 'button', style: saveButton, disabled: !dirty || problem !== undefined || !snapshot.writable || saving, onClick: () => { void save() } }, saving ? '保存中...' : '保存')),
    ) : null)
}
