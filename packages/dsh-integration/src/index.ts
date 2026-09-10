/** OAuth-scoped business connector for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'

import { BusinessApiClient } from './business-client.js'
import { Config, resolveConfig } from './config.js'
import { connectorSettings } from './connector-settings.js'
import { CUSTOMER_TOOLS } from './customer-tools.js'
import { DELIVERABLE_TOOL_NAME, registerDeliverableTool } from './deliverable-tool.js'
import { externalToolProblem } from './guard.js'
import { activeLeaseProblem } from './lease.js'
import { authorizationProblem, BUSINESS_TOOL_NAMES, type BusinessToolName } from './policy.js'

export const name = 'dshserver-integration'
export const inject = ['tools']

export { Config, BUSINESS_TOOL_NAMES }
export type { BusinessToolName, ReadScope } from './policy.js'
export type { ResolvedConfig } from './config.js'
export type { ConnectorSettings } from './connector-settings.js'
export type { ArgumentConstraint, CompiledGuard, GuardConfig, GuardRule } from './guard.js'
export type {
  BusinessRequest, BusinessRequestContext, BusinessToolDependencies, BusinessToolRegistration, BusinessToolSpec,
} from './catalog.js'
export { businessTool } from './catalog.js'

/** Register the deployment-selected tools and one final authorization guard. */
export function apply(ctx: Context, input: Config): void {
  const deployment = resolveConfig(input)
  const settings = () => connectorSettings(ctx, deployment.settings)
  const exposed = new Set<BusinessToolName>(deployment.exposedTools)
  const grantedScopes = new Set(deployment.scopes)
  const client = new BusinessApiClient({
    brokerUrl: deployment.brokerUrl,
    tokenEndpointPath: deployment.tokenEndpointPath,
    businessApiUrl: deployment.businessApiUrl,
    businessApiAudience: deployment.businessApiAudience,
    runtimeLeaseFile: deployment.runtimeLeaseFile,
    timeoutMs: () => settings().requestTimeoutMs,
  })

  ctx.tools.guard((execution) => {
    const toolName = execution.name as BusinessToolName
    // Tools registered here carry their own scope table. Everything else the
    // preset loaded — MCP servers, shell, filesystem, skills — is governed only
    // if the deployment wrote rules for it. Without this branch the guard has
    // nothing to say about the tools most deployments actually extend with.
    if (!exposed.has(toolName)) {
      // `attach_deliverable` is this plugin's own infrastructure: it reaches no
      // business API and carries no scope, so the deployment's external-tool
      // rules — written to govern MCP servers, shells and file tools — have
      // nothing to decide about it. Routing it through them would let a
      // `default: deny` policy silently break the deliverable flow.
      if (execution.name === DELIVERABLE_TOOL_NAME) return undefined
      return deployment.guard === undefined
        ? undefined
        : externalToolProblem(deployment.guard, execution, { grantedScopes })
    }
    return authorizationProblem(toolName, {
      readScope: deployment.readScope,
      grantedScopes,
      writeOperationsEnabled: settings().writeOperationsEnabled,
    }) ?? activeLeaseProblem(deployment.runtimeLeaseFile)
  })

  const dependencies = { client, deployment, settings }
  for (const tool of CUSTOMER_TOOLS) {
    if (exposed.has(tool.name)) tool.register(ctx, dependencies)
  }

  // Not gated by `exposedTools`, and not in `BUSINESS_TOOL_NAMES`: that list and
  // the guard above are about *business authorization* — which CRM scopes a
  // caller holds. This tool reaches no business API and carries no scope. It
  // only names a file already inside the caller's own workspace, which the
  // session produced and can read anyway; the guard has nothing to decide.
  registerDeliverableTool(ctx)
}
