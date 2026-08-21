/**
 * Runnable contract smoke test for @dshserver/dsh-integration.
 *
 * It stands up a fake Token Broker and a fake business Resource Server on
 * loopback, writes a short-lived runtime lease, and drives the real plugin
 * entry point through a minimal stub of the two host services it injects
 * (`ctx.tools.register` and `ctx.tools.guard`). No DeepSeek Harness process,
 * no model credentials and no network egress are required.
 *
 * What it proves:
 *   1. an authorized read reaches the business API with an exchanged token;
 *   2. the pre-execution guard denies a tool whose scope was not granted;
 *   3. the tenant write kill switch denies a mutating tool;
 *   4. an expired runtime lease denies every exposed tool;
 *   5. a write carries an idempotency key and the configured reason floor.
 *
 * Run it with `pnpm example` from the repository root.
 */
import { createServer } from 'node:http'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '@dshserver/dsh-integration'

const TENANT = 'acme'
const SUBJECT = 'user-7'

/* ------------------------------------------------------------------ */
/* Fake runtime lease                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build an unsigned lease shaped like the one the Runtime Manager writes.
 * The plugin only decodes claims locally for a fast fail; the Token Broker is
 * what verifies the signature, so an unsigned token is enough here.
 */
function leaseToken(expiresAt) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'RS256', typ: 'JWT' })
  const payload = encode({
    sub: SUBJECT,
    tenant: TENANT,
    scope: 'assistant:use customers:read:team customers:write:team analytics:read',
    exp: Math.floor(expiresAt / 1000),
    runtime_id: 'runtime-local-smoke',
  })
  return `${header}.${payload}.signature-not-verified-locally`
}

/* ------------------------------------------------------------------ */
/* Fake Token Broker and business Resource Server                      */
/* ------------------------------------------------------------------ */

const audit = { exchanges: [], businessCalls: [] }

const CUSTOMERS = [
  {
    id: 'CUS-1001', company: '蓝湖科技', industry: '软件', contactName: '周敏', contactTitle: '采购经理',
    stage: '方案沟通', level: 'A', ownerName: '李强', teamName: '华东一组', expectedValue: 480000,
    nextFollowUp: '2026-09-02', lastContactAt: '2026-08-18', note: '关注部署周期。',
  },
  {
    id: 'CUS-1002', company: '远山制造', industry: '制造', contactName: '吴磊', contactTitle: 'CTO',
    stage: '商务谈判', level: 'A', ownerName: '李强', teamName: '华东一组', expectedValue: 760000,
    nextFollowUp: '2026-08-28', lastContactAt: '2026-08-20', note: '等待法务确认。',
  },
]

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(payload)
}

async function listen(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

/** Exchange a runtime lease for a down-scoped, short-lived business token. */
async function startBroker() {
  return await listen(async (request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/internal/oauth/token')) {
      return json(response, 404, { message: 'not found' })
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))

    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:token-exchange') {
      return json(response, 400, { message: 'unsupported grant_type' })
    }
    const subjectToken = form.get('subject_token') ?? ''
    let claims
    try {
      claims = JSON.parse(Buffer.from(subjectToken.split('.')[1], 'base64url').toString('utf8'))
    } catch {
      return json(response, 400, { message: 'malformed subject_token' })
    }
    if (claims.exp * 1000 <= Date.now()) return json(response, 400, { message: 'lease expired' })

    const requested = (form.get('scope') ?? '').split(' ').filter(Boolean)
    const held = new Set(claims.scope.split(' '))
    const missing = requested.filter(scope => !held.has(scope))
    if (missing.length > 0) {
      return json(response, 403, { message: `lease does not hold ${missing.join(', ')}` })
    }

    audit.exchanges.push({ subject: claims.sub, tenant: claims.tenant, scope: requested.join(' '), resource: form.get('resource') })
    const token = Buffer.from(JSON.stringify({
      sub: claims.sub, tenant: claims.tenant, scope: requested.join(' '),
      aud: form.get('resource'), exp: Math.floor(Date.now() / 1000) + 120,
    })).toString('base64url')
    return json(response, 200, { access_token: `header.${token}.sig`, token_type: 'Bearer', expires_in: 120 })
  })
}

