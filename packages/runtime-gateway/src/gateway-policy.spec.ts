import { describe, expect, it } from 'vitest'
import { blockedDshRpc, prepareSessionCreateBody } from './gateway-policy.js'

describe('managed DSH Gateway policy', () => {
  it('allows conversation RPCs while denying configuration and host mutations to ordinary users', () => {
    expect(blockedDshRpc('/api/settings.describe')).toBe(true)
    expect(blockedDshRpc('/api/workspace.list')).toBe(false)
    expect(blockedDshRpc('/api/settings.update')).toBe(true)
    expect(blockedDshRpc('/api/credentials.describe')).toBe(true)
    expect(blockedDshRpc('/api/host.listDirectory')).toBe(true)
    expect(blockedDshRpc('/api/workspace.create')).toBe(true)
    expect(blockedDshRpc('/api/agentPreset.copy')).toBe(true)
    expect(blockedDshRpc('/api/session.models')).toBe(false)
    expect(blockedDshRpc('/api/session.selectModel')).toBe(false)
  })

  it('allows the native DSH configuration plane only with platform write scope', () => {
    const scopes = ['assistant:use', 'assistant:platform:write']
    expect(blockedDshRpc('/api/settings.describe', scopes)).toBe(false)
    expect(blockedDshRpc('/api/settings.mutate', scopes)).toBe(false)
    expect(blockedDshRpc('/api/credentials.describe', scopes)).toBe(false)
    expect(blockedDshRpc('/api/credentials.set', scopes)).toBe(false)
    expect(blockedDshRpc('/api/llm.discoverModels', scopes)).toBe(false)
    expect(blockedDshRpc('/api/settings.openDocument', scopes)).toBe(true)
    expect(blockedDshRpc('/api/cordis.run', scopes)).toBe(true)
    expect(blockedDshRpc('/api/plugin.install', scopes)).toBe(true)
  })

  it('pins every new session to the managed workspace and business preset', () => {
    const incoming = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session.create',
      payload: {
        sessionId: 'session-client-selected',
        workspaceId: 'workspace-attacker-selected',
        cwd: '/tmp/untrusted',
      },
    }))
    const prepared = JSON.parse(prepareSessionCreateBody(incoming, {
      managedWorkspaceId: 'workspace-managed',
    }).toString('utf8')) as { payload: Record<string, unknown> }

    expect(prepared.payload).toEqual({
      sessionId: 'session-client-selected',
      workspaceId: 'workspace-managed',
      agentPreset: 'business',
    })
  })

  it('rejects attempts to choose another Agent Preset', () => {
    const incoming = Buffer.from(JSON.stringify({
      method: 'session.create',
      payload: { agentPreset: 'standard' },
    }))
    expect(() => prepareSessionCreateBody(incoming, {
      managedWorkspaceId: 'workspace-managed',
    })).toThrow('only the managed business preset is allowed')
  })

})
