/**
 * Upgrade-survival contract for administrator configuration.
 *
 * A customer configures models and credentials once; DSH upgrades, plugin
 * upgrades and idle recycles all re-provision the Runtime home afterwards.
 * These tests pin the boundary between what provisioning owns (preset, profile
 * policy) and what it must never touch (tenant settings, credentials, per-user
 * state), so a regression shows up here instead of at a customer site.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inspectTenantConfig, profileHasPersistedEntries, provisionRuntimeHome, runtimeLayout } from './runtime-provision.js'
import type { RuntimePrincipal } from './types.js'

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url))
/** This repository keeps the deployment assets at the root, not under `plugin/`. */
const configRoot = join(projectRoot, 'config')

const principal: RuntimePrincipal = {
  issuer: 'https://iam.example.com', tenantId: 'acme', subject: 'user-1', teamId: 'sales',
  clientId: 'business-web', name: 'User One', role: 'manager', expiresAt: 1_900_000_000, tokenId: 'token-1',
  scopes: ['assistant:use', 'assistant:platform:write'], presetRole: 'manager', tools: ['business_list_customers'],
  models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], policyRevision: 1, canConfigureDsh: true,
}

const SETTINGS = 'llm-pi-ai:\n  providers:\n    acme:\n      baseURL: https://models.acme.test/v1\nagent-default-model:\n  provider: acme\n  model: acme-large\n'
const CREDENTIALS = 'acme:\n  apiKey: tenant-owned-secret\n'
/** What DSH writes back to the profile root once an administrator saves plugin config. */
const PERSISTED_PROFILE = '- id: llm-deepseek\n  config:\n    models:\n      - id: administrator-choice\n'
const EMPTY_PROFILE = '# dsh profile root — an empty entry list.\n[]\n'

let runtimeRoot: string

beforeEach(async () => {
  runtimeRoot = join(await mkdtemp(join(tmpdir(), 'dshserver-persistence-')), 'users')
  await mkdir(runtimeRoot, { recursive: true })
})

afterEach(async () => {
  await rm(join(runtimeRoot, '..'), { recursive: true, force: true })
})

function layoutFor(overrides: Partial<RuntimePrincipal> = {}, tenantKey?: string) {
  const subject = { ...principal, ...overrides }
  const options = {
    projectRoot,
    dshSourceRoot: join(projectRoot, '..', 'deepseek-harness'),
    runtimeRoot,
    configRoot,
    ...(tenantKey === undefined ? {} : { tenantKey }),
  }
  return runtimeLayout(options, 'subject-key', subject)
}

describe('administrator configuration survives re-provisioning', () => {
  it('leaves tenant settings, credentials and per-user state untouched on restart', async () => {
    const layout = layoutFor()
    await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)
    await Promise.all([
      writeFile(layout.settingsPath, SETTINGS),
      writeFile(layout.credentialsPath, CREDENTIALS),
      writeFile(join(layout.profileDir, 'cordis.yml'), PERSISTED_PROFILE),
    ])
    const storage = join(layout.home, 'storages', 'workspace.json')
    await mkdir(join(layout.home, 'storages'), { recursive: true })
    await writeFile(storage, '{"workspaces":[]}')

    // A DSH or plugin upgrade re-provisions the same home before the next start.
    await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)

    expect(await readFile(layout.settingsPath, 'utf8')).toBe(SETTINGS)
    expect(await readFile(layout.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    expect(await readFile(join(layout.profileDir, 'cordis.yml'), 'utf8')).toBe(PERSISTED_PROFILE)
    expect(await readFile(storage, 'utf8')).toBe('{"workspaces":[]}')
  })

  it('restores the policy overlay when it was tampered with', async () => {
    const layout = layoutFor()
    await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)
    const patchPath = join(layout.profileDir, 'cordis.patch.yml')
    await writeFile(patchPath, '- id: sandbox-policy\n  disabled: true\n')

    await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)

    const patch = await readFile(patchPath, 'utf8')
    expect(patch).toContain('mode: read-only')
    expect(patch).not.toContain('disabled: true\n\n- id: sandbox-policy')
  })
})