/** Resource Server performing the final object-level authorization. */
async function startBusinessApi() {
  return await listen(async (request, response) => {
    const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    if (bearer.length === 0) return json(response, 401, { message: 'missing bearer token' })

    let token
    try {
      token = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString('utf8'))
    } catch {
      return json(response, 401, { message: 'malformed bearer token' })
    }
    const scopes = new Set(token.scope.split(' '))
    const url = new URL(request.url, 'http://business.invalid')
    audit.businessCalls.push({
      method: request.method,
      path: url.pathname,
      subject: token.sub,
      idempotencyKey: request.headers['idempotency-key'],
    })

    if (request.method === 'GET' && url.pathname === '/v1/customers') {
      const visibility = scopes.has('customers:read:team') ? 'team' : 'self'
      const stage = url.searchParams.get('stage')
      const items = CUSTOMERS.filter(record => stage === null || record.stage === stage)
      return json(response, 200, { visibility, total: items.length, items })
    }
    if (request.method === 'GET' && url.pathname === '/v1/analytics/team-overview') {
      if (!scopes.has('analytics:read')) return json(response, 403, { message: 'analytics:read required' })
      return json(response, 200, {
        teamName: '华东一组', total: CUSTOMERS.length,
        pipelineValue: CUSTOMERS.reduce((sum, record) => sum + record.expectedValue, 0),
        highValue: 2, followUpDue: 1,
        byStage: [{ stage: '方案沟通', count: 1 }, { stage: '商务谈判', count: 1 }],
      })
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/v1/customers/')) {
      if (!scopes.has('customers:write:team')) return json(response, 403, { message: 'customers:write:team required' })
      if (request.headers['idempotency-key'] === undefined) {
        return json(response, 400, { message: 'idempotency-key header is required for writes' })
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const id = decodeURIComponent(url.pathname.slice('/v1/customers/'.length))
      const record = CUSTOMERS.find(entry => entry.id === id)
      if (record === undefined) return json(response, 404, { message: `unknown customer ${id}` })
      record.stage = body.stage
      return json(response, 200, { changeId: `chg-${request.headers['idempotency-key']}`, record })
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/customers/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/customers/'.length))
      const record = CUSTOMERS.find(entry => entry.id === id)
      if (record === undefined) return json(response, 404, { message: `unknown customer ${id}` })
      return json(response, 200, { record })
    }
    return json(response, 404, { message: 'not found' })
  })
}

/* ------------------------------------------------------------------ */
/* Minimal host stub                                                   */
/* ------------------------------------------------------------------ */

/**
 * The smallest surface `apply()` injects: a tool registry, a guard chain and
 * `ctx.get('settings')`. Returning undefined for the settings provider makes
 * the connector fall back to its deployment-time values, which is exactly what
 * happens when the plugin runs without the host profile that owns the
 * `dshserver-integration` namespace.
 */
