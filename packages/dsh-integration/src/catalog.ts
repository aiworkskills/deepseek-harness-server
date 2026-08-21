/**
 * Declarative business tool catalog.
 *
 * A catalog entry states what the model sees (name, description, schemas)
 * and how a validated call maps to one Resource Server request. Everything
 * a connector must never get wrong by hand — the exchange scope, the write
 * kill switch, idempotency keys, timeouts, result rendering — is wired here
 * once, from the same policy table the pre-execution guard uses.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type InferArgs, type InferValue, type ParameterSchemaSpec, type ToolCallView, type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

import type { BusinessApiClient } from './business-client.js'
import type { ResolvedConfig } from './config.js'
import type { ConnectorSettings } from './connector-settings.js'
import { exchangeScope, isMutatingTool, type BusinessToolName } from './policy.js'

/** One tool call must not outlive the administrator-configurable request budget. */
const TOOL_TIMEOUT_CEILING_MS = 120_000

export interface BusinessToolDependencies {
  readonly client: BusinessApiClient
  readonly deployment: ResolvedConfig
  readonly settings: () => ConnectorSettings
}

/** Trusted runtime context a request builder may read; never model-controlled. */
export interface BusinessRequestContext {
  readonly deployment: ResolvedConfig
  readonly settings: ConnectorSettings
}

/** One Resource Server call derived from validated model arguments. */
export interface BusinessRequest {
  readonly path: string
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly body?: Record<string, unknown>
}

export interface BusinessToolSpec<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: BusinessToolName
  readonly description: string
  readonly parameters: S
  readonly output: O
  presentCall(args: InferArgs<S>): ToolCallView | undefined
  /** Map validated arguments to one request; throw a model-facing message to refuse. */
  request(args: InferArgs<S>, context: BusinessRequestContext): BusinessRequest
}

export interface BusinessToolRegistration {
  readonly name: BusinessToolName
  register(ctx: Context, dependencies: BusinessToolDependencies): void
}

/**
 * Wire one catalog entry into a registry-ready DSH tool. The spec keeps full
 * argument inference at its authoring site; wiring below intentionally erases
 * the generics because `defineTool` re-validates every call at runtime.
 */
export function businessTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  spec: BusinessToolSpec<S, O>,
): BusinessToolRegistration {
  const mutating = isMutatingTool(spec.name)
  const presentCall = spec.presentCall.bind(spec) as (args: unknown) => ToolCallView | undefined
  const request = spec.request.bind(spec) as (args: unknown, context: BusinessRequestContext) => BusinessRequest
  return {
    name: spec.name,
    register(ctx, { client, deployment, settings }) {
      ctx.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters as ParameterSchemaSpec,
        output: {
          schema: spec.output as ValueSchemaSpec,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
        },
        timeoutMs: TOOL_TIMEOUT_CEILING_MS,
        isConcurrencySafe: () => !mutating,
        presentCall,
        async execute(args, exec) {
          const call = request(args, { deployment, settings: settings() })
          return await client.call(
            exchangeScope(spec.name, deployment.readScope),
            call.path,
            {
              ...(call.method === undefined ? {} : { method: call.method }),
              ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
              ...(mutating ? { headers: { 'idempotency-key': exec.callId } } : {}),
            },
            exec.signal,
          ) as never
        },
      }))
    },
  }
}
