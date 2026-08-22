/**
 * Filesystem layout and provisioning for one isolated DSH Runtime.
 *
 * Everything here is deterministic preparation: computing the per-Subject
 * directory layout, materializing the managed profile and Agent Preset, and
 * assembling the child process environment. Process lifecycle stays in
 * `runtime-manager.ts`.
 */
import { chmod, copyFile, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { AllowedModel, RuntimePrincipal } from './types.js'
import { tenantKey } from './runtime-identity.js'

/** Always applied: the policy overlay that locks down the managed Runtime. */
const PROFILE_PATCH_FILE = 'cordis.patch.yml'
/** Applied only until an administrator owns the profile: deployment model defaults. */
const MODEL_SEED_FILE = 'model-seed.patch.yml'
/** The profile root DSH writes a composed entry list into when config is saved. */
const PROFILE_ROOT_FILE = 'cordis.yml'
const TENANT_SETTINGS_FILE = 'settings.yaml'
const TENANT_CREDENTIALS_FILE = '.credentials.yaml'

/**
 * Where one deployment keeps the parts a Runtime is assembled from.
 *
 * The three path overrides exist because this package is published on its own:
 * the defaults describe the reference deployment layout (`<projectRoot>/plugin`),
 * and a host application with a different tree names its own directories instead
 * of having to reproduce that one.
 */
export interface RuntimeLayoutOptions {
  readonly projectRoot: string
  readonly dshSourceRoot: string
  readonly runtimeRoot: string
  readonly tenantKey?: string
  /** Built `@dshserver/dsh-integration` package root. Default `<projectRoot>/plugin`. */
  readonly pluginRoot?: string
  /** Built `@dshserver/dsh-preferences` package root. Default `<pluginRoot>/preferences`. */
  readonly preferencesRoot?: string
  /** Deployment-owned `agent-presets/` and `dsh-profile/`. Default `<pluginRoot>/config`. */
  readonly configRoot?: string
}

/** Every path one Runtime owns or links to, derived once from its stable key. */
export interface RuntimeLayout {
  readonly root: string
  readonly home: string
  readonly workspace: string
  readonly leaseFile: string
  readonly presetRoot: string
  readonly presetDir: string
  readonly profileDir: string
  readonly tenantConfigDir: string
  readonly settingsPath: string
  readonly credentialsPath: string
  readonly pluginRoot: string
  readonly preferencesRoot: string
  readonly configRoot: string
  readonly pluginLink: string
  readonly preferencesLink: string
  readonly cli: string
}

export function runtimeLayout(options: RuntimeLayoutOptions, key: string, principal: RuntimePrincipal): RuntimeLayout {
  const root = join(options.runtimeRoot, key)
  const home = join(root, 'home')
  const tenantConfigDir = join(options.runtimeRoot, '..', 'tenants', tenantKey(principal, options.tenantKey))
  const presetRoot = join(home, '.agent-presets')
  const pluginRoot = options.pluginRoot ?? join(options.projectRoot, 'plugin')
  const preferencesRoot = options.preferencesRoot ?? join(pluginRoot, 'preferences')
  return {
    root,
    home,
    workspace: join(root, 'workspace'),
    leaseFile: join(root, 'runtime-lease.jwt'),
    presetRoot,
    presetDir: join(presetRoot, 'business'),
    profileDir: join(home, 'profiles', 'web'),
    tenantConfigDir,
    settingsPath: join(tenantConfigDir, TENANT_SETTINGS_FILE),
    credentialsPath: join(tenantConfigDir, TENANT_CREDENTIALS_FILE),
    pluginRoot,
    preferencesRoot,
    configRoot: options.configRoot ?? join(pluginRoot, 'config'),
    pluginLink: join(home, 'profiles', 'node_modules', '@dshserver', 'dsh-integration'),
    preferencesLink: join(home, 'profiles', 'node_modules', '@dshserver', 'dsh-preferences'),
    cli: join(options.dshSourceRoot, 'apps', 'cli', 'lib', 'bin.js'),
  }
}

async function ensurePackageLink(path: string, target: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  try {
    if (await readlink(path) === target) return
    await rm(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EINVAL') throw error
    if ((error as NodeJS.ErrnoException).code === 'EINVAL') {
      throw new Error(`Runtime package link path exists and is not a symbolic link: ${path}`)
    }
  }
  await symlink(target, path, 'junction')
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return ''
  }
}

/**
 * True once DSH has written a composed entry list back to the profile root.
 *
 * The CLI creates `cordis.yml` as an empty list and only fills it when someone
 * saves a plugin configuration, so a non-empty list means an administrator now
 * owns those entries.
 */
export function profileHasPersistedEntries(content: string): boolean {
  const body = content.split('\n').filter(line => !/^\s*(?:#|$)/.test(line)).join('\n').trim()
  return body.length > 0 && body !== '[]'
}

/**
 * The policy overlay always applies; the model defaults are a first-run seed.
 *
 * Every patch entry is re-applied on each start and wins over the persisted
 * profile, so keeping the model entries here forever would silently revert
 * whatever an administrator saved in the native Models page. Policy entries are
 * meant to win that way; deployment model defaults are not.
 */
async function composeProfilePatch(
  layout: RuntimeLayout,
): Promise<{ readonly content: string; readonly seeded: boolean }> {
  const source = join(layout.configRoot, 'dsh-profile')
  const [policy, persisted] = await Promise.all([
    readFile(join(source, PROFILE_PATCH_FILE), 'utf8'),
    readOptional(join(layout.profileDir, PROFILE_ROOT_FILE)),
  ])
  if (profileHasPersistedEntries(persisted)) return { content: policy, seeded: false }
  const seed = await readFile(join(source, MODEL_SEED_FILE), 'utf8')
  return { content: `${policy.trimEnd()}\n\n${seed.trimStart()}`, seeded: true }
}

export interface ProvisionReport {
  /** False once the profile holds administrator-owned entries and the seed is skipped. */
  readonly seededModelDefaults: boolean
}

/** Materialize the managed home, preset, profile, and package links before spawn. */
export async function provisionRuntimeHome(
  layout: RuntimeLayout,
  key: string,
  role: string,
): Promise<ProvisionReport> {
  await Promise.all([
    mkdir(layout.workspace, { recursive: true }),
    mkdir(layout.presetDir, { recursive: true }),
    mkdir(layout.profileDir, { recursive: true }),
    mkdir(layout.tenantConfigDir, { recursive: true, mode: 0o700 }),
  ])
  await chmod(layout.tenantConfigDir, 0o700)

  const patch = await composeProfilePatch(layout)
  const presetSource = join(layout.configRoot, 'agent-presets', role)
  await Promise.all([
    copyFile(join(presetSource, 'agent.cordis.yml'), join(layout.presetDir, 'agent.cordis.yml')),
    copyFile(join(presetSource, 'preset.yml'), join(layout.presetDir, 'preset.yml')),
    writeFile(join(layout.profileDir, PROFILE_PATCH_FILE), patch.content),
    writeFile(join(layout.profileDir, 'package.json'), JSON.stringify({
      name: `dshserver-profile-${key}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, undefined, 2) + '\n'),
    writeFile(join(layout.profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'),
    ensurePackageLink(layout.pluginLink, layout.pluginRoot),
    ensurePackageLink(layout.preferencesLink, layout.preferencesRoot),
  ])
  return { seededModelDefaults: patch.seeded }
}

export interface TenantConfigReport {
  readonly key: string
  readonly directory: string
  /** True once this tenant directory holds administrator settings or credentials. */
  readonly configured: boolean
  /** Sibling tenant directories holding configuration this deployment no longer reads. */
  readonly orphans: readonly string[]
}

async function holdsTenantConfig(directory: string): Promise<boolean> {
  const present = await Promise.all([TENANT_SETTINGS_FILE, TENANT_CREDENTIALS_FILE].map(async file => {
    try {
      return (await stat(join(directory, file))).size > 0
    } catch {
      return false
    }
  }))
  return present.includes(true)
}

/**
 * Report which tenant directory this deployment reads and which ones it left behind.
 *
 * A derived tenant key silently changes with the OAuth issuer, so an operator who
 * moves the deployment to its real origin or IdP sees an empty configuration and no
 * explanation. The orphan list turns that into a visible, recoverable state.
 */
export async function inspectTenantConfig(layout: RuntimeLayout): Promise<TenantConfigReport> {
  const key = basename(layout.tenantConfigDir)
  const root = join(layout.tenantConfigDir, '..')
  const configured = await holdsTenantConfig(layout.tenantConfigDir)
  let siblings: string[] = []
  try {
    siblings = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name !== key)
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const orphans: string[] = []
  for (const name of siblings.sort()) {
    if (await holdsTenantConfig(join(root, name))) orphans.push(name)
  }
  return { key, directory: layout.tenantConfigDir, configured, orphans }
}

/** Fail fast before spawn when the CLI or plugin builds are missing. */
export async function assertBuiltArtifacts(layout: RuntimeLayout): Promise<void> {
  await Promise.all([
    readFile(layout.cli),
    readFile(join(layout.pluginRoot, 'dist', 'index.js')),
    readFile(join(layout.preferencesRoot, 'dist', 'index.js')),
    readFile(join(layout.preferencesRoot, 'dist', 'client.js')),
  ])
}

export interface RuntimeEnvironmentInputs {
  readonly layout: RuntimeLayout
  readonly principal: RuntimePrincipal
  readonly defaultModel: AllowedModel
  readonly internalOrigin: string
}

/** The complete child environment; identity-derived values only, never model input. */
export function runtimeEnvironment(inputs: RuntimeEnvironmentInputs): NodeJS.ProcessEnv {
  const { layout, principal, defaultModel } = inputs
  return {
    ...process.env,
    DSH_HOME: layout.home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'read-only',
    DSHSERVER_PRESET_ROOT: layout.presetRoot,
    DSHSERVER_RUNTIME_LEASE_FILE: layout.leaseFile,
    DSHSERVER_INTERNAL_ORIGIN: inputs.internalOrigin,
    DSHSERVER_SCOPES: principal.scopes.join(' '),
    DSHSERVER_SETTINGS_ENABLED: principal.canConfigureDsh ? '1' : '0',
    DSHSERVER_SETTINGS_PATH: layout.settingsPath,
    DSHSERVER_CREDENTIALS_PATH: layout.credentialsPath,
    DSHSERVER_EXPOSED_TOOLS: JSON.stringify(principal.tools),
    DSHSERVER_WORKSPACE_ROOT: layout.workspace,
    DSHSERVER_MODEL_PROVIDER: defaultModel.provider,
    DSHSERVER_MODEL_ID: defaultModel.model,
    DSHSERVER_MODEL_NAME: defaultModel.name ?? defaultModel.model,
    DSHSERVER_MODEL_API_KEY_ENV: defaultModel.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    DSHSERVER_MODEL_BASE_URL: defaultModel.baseURL ?? '',
  }
}
