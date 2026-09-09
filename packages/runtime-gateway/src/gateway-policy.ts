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
  return pathname === '/api/settings/describe'
    || pathname === '/api/settings/update'
    || pathname === '/api/settings/replace'
    || pathname === '/api/settings/mutate'
    || pathname.startsWith('/api/credentials/')
    || pathname === '/api/llm/discoverModels'
}

/**
 * RPC 路径必须跟着 DSH 的**形状和命名空间**走，两者都会在升级中变。
 *
 * 0.1.5 两样都变了。形状：端点从 `<ns>.<method>` 改成了 `<ns>/<method>`
 * （`api/gateway` 的 `endpointOf` 是 `${namespace}/${method}`，`claimsEndpoint`
 * 按 `/` 切分并要求恰好两段），所以任何点号写法在 0.1.5 上匹配的是一条**不存在的
 * 路径**——规则永远为真，请求永远不来，被锁的能力实际全部敞开。命名空间：原生
 * 「用本机程序打开路径」从 `host.openPath` 变成了 `session.openWorkspacePath`。
 *
 * 这两次都不会有任何报错，而旧测试断言的正是那些不存在的路径，所以全绿。因此每条都
 * 注上对应的服务，并且 `blocklist-shape.spec.ts` 会强制每条都长成 `/api/<ns>/`。
 */
const BLOCKED_RPC_PREFIXES = [
  // settings-controller，namespace 'settings'：打开配置文件落到宿主机桌面。
  '/api/settings/openDocument',
  // session-controller，namespace 'session'：`openWorkspacePath` 无条件调用原生
  // 打开器（`nativeOpen: false` 只影响能力探测 `canOpenWorkspacePath`，不影响它），
  // 所以边界只能在这里。session 命名空间其余方法是正常会话流量，不能整段拦。
  '/api/session/openWorkspacePath',
  '/api/session/canOpenWorkspacePath',
  // directory-picker，namespace 'directoryPicker'：0.1.1 时这些是 `host.*`。
  '/api/directoryPicker/',
  // cordis-inspect / dynamic-cordis-runner：任意插件装配与代码执行。
  '/api/cordisInspect/',
  '/api/dynamicCordisRunner/',
  // host plugin-inventory，namespace 'pluginInventory'。
  '/api/pluginInventory/',
  // permission-presets，namespace 'permissionPresets'。
  '/api/permissionPresets/',
  // workspace-controller，namespace 'workspace'：读取放行，结构变更拒绝。
  '/api/workspace/create',
  '/api/workspace/rename',
  '/api/workspace/delete',
  '/api/workspace/insertBefore',
  '/api/workspace/insertSessionBefore',
  // agent-presets，namespace 'agentPresets'（复数）。
  '/api/agentPresets/create',
  '/api/agentPresets/copy',
  '/api/agentPresets/remove',
  '/api/agentPresets/read',
  '/api/agentPresets/select',
] as const

/** 每条黑名单前缀必须长成的样子；形状回退到点号会被测试当场抓住。 */
export const BLOCKED_RPC_PREFIX_SHAPE = /^\/api\/[a-zA-Z][a-zA-Z0-9]*\/[a-zA-Z][a-zA-Z0-9]*$|^\/api\/[a-zA-Z][a-zA-Z0-9]*\/$/

/** @internal 供形状测试遍历。 */
export const blockedRpcPrefixes: readonly string[] = BLOCKED_RPC_PREFIXES

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
    payload?: { args?: Record<string, unknown> }
    [key: string]: unknown
  }
  // The request lives at `payload.args.request`, not at `payload`: DSH wraps
  // every Remote invocation's arguments in `args`, keyed by the method's own
  // parameter names, and `SessionController.create(request)` takes one called
  // `request`. Rewriting the old shape put `workspaceId` beside `args` instead
  // of inside it, which DSH refuses with "Remote payload must contain exactly
  // one plain-object args field" — and refusing there means the pinning below
  // never happened, so this must fail loudly rather than pass the body through.
  const args = parsed.payload?.args
  const request = args?.request
  if (parsed.method !== 'session/create' || typeof args !== 'object' || args === null
    || typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('invalid session/create RPC envelope')
  }
  const fields = request as Record<string, unknown>
  const requestedPreset = fields.agentPreset
  if (requestedPreset !== undefined && requestedPreset !== 'business') throw new Error('only the managed business preset is allowed')
  if (runtime.managedWorkspaceId.length === 0) throw new Error('managed workspace is not ready')
  return Buffer.from(JSON.stringify({
    ...parsed,
    payload: {
      // Exactly one key, and everything the caller asked for other than the two
      // fields this deployment owns is dropped — the same posture as before the
      // envelope changed.
      args: {
        request: {
          ...(typeof fields.sessionId === 'string' ? { sessionId: fields.sessionId } : {}),
          workspaceId: runtime.managedWorkspaceId,
          agentPreset: 'business',
        },
      },
    },
  }))
}