function createHostStub() {
  const tools = new Map()
  const guards = []
  const ctx = {
    get: () => undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      guard(guard) {
        guards.push(guard)
        return () => guards.splice(guards.indexOf(guard), 1)
      },
    },
  }

  /** Run the guard chain, then the tool body, the way the real registry does. */
  async function call(name, args) {
    const definition = tools.get(name)
    if (definition === undefined) return { outcome: 'unknown-tool', name }
    const execution = { name, args, callId: `call-${tools.size}-${name}` }
    for (const guard of guards) {
      const problem = await guard(execution)
      if (typeof problem === 'string') return { outcome: 'denied', reason: problem }
    }
    const exec = {
      ...execution,
      signal: AbortSignal.timeout(30_000),
      deferContext: () => {},
      concludeTurn: () => {},
    }
    try {
      return { outcome: 'ok', value: await definition.execute(args, exec) }
    } catch (error) {
      return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  return { ctx, call, toolNames: () => [...tools.keys()] }
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

let failures = 0

function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`  [${mark}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function main() {
  const broker = await startBroker()
  const businessApi = await startBusinessApi()
  const directory = await mkdtemp(join(tmpdir(), 'dshserver-smoke-'))

  const validLease = join(directory, 'runtime-lease.jwt')
  await writeFile(validLease, leaseToken(Date.now() + 5 * 60_000), 'utf8')
  await chmod(validLease, 0o600)

  const expiredLease = join(directory, 'expired-lease.jwt')
  await writeFile(expiredLease, leaseToken(Date.now() - 60_000), 'utf8')
  await chmod(expiredLease, 0o600)

  const baseConfig = {
    brokerUrl: broker.url,
    businessApiUrl: businessApi.url,
    runtimeLeaseFile: validLease,
    scopes: ['assistant:use', 'customers:read:team', 'customers:write:team', 'analytics:read'],
    exposedTools: [
      'business_list_customers', 'business_get_customer',
      'business_customer_overview', 'business_update_customer',
    ],
    readScope: 'customers:read:team',
  }

  try {
    /* 1. Team manager: every exposed tool is granted. */
    console.log('\n1. 团队管理者：读取、统计与写入')
    const manager = createHostStub()
    apply(manager.ctx, baseConfig)
    check('注册了 4 个业务工具', manager.toolNames().length === 4, manager.toolNames().join(', '))

    const list = await manager.call('business_list_customers', { stage: '商务谈判' })
    check('list_customers 返回团队可见数据', list.outcome === 'ok' && list.value.visibility === 'team' && list.value.total === 1,
      list.outcome === 'ok' ? `total=${list.value.total}` : list.reason)
    check('Token Exchange 请求了正确的 Scope',
      audit.exchanges.at(-1)?.scope === 'customers:read:team', audit.exchanges.at(-1)?.scope)

    const overview = await manager.call('business_customer_overview', {})
    check('customer_overview 需要并取得 analytics:read',
      overview.outcome === 'ok' && audit.exchanges.at(-1).scope === 'customers:read:team analytics:read',
      audit.exchanges.at(-1)?.scope)

    const write = await manager.call('business_update_customer', {
      customer_id: 'CUS-1001', stage: '商务谈判', reason: '客户确认预算已批复。',
    })
    check('update_customer 写入成功', write.outcome === 'ok', write.outcome === 'ok' ? write.value.changeId : write.reason)
    check('写请求携带幂等键', audit.businessCalls.at(-1)?.idempotencyKey !== undefined,
      audit.businessCalls.at(-1)?.idempotencyKey)

    const shortReason = await manager.call('business_update_customer', {
      customer_id: 'CUS-1001', stage: '已成交', reason: 'x',
    })
    check('过短的变更原因被拒绝', shortReason.outcome === 'failed', shortReason.reason)

    /* 2. Individual contributor: no team scopes, no write scope. */
    console.log('\n2. 普通员工：缺少团队与写 Scope')
    const employee = createHostStub()
    apply(employee.ctx, {
      ...baseConfig,
      scopes: ['assistant:use', 'customers:read:self'],
      readScope: 'customers:read:self',
    })
    const deniedOverview = await employee.call('business_customer_overview', {})
    check('缺少 Scope 的统计工具被守卫拒绝', deniedOverview.outcome === 'denied', deniedOverview.reason)
    const deniedWrite = await employee.call('business_update_customer', {
      customer_id: 'CUS-1001', stage: '已成交', reason: '越权尝试。',
    })
    check('缺少写 Scope 的写工具被守卫拒绝', deniedWrite.outcome === 'denied', deniedWrite.reason)

    /* 3. Tenant write kill switch. */
    console.log('\n3. 租户写操作总开关关闭')
    const readOnlyTenant = createHostStub()
    apply(readOnlyTenant.ctx, { ...baseConfig, writeOperationsEnabled: false })
    const killed = await readOnlyTenant.call('business_update_customer', {
      customer_id: 'CUS-1001', stage: '已成交', reason: '开关关闭时的尝试。',
    })
    check('写工具被租户开关拒绝', killed.outcome === 'denied', killed.reason)
    const stillReads = await readOnlyTenant.call('business_list_customers', {})
    check('只读工具不受影响', stillReads.outcome === 'ok')

    /* 4. Expired lease. */
    console.log('\n4. 执行租约过期')
    const expired = createHostStub()
    apply(expired.ctx, { ...baseConfig, runtimeLeaseFile: expiredLease })
    const staleRead = await expired.call('business_list_customers', {})
    check('过期租约下所有工具被拒绝', staleRead.outcome === 'denied', staleRead.reason)

    /* 5. Identity never comes from the model. */
    console.log('\n5. 身份来源')
    const subjects = new Set(audit.businessCalls.map(entry => entry.subject))
    check('业务 API 观察到的 Subject 始终来自租约', subjects.size === 1 && subjects.has(SUBJECT), [...subjects].join(', '))
  } finally {
    await broker.close()
    await businessApi.close()
  }

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}：${audit.exchanges.length} 次 Token Exchange，${audit.businessCalls.length} 次业务 API 调用。`)
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
