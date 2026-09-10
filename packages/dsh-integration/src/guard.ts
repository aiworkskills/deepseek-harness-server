/**
 * Deployment policy for tools this plugin does not register.
 *
 * The business tools in `policy.ts` carry their own scope table. Everything
 * else a preset loads — MCP servers, shell, filesystem, skills — reaches the
 * model with no authorization layer at all, because a guard can only speak
 * about calls it recognizes. That gap is where a read-only deployment quietly
 * stops being read-only: a shell can read the runtime lease off disk, exchange
 * it for a business token and call any endpoint the delegating user may call,
 * none of it passing through a tool catalog.
 *
 * Rules compile once at plugin load. A malformed glob or regular expression
 * fails the deployment rather than silently matching nothing — the same failure
 * mode as an unparseable scope, and better loud at startup than absent at the
 * moment it was supposed to deny something.
 */

/** Bound on a single argument the model passes to a matched tool. */
export interface ArgumentConstraint {
  readonly max?: number
  readonly min?: number
  readonly pattern?: string
  readonly forbidden?: boolean
}

export interface GuardRule {
  /** Tool-name globs. `*` matches any run of characters; everything else is literal. */
  readonly match: string | string[]
  readonly requireScopes?: string[]
  /** Argument holding the command line for shell-like tools. */
  readonly commandField?: string
  /** Regular expressions; a command matching none of them is denied. */
  readonly allowCommands?: string[]
  readonly arguments?: Record<string, ArgumentConstraint>
  /** Model-facing denial reason that replaces the generated one. */
  readonly deny?: string
}

export interface GuardConfig {
  /** What happens to a tool no rule matches. Required — see `compileGuard`. */
  readonly default: 'allow' | 'deny'
  readonly rules?: GuardRule[]
  /** Reason returned when `default` is `deny` and nothing matched. */
  readonly denyMessage?: string
}

export interface GuardContext {
  readonly grantedScopes: ReadonlySet<string>
}

/** The subset of a tool execution a guard decision may rest on. */
export interface GuardedExecution {
  readonly name: string
  readonly arguments: unknown
}

/** An argument bound with its pattern already compiled, so the hot path never builds a RegExp. */
interface CompiledConstraint {
  readonly name: string
  readonly max: number | undefined
  readonly min: number | undefined
  readonly pattern: RegExp | undefined
  readonly forbidden: boolean
}

interface CompiledRule {
  readonly match: readonly RegExp[]
  readonly requireScopes: readonly string[]
  readonly commandField: string
  readonly allowCommands: readonly RegExp[]
  readonly argumentConstraints: readonly CompiledConstraint[]
  readonly deny: string | undefined
}

export interface CompiledGuard {
  readonly fallback: 'allow' | 'deny'
  readonly rules: readonly CompiledRule[]
  readonly denyMessage: string
}

const DEFAULT_COMMAND_FIELD = 'command'

const DEFAULT_DENY_MESSAGE = '该工具未被部署方允许调用。'

const REGEXP_METACHARACTERS = /[.+?^${}()|[\]\\]/g

/**
 * Translate a tool-name glob into an anchored pattern.
 *
 * Only `*` is a wildcard. Tool names carry `_` and `-` freely and MCP prefixes
 * them with `mcp__<server>__`, so treating the rest as literal keeps
 * `mcp__mf__*` meaning what it looks like.
 */
function globToRegExp(glob: string, field: string): RegExp {
  const normalized = glob.trim()
  if (normalized.length === 0) {
    throw new Error(`dshserver-integration: ${field} must not be empty`)
  }
  // Split on the wildcard first, then escape each literal segment. Escaping in
  // one pass would need a placeholder standing in for `*`, and a glob that
  // happened to contain that placeholder would become a wildcard nobody wrote.
  const pattern = normalized
    .split('*')
    .map(segment => segment.replace(REGEXP_METACHARACTERS, character => `\\${character}`))
    .join('.*')
  return new RegExp(`^${pattern}$`)
}