describe('deployment model defaults are a first-run seed', () => {
  it('seeds the model entries while the profile has no persisted entries', async () => {
    const layout = layoutFor()
    const report = await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)
    expect(report.seededModelDefaults).toBe(true)
    const patch = await readFile(join(layout.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: agent-default-model')
    expect(patch).toContain('DSHSERVER_MODEL_ID')
  })

  it('stops seeding once an administrator owns the profile entries', async () => {
    const layout = layoutFor()
    await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)
    await writeFile(join(layout.profileDir, 'cordis.yml'), PERSISTED_PROFILE)

    const report = await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)

    expect(report.seededModelDefaults).toBe(false)
    const patch = await readFile(join(layout.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('DSHSERVER_MODEL_ID')
    // The provider stays enabled and the policy entries keep applying.
    expect(patch).toContain('id: llm-deepseek')
    expect(patch).toContain('mode: read-only')
  })

  it('keeps seeding while the profile root is the empty list DSH creates', async () => {
    const layout = layoutFor()
    await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)
    await writeFile(join(layout.profileDir, 'cordis.yml'), EMPTY_PROFILE)

    const report = await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)

    expect(report.seededModelDefaults).toBe(true)
  })

  it('reads an entry list through comments and blank lines', () => {
    expect(profileHasPersistedEntries('')).toBe(false)
    expect(profileHasPersistedEntries(EMPTY_PROFILE)).toBe(false)
    expect(profileHasPersistedEntries('\n\n# only comments\n')).toBe(false)
    expect(profileHasPersistedEntries(PERSISTED_PROFILE)).toBe(true)
  })
})

describe('pinned tenant key', () => {
  it('keeps one configuration directory across an origin and IdP change', () => {
    const before = layoutFor({}, 'acme-prod')
    const after = layoutFor({ issuer: 'https://login.acme.com/oauth', tenantId: 'acme-emea' }, 'acme-prod')
    expect(before.settingsPath).toBe(after.settingsPath)
    expect(before.settingsPath).toBe(join(runtimeRoot, '..', 'tenants', 'acme-prod', 'settings.yaml'))
  })

  it('moves the directory when the key is derived and the issuer changes', () => {
    const before = layoutFor()
    const after = layoutFor({ issuer: 'https://login.acme.com/oauth' })
    expect(before.settingsPath).not.toBe(after.settingsPath)
  })

  it('rejects keys that are not a single safe path segment', () => {
    expect(() => layoutFor({}, '../escape')).toThrow(/safe path segment/)
    expect(() => layoutFor({}, 'tenants/acme')).toThrow(/safe path segment/)
    expect(() => layoutFor({}, '.hidden')).toThrow(/safe path segment/)
  })
})

describe('orphaned tenant directories', () => {
  it('names the directories a changed identity left behind', async () => {
    const derived = layoutFor()
    await provisionRuntimeHome(derived, 'subject-key', principal.presetRole)
    await writeFile(derived.settingsPath, SETTINGS)

    const moved = layoutFor({ issuer: 'https://login.acme.com/oauth' })
    await provisionRuntimeHome(moved, 'subject-key', principal.presetRole)
    const report = await inspectTenantConfig(moved)

    expect(report.configured).toBe(false)
    expect(report.orphans).toEqual([basename(derived.tenantConfigDir)])
  })

  it('reports a configured tenant with no orphans once settings exist', async () => {
    const layout = layoutFor({}, 'acme-prod')
    await provisionRuntimeHome(layout, 'subject-key', principal.presetRole)
    await writeFile(layout.settingsPath, SETTINGS)

    const report = await inspectTenantConfig(layout)

    expect(report).toMatchObject({ key: 'acme-prod', configured: true, orphans: [] })
  })

  it('ignores an empty tenant directory left by a previous key', async () => {
    const derived = layoutFor()
    await provisionRuntimeHome(derived, 'subject-key', principal.presetRole)

    const moved = layoutFor({ issuer: 'https://login.acme.com/oauth' })
    await provisionRuntimeHome(moved, 'subject-key', principal.presetRole)

    expect((await inspectTenantConfig(moved)).orphans).toEqual([])
  })
})
