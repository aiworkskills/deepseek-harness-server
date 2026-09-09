import { describe, expect, it } from 'vitest'
import { blockedDshRpc, blockedRpcPrefixes, BLOCKED_RPC_PREFIX_SHAPE, prepareSessionCreateBody } from './gateway-policy.js'

describe('managed DSH Gateway policy', () => {
  it('allows conversation RPCs while denying configuration and host mutations to ordinary users', () => {
    expect(blockedDshRpc('/api/settings/describe')).toBe(true)
    expect(blockedDshRpc('/api/workspace/list')).toBe(false)
    expect(blockedDshRpc('/api/settings/update')).toBe(true)
    expect(blockedDshRpc('/api/credentials/describe')).toBe(true)
    expect(blockedDshRpc('/api/directoryPicker/listDirectory')).toBe(true)
    expect(blockedDshRpc('/api/workspace/create')).toBe(true)
    expect(blockedDshRpc('/api/agentPresets/copy')).toBe(true)
    expect(blockedDshRpc('/api/session/models')).toBe(false)
    expect(blockedDshRpc('/api/session/selectModel')).toBe(false)
  })

  /**
   * 这几条是本仓库唯一挡住「在 Runtime 宿主机上执行本地程序」的东西。
   *
   * `nativeOpen: false` 挡不住：上游 session-controller 只把它喂给能力探测
   * `canOpenWorkspacePath`，`openWorkspacePath` 自己不查，直接走到
   * `open`/`xdg-open`。所以这条断言塌了就等于把宿主机命令执行放给了任何被网关
   * 放行的主体，包括只有 `assistant:use` 的业务用户。
   */
  it('denies the host desktop opener even to platform administrators', () => {
    const admin = ['assistant:use', 'assistant:platform:write']
    for (const scopes of [[], admin]) {
      expect(blockedDshRpc('/api/session/openWorkspacePath', scopes)).toBe(true)
      expect(blockedDshRpc('/api/session/canOpenWorkspacePath', scopes)).toBe(true)
    }
  })

  /**
   * 前缀必须对得上 DSH 当前版本的命名空间。写错的前缀是一条永远为真、却永远不会
   * 被请求命中的规则——0.1.1→0.1.5 就这样丢过一次拦截，而当时的测试断言的正是
   * 那些已经不存在的路径，所以全绿。这里只列真实存在的方法。
   */
  /**
   * DSH 0.1.5 把端点从 `<ns>.<method>` 改成了 `<ns>/<method>`。点号写法在 0.1.5 上
   * 指向一条不存在的路径——规则永远为真、请求永远不来，于是被锁的能力实际全部敞开，
   * 而且不会有任何报错。这条断言让形状回退当场变红。
   */
  it('spells every blocked prefix in the slash shape DSH actually serves', () => {
    for (const prefix of blockedRpcPrefixes) {
      expect(prefix, `${prefix} 不是 /api/<ns>/<method> 形状`).toMatch(BLOCKED_RPC_PREFIX_SHAPE)
      expect(prefix, `${prefix} 仍用 0.1.1 的点号分隔`).not.toContain('.')
    }
  })

  it('names namespaces that exist in the pinned DSH version', () => {
    expect(blockedDshRpc('/api/pluginInventory/list')).toBe(true)
    expect(blockedDshRpc('/api/permissionPresets/list')).toBe(true)
    expect(blockedDshRpc('/api/cordisInspect/describe')).toBe(true)
    // 0.1.5 已无 host 命名空间；仍然拦得住只能说明规则写错了对象。
    expect(blockedDshRpc('/api/host.listDirectory')).toBe(false)
    expect(blockedDshRpc('/api/agentPreset.copy')).toBe(false)
  })

  it('allows the native DSH configuration plane only with platform write scope', () => {
    const scopes = ['assistant:use', 'assistant:platform:write']
    expect(blockedDshRpc('/api/settings/describe', scopes)).toBe(false)
    expect(blockedDshRpc('/api/settings/mutate', scopes)).toBe(false)
    expect(blockedDshRpc('/api/credentials/describe', scopes)).toBe(false)
    expect(blockedDshRpc('/api/credentials/set', scopes)).toBe(false)
    expect(blockedDshRpc('/api/llm/discoverModels', scopes)).toBe(false)
    expect(blockedDshRpc('/api/settings/openDocument', scopes)).toBe(true)
    expect(blockedDshRpc('/api/cordisInspect/run', scopes)).toBe(true)
    expect(blockedDshRpc('/api/pluginInventory/install', scopes)).toBe(true)
  })

  it('pins every new session to the managed workspace and business preset', () => {
    const incoming = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session/create',
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
      method: 'session/create',
      payload: { agentPreset: 'standard' },
    }))
    expect(() => prepareSessionCreateBody(incoming, {
      managedWorkspaceId: 'workspace-managed',
    })).toThrow('only the managed business preset is allowed')
  })

})
