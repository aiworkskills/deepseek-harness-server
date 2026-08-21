/**
 * Tool-to-scope authorization policy.
 *
 * This table is the single source of truth for what a business tool needs:
 * the pre-execution guard and the OAuth Token Exchange both derive from it,
 * so an authorized call can never request a different scope than it checked.
 */

export const BUSINESS_TOOL_NAMES = [
  'business_list_customers',
  'business_get_customer',
  'business_customer_overview',
  'business_update_customer',
] as const

export type BusinessToolName = typeof BUSINESS_TOOL_NAMES[number]

/** Role-dependent read boundary granted by the business policy control plane. */
export type ReadScope = 'customers:read:self' | 'customers:read:team'

export interface ToolPolicyContext {
  readonly readScope: ReadScope
  readonly grantedScopes: ReadonlySet<string>
  readonly writeOperationsEnabled: boolean
}

interface ToolPolicy {
  readonly scopes: (readScope: ReadScope) => readonly string[]
  readonly mutating: boolean
}

const TOOL_POLICIES: Record<BusinessToolName, ToolPolicy> = {
  business_list_customers: { scopes: readScope => [readScope], mutating: false },
  business_get_customer: { scopes: readScope => [readScope], mutating: false },
  business_customer_overview: { scopes: () => ['customers:read:team', 'analytics:read'], mutating: false },
  business_update_customer: { scopes: () => ['customers:write:team'], mutating: true },
}

/** Every OAuth scope the tool needs, given the caller's read boundary. */
export function requiredScopes(name: BusinessToolName, readScope: ReadScope): readonly string[] {
  return TOOL_POLICIES[name].scopes(readScope)
}

/** The exact scope string a delegated Token Exchange must request for the tool. */
export function exchangeScope(name: BusinessToolName, readScope: ReadScope): string {
  return requiredScopes(name, readScope).join(' ')
}

/** Whether the tool causes a business-state mutation and falls under the write kill switch. */
export function isMutatingTool(name: BusinessToolName): boolean {
  return TOOL_POLICIES[name].mutating
}

/** Return a model-facing denial reason, or undefined when deployment policy allows execution. */
export function authorizationProblem(name: BusinessToolName, context: ToolPolicyContext): string | undefined {
  if (isMutatingTool(name) && !context.writeOperationsEnabled) {
    return `平台管理员已暂停写操作，当前不能调用 ${name}。`
  }
  const missing = requiredScopes(name, context.readScope).filter(scope => !context.grantedScopes.has(scope))
  return missing.length === 0 ? undefined : `当前 OAuth Scope 不允许调用 ${name}（缺少 ${missing.join('、')}）。`
}
