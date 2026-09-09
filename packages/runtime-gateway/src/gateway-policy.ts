const CONFIGURATION_SCOPE = 'assistant:platform:write'

/**
 * The RPCs DSH pins to a loopback authority.
 *
 * Harness refuses these outright when the request carries a non-loopback
 * `Host` — `settings.describe` is documented loopback-only upstream — because
 * for a desktop install "the caller is local" is the whole authorization
 * story. A managed deployment has a different one: the Gateway authenticated
 * the user and checked `assistant:platform:write` before anything reached a
 * Runtime, and the Runtime does in fact listen on loopback.
 *
 * Exported so the server in front can tell those two situations apart. Any
 * path named here reaches a Runtime only after `blockedDshRpc` has already
 * cleared it.
 */
export function isConfigurationRpc(pathname: string): boolean {
  return pathname === '/api/settings.describe'
    || pathname === '/api/settings.update'
    || pathname === '/api/settings.replace'
    || pathname === '/api/settings.mutate'
    || pathname.startsWith('/api/credentials.')
    || pathname === '/api/llm.discoverModels'
}

/**
 * RPC 前缀必须跟着 DSH 的命名空间走，而命名空间会在升级中改名。
 *
 * 0.1.1 → 0.1.5 就改过一次，而且是无声的：原生「用本机程序打开路径」当时叫
 * `host.openPath`，被下面的 `/api/host.open` 前缀拦住；0.1.5 把它挪到了
 * `session.openWorkspacePath`，四条 `/api/host.*` 于是一起变成死规则，而那个能在
 * Runtime 宿主机上执行 `open`/`xdg-open` 的方法失去了拦截。旧测试没发现，因为它
 * 断言的 `/api/host.listDirectory` 和 `/api/agentPreset.copy` 都是**当前版本里
 * 不存在的路径**——一条永远为真的规则套在一条永远不会到来的请求上。
 *
 * 所以每条都注上它对应的服务，升级时按 `super(ctx, …)` / `{ namespace: … }`
 * 重新核对一遍，并且测试只断言真实存在的方法名。
 */
const BLOCKED_RPC_PREFIXES = [
  // settings-controller，namespace 'settings'：打开配置文件落到宿主机桌面。
  '/api/settings.openDocument',
  // session-controller，namespace 'session'：`openWorkspacePath` 无条件调用原生
  // 打开器（`nativeOpen: false` 只影响能力探测 `canOpenWorkspacePath`，不影响它），
  // 所以边界只能在这里。session 命名空间其余方法是正常会话流量，不能整段拦。
  '/api/session.openWorkspacePath',
  '/api/session.canOpenWorkspacePath',
  // directory-picker，namespace 'directoryPicker'：0.1.1 时这些是 `host.*`。
  '/api/directoryPicker.',
  // cordis-inspect / dynamic-cordis-runner：任意插件装配与代码执行。
  '/api/cordisInspect.',
  '/api/dynamicCordisRunner.',
  // host plugin-inventory，namespace 'pluginInventory'。
  '/api/pluginInventory.',
  // permission-presets，namespace 'permissionPresets'。
  '/api/permissionPresets.',
  // workspace-controller，namespace 'workspace'：读取放行，结构变更拒绝。
  '/api/workspace.create',
  '/api/workspace.rename',
  '/api/workspace.delete',
  '/api/workspace.insertBefore',
  '/api/workspace.insertSessionBefore',
  // agent-presets，namespace 'agentPresets'（复数——0.1.1 起就是，旧规则写的是
  // 单数，从未命中过）。
  '/api/agentPresets.create',
  '/api/agentPresets.copy',
  '/api/agentPresets.remove',
  '/api/agentPresets.read',
  '/api/agentPresets.select',
] as const

export function blockedDshRpc(pathname: string, scopes: readonly string[] = []): boolean {
  if (isConfigurationRpc(pathname) && !scopes.includes(CONFIGURATION_SCOPE)) return true
  return BLOCKED_RPC_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

export function prepareSessionCreateBody(
  buffer: Buffer,
  runtime: { readonly managedWorkspaceId: string },
): Buffer {
  const parsed = JSON.parse(buffer.toString('utf8')) as {
    method?: unknown
    payload?: Record<string, unknown>
    [key: string]: unknown
  }
  if (parsed.method !== 'session.create' || typeof parsed.payload !== 'object' || parsed.payload === null) {
    throw new Error('invalid session.create RPC envelope')
  }
  const requestedPreset = parsed.payload.agentPreset
  if (requestedPreset !== undefined && requestedPreset !== 'business') throw new Error('only the managed business preset is allowed')
  if (runtime.managedWorkspaceId.length === 0) throw new Error('managed workspace is not ready')
  return Buffer.from(JSON.stringify({
    ...parsed,
    payload: {
      ...(typeof parsed.payload.sessionId === 'string' ? { sessionId: parsed.payload.sessionId } : {}),
      workspaceId: runtime.managedWorkspaceId,
      agentPreset: 'business',
    },
  }))
}