function compilePattern(pattern: string, field: string): RegExp {
  try {
    return new RegExp(pattern)
  } catch (error) {
    throw new Error(
      `dshserver-integration: ${field} contains an invalid regular expression `
      + `${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function compileConstraint(name: string, constraint: ArgumentConstraint, field: string): CompiledConstraint {
  return {
    name,
    max: constraint.max,
    min: constraint.min,
    pattern: constraint.pattern === undefined ? undefined : compilePattern(constraint.pattern, `${field}.pattern`),
    forbidden: constraint.forbidden === true,
  }
}

function compileRule(rule: GuardRule, index: number): CompiledRule {
  const at = `guard.rules[${index}]`
  const globs = Array.isArray(rule.match) ? rule.match : [rule.match]
  if (globs.length === 0) {
    throw new Error(`dshserver-integration: ${at}.match must name at least one tool`)
  }
  return {
    match: globs.map(glob => globToRegExp(glob, `${at}.match`)),
    requireScopes: [...new Set((rule.requireScopes ?? []).map(scope => scope.trim()).filter(Boolean))],
    commandField: rule.commandField?.trim() || DEFAULT_COMMAND_FIELD,
    allowCommands: (rule.allowCommands ?? [])
      .map((pattern, position) => compilePattern(pattern, `${at}.allowCommands[${position}]`)),
    argumentConstraints: Object.entries(rule.arguments ?? {})
      .map(([name, constraint]) => compileConstraint(name, constraint, `${at}.arguments.${name}`)),
    deny: rule.deny?.trim() || undefined,
  }
}

/**
 * Compile deployment rules, or `undefined` when the deployment configured none.
 *
 * `default` is required rather than defaulting to `allow`: a guard section that
 * silently permits everything is indistinguishable from having no guard, while
 * the deployment that wrote one believes authorization is in place. Making the
 * choice explicit costs one line and removes the only failure mode nobody
 * notices.
 */
export function compileGuard(config: GuardConfig | undefined): CompiledGuard | undefined {
  if (config === undefined) return undefined
  if (config.default !== 'allow' && config.default !== 'deny') {
    throw new Error('dshserver-integration: guard.default must be "allow" or "deny"')
  }
  return {
    fallback: config.default,
    rules: (config.rules ?? []).map(compileRule),
    denyMessage: config.denyMessage?.trim() || DEFAULT_DENY_MESSAGE,
  }
}

function argumentValue(args: unknown, name: string): unknown {
  if (typeof args !== 'object' || args === null) return undefined
  return (args as Record<string, unknown>)[name]
}

function constraintProblem(constraint: CompiledConstraint, value: unknown): string | undefined {
  if (constraint.forbidden) {
    return value === undefined ? undefined : `参数 ${constraint.name} 不允许由调用方指定。`
  }
  if (value === undefined || value === null) return undefined

  if (constraint.max !== undefined || constraint.min !== undefined) {
    const numeric = typeof value === 'number' ? value : Number(value)
    // A non-numeric value under a numeric bound is a denial, not a skip: the
    // deployment asked for a ceiling, and a value it cannot compare against is
    // a value it cannot vouch for.
    if (!Number.isFinite(numeric)) return `参数 ${constraint.name} 必须是数字。`
    if (constraint.max !== undefined && numeric > constraint.max) {
      return `参数 ${constraint.name} 超出允许范围，最大 ${constraint.max}。`
    }
    if (constraint.min !== undefined && numeric < constraint.min) {
      return `参数 ${constraint.name} 超出允许范围，最小 ${constraint.min}。`
    }
  }

  if (constraint.pattern !== undefined && !constraint.pattern.test(String(value))) {
    return `参数 ${constraint.name} 的取值不被允许。`
  }
  return undefined
}

function ruleProblem(rule: CompiledRule, execution: GuardedExecution, context: GuardContext): string | undefined {
  const missing = rule.requireScopes.filter(scope => !context.grantedScopes.has(scope))
  if (missing.length > 0) {
    return rule.deny ?? `当前 OAuth Scope 不允许调用 ${execution.name}（缺少 ${missing.join('、')}）。`
  }

  if (rule.allowCommands.length > 0) {
    const command = argumentValue(execution.arguments, rule.commandField)
    // Fail closed when the command cannot be read. A shell whose argument shape
    // differs from `commandField` would otherwise sail through an allowlist
    // that never looked at anything — the one outcome an allowlist must not have.
    if (typeof command !== 'string' || command.trim().length === 0) {
      return rule.deny ?? `无法读取 ${execution.name} 的命令内容，出于安全已拒绝执行。`
    }
    if (!rule.allowCommands.some(pattern => pattern.test(command))) {
      return rule.deny ?? '该命令未被部署方允许执行。'
    }
  }

  for (const constraint of rule.argumentConstraints) {
    const problem = constraintProblem(constraint, argumentValue(execution.arguments, constraint.name))
    if (problem !== undefined) return rule.deny ?? problem
  }
  return undefined
}

/**
 * Decide a call against deployment rules.
 *
 * Every matching rule runs and the first denial wins, so matching more rules
 * can only make a call less permitted. That mirrors the host contract: guards
 * have no allow result, and no ordering of rules can hand back permission
 * another rule withheld.
 */
export function externalToolProblem(
  guard: CompiledGuard,
  execution: GuardedExecution,
  context: GuardContext,
): string | undefined {
  const matched = guard.rules.filter(rule => rule.match.some(pattern => pattern.test(execution.name)))
  if (matched.length === 0) {
    return guard.fallback === 'deny' ? guard.denyMessage : undefined
  }
  for (const rule of matched) {
    const problem = ruleProblem(rule, execution, context)
    if (problem !== undefined) return problem
  }
  return undefined
}
