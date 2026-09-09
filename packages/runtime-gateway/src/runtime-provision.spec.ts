import { describe, expect, it } from 'vitest'

import { runtimeEnvironment, runtimeLayout } from './runtime-provision.js'
import type { RuntimePrincipal } from './types.js'

const principal: RuntimePrincipal = {
  issuer: 'https://iam.example.com', tenantId: 'acme', subject: 'user-1', teamId: 'sales',
  clientId: 'business-web', name: 'User One', role: 'employee', expiresAt: 1_900_000_000, tokenId: 'token-1',
  scopes: ['assistant:use', 'customers:read:self'], presetRole: 'employee', tools: ['business_list_customers'],
  models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], policyRevision: 1, canConfigureDsh: false,
}

const options = {
  projectRoot: '/srv/dshserver',
  dshSourceRoot: '/srv/deepseek-harness',
  runtimeRoot: '/srv/dshserver/.runtime/users',
}

describe('runtime provisioning layout', () => {
  it('keeps per-subject state under the runtime key and tenant state under the tenant key', () => {
    const layout = runtimeLayout(options, 'subject-key', principal)
    expect(layout.home).toBe('/srv/dshserver/.runtime/users/subject-key/home')
    expect(layout.workspace).toBe('/srv/dshserver/.runtime/users/subject-key/workspace')
    expect(layout.leaseFile).toBe('/srv/dshserver/.runtime/users/subject-key/runtime-lease.jwt')
    expect(layout.settingsPath).toContain('/.runtime/tenants/')
    expect(layout.settingsPath).not.toContain('subject-key')
    expect(layout.cli).toBe('/srv/deepseek-harness/apps/cli/lib/bin.js')
  })

  /**
   * 这条守的是安全边界与 DSH 0.1.5 新写入需求的交点，两边都无声。
   *
   * 租户目录对普通用户是只读挂载（见 backend-container 的 Binds），而 0.1.5 起
   * `dsh-client-connection` 装载时无条件 `credentials.modifyRecord` 生成浏览器鉴权
   * 密钥——`modifyRecord` 先加锁再判断，所以哪怕不需要写，创建锁文件就会 EROFS，
   * 整棵插件树起不来。把凭据路径退回租户目录，普通用户的 Runtime 一个都起不来；
   * 反过来把租户目录改成可写，边界就没了。两种都不会有编译或类型错误。
   */
  it('gives an ordinary user a writable credentials path, and the admin the tenant-shared one', () => {
    const user = runtimeLayout(options, 'subject-key', principal)
    expect(user.credentialsPath).toBe('/srv/dshserver/.runtime/users/subject-key/home/.credentials.yaml')
    expect(user.credentialsPath).not.toContain('/tenants/')

    const admin = runtimeLayout(options, 'subject-key', { ...principal, canConfigureDsh: true })
    expect(admin.credentialsPath).toContain('/.runtime/tenants/')
    expect(admin.credentialsPath).not.toContain('subject-key')

    // settings 不跟着走：它对普通用户必须保持在只读的租户目录里。
    expect(user.settingsPath).toContain('/.runtime/tenants/')
    expect(user.settingsPath).toBe(admin.settingsPath)
  })

  it('defaults the plugin, preferences and config roots to the reference deployment layout', () => {
    const layout = runtimeLayout(options, 'subject-key', principal)
    expect(layout.pluginRoot).toBe('/srv/dshserver/plugin')
    expect(layout.preferencesRoot).toBe('/srv/dshserver/plugin/preferences')
    expect(layout.configRoot).toBe('/srv/dshserver/plugin/config')
  })

  it('lets a host application with another tree name those roots itself', () => {
    const layout = runtimeLayout({
      ...options,
      pluginRoot: '/opt/app/node_modules/@dshserver/dsh-integration',
      preferencesRoot: '/opt/app/node_modules/@dshserver/dsh-preferences',
      configRoot: '/opt/app/dsh-config',
    }, 'subject-key', principal)
    expect(layout.pluginRoot).toBe('/opt/app/node_modules/@dshserver/dsh-integration')
    expect(layout.preferencesRoot).toBe('/opt/app/node_modules/@dshserver/dsh-preferences')
    expect(layout.configRoot).toBe('/opt/app/dsh-config')
  })

  it('links this repository connector by default, at its scoped profile path', () => {
    const layout = runtimeLayout(options, 'subject-key', principal)
    expect(layout.plugins.map(plugin => plugin.packageName))
      .toEqual(['@dshserver/dsh-integration', '@dshserver/dsh-preferences'])
    expect(layout.plugins[0]!.link)
      .toBe('/srv/dshserver/.runtime/users/subject-key/home/profiles/node_modules/@dshserver/dsh-integration')
    expect(layout.plugins[0]!.artifacts).toEqual(['dist/index.js'])
    // The preferences plugin has a browser half, so both bundles must exist.
    expect(layout.plugins[1]!.artifacts).toEqual(['dist/index.js', 'dist/client.js'])
  })

  it('lets a deployment ship its own plugins instead of this repository connector', () => {
    const layout = runtimeLayout({
      ...options,
      runtimePlugins: [{ packageName: '@acme/agent-tools', root: '/opt/acme/agent-tools' }],
    }, 'subject-key', principal)
    expect(layout.plugins).toHaveLength(1)
    expect(layout.plugins[0]!.root).toBe('/opt/acme/agent-tools')
    expect(layout.plugins[0]!.link)
      .toBe('/srv/dshserver/.runtime/users/subject-key/home/profiles/node_modules/@acme/agent-tools')
  })

  it('places an unscoped package at a single profile path segment', () => {
    const layout = runtimeLayout({
      ...options,
      runtimePlugins: [{ packageName: 'agent-tools', root: '/opt/agent-tools' }],
    }, 'subject-key', principal)
    expect(layout.plugins[0]!.link)
      .toBe('/srv/dshserver/.runtime/users/subject-key/home/profiles/node_modules/agent-tools')
  })

  it('derives the child environment from trusted identity', () => {
    const layout = runtimeLayout(options, 'subject-key', principal)
    const env = runtimeEnvironment({
      layout,
      principal,
      defaultModel: principal.models[0]!,
      internalOrigin: 'http://127.0.0.1:4173',
    })
    expect(env.DSH_HOME).toBe(layout.home)
    expect(env.DSHSERVER_SCOPES).toBe('assistant:use customers:read:self')
    expect(env.DSHSERVER_SETTINGS_ENABLED).toBe('0')
    expect(JSON.parse(env.DSHSERVER_EXPOSED_TOOLS!)).toEqual(['business_list_customers'])
  })

  it('gives the Runtime its own HOME so tenants never share a dotfile directory', () => {
    const layout = runtimeLayout(options, 'subject-key', principal)
    const env = runtimeEnvironment({
      layout, principal, defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
    })
    expect(env.HOME).toBe(layout.home)
    expect(env.HOME).not.toBe(process.env.HOME)
  })

  it('keeps the sandbox read-only unless a deployment asks for the wider grant', () => {
    const restricted = runtimeLayout(options, 'subject-key', principal)
    expect(runtimeEnvironment({
      layout: restricted, principal, defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
    }).DSH_PERMISSION_MODE).toBe('read-only')

    const writable = runtimeLayout({ ...options, permissionMode: 'workspace-write' }, 'subject-key', principal)
    expect(runtimeEnvironment({
      layout: writable, principal, defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
    }).DSH_PERMISSION_MODE).toBe('workspace-write')
  })

  it('does not hand the Gateway environment to the Runtime', () => {
    // The Runtime executes model-directed code, so anything in its environment is
    // readable by whoever can make it run a command. Blanket inheritance handed
    // every Runtime the Gateway's own secrets — including its lease signing key.
    process.env.GATEWAY_ONLY_SECRET = 'must-not-leak'
    try {
      const layout = runtimeLayout(options, 'subject-key', principal)
      const env = runtimeEnvironment({
        layout, principal, defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
      })
      expect(env.GATEWAY_ONLY_SECRET).toBeUndefined()
      // PATH still comes through, or the child cannot find python, git or node.
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      delete process.env.GATEWAY_ONLY_SECRET
    }
  })

  it('tells the Runtime which identity it is acting for', () => {
    // A plugin that talks to a multi-tenant backend has to scope its calls, and
    // a hosted configuration page embedded by one has to open at the right
    // working set rather than wherever the browser last left it.
    const layout = runtimeLayout(options, 'subject-key', principal)
    const env = runtimeEnvironment({
      layout, principal, defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
    })
    expect(env.DSHSERVER_TENANT_ID).toBe('acme')
    // One workspace per Subject: absent rather than empty, so a plugin can test
    // for presence instead of comparing against ''.
    expect('DSHSERVER_WORKSPACE_ID' in env).toBe(false)

    const scoped = { ...principal, workspaceId: 'site-a' }
    expect(runtimeEnvironment({
      layout: runtimeLayout(options, 'subject-key', scoped), principal: scoped,
      defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
    }).DSHSERVER_WORKSPACE_ID).toBe('site-a')
  })

  it('lets a deployment name the one secret the Runtime does need', () => {
    // A provider reads its key from the environment named by apiKeyEnv, so that
    // variable has to reach the child. extraEnv makes it a deliberate choice.
    const layout = runtimeLayout({ ...options, extraEnv: { ACME_API_KEY: 'sk-test' } }, 'subject-key', principal)
    const env = runtimeEnvironment({
      layout, principal, defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
    })
    expect(env.ACME_API_KEY).toBe('sk-test')
  })

  it('applies deployment environment over the derived values', () => {
    const layout = runtimeLayout({ ...options, extraEnv: { ACME_REGION: 'cn-north' } }, 'subject-key', principal)
    const env = runtimeEnvironment({
      layout, principal, defaultModel: principal.models[0]!, internalOrigin: 'http://127.0.0.1:4173',
    })
    expect(env.ACME_REGION).toBe('cn-north')
    expect(env.DSH_HOME).toBe(layout.home)
  })
})
