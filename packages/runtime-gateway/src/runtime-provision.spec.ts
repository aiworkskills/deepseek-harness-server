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
})
