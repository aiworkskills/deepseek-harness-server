/**
 * Filesystem layout and provisioning for one isolated DSH Runtime.
 *
 * Everything here is deterministic preparation: computing the per-Subject
 * directory layout, materializing the managed profile and Agent Preset, and
 * assembling the child process environment. Process lifecycle stays in
 * `runtime-manager.ts`.
 */
import { chmod, copyFile, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AllowedModel, RuntimePrincipal } from './types.js'
import { tenantKey } from './runtime-identity.js'

export interface RuntimeLayoutOptions {
  readonly projectRoot: string
  readonly dshSourceRoot: string
  readonly runtimeRoot: string
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
  readonly pluginLink: string
  readonly preferencesLink: string
  readonly cli: string
}

export function runtimeLayout(options: RuntimeLayoutOptions, key: string, principal: RuntimePrincipal): RuntimeLayout {
  const root = join(options.runtimeRoot, key)
  const home = join(root, 'home')
  const tenantConfigDir = join(options.runtimeRoot, '..', 'tenants', tenantKey(principal))
  const presetRoot = join(home, '.agent-presets')
  const pluginRoot = join(options.projectRoot, 'plugin')
  const preferencesRoot = join(pluginRoot, 'preferences')
  return {
    root,
    home,
    workspace: join(root, 'workspace'),
    leaseFile: join(root, 'runtime-lease.jwt'),
    presetRoot,
    presetDir: join(presetRoot, 'business'),
    profileDir: join(home, 'profiles', 'web'),
    tenantConfigDir,
    settingsPath: join(tenantConfigDir, 'settings.yaml'),
    credentialsPath: join(tenantConfigDir, '.credentials.yaml'),
    pluginRoot,
    preferencesRoot,
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

/** Materialize the managed home, preset, profile, and package links before spawn. */
export async function provisionRuntimeHome(layout: RuntimeLayout, projectRoot: string, key: string, role: string): Promise<void> {
  await Promise.all([
    mkdir(layout.workspace, { recursive: true }),
    mkdir(layout.presetDir, { recursive: true }),
    mkdir(layout.profileDir, { recursive: true }),
    mkdir(layout.tenantConfigDir, { recursive: true, mode: 0o700 }),
  ])
  await chmod(layout.tenantConfigDir, 0o700)

  const presetSource = join(projectRoot, 'plugin', 'config', 'agent-presets', role)
  await Promise.all([
    copyFile(join(presetSource, 'agent.cordis.yml'), join(layout.presetDir, 'agent.cordis.yml')),
    copyFile(join(presetSource, 'preset.yml'), join(layout.presetDir, 'preset.yml')),
    copyFile(join(projectRoot, 'plugin', 'config', 'dsh-profile', 'cordis.patch.yml'), join(layout.profileDir, 'cordis.patch.yml')),
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
  readonly exposedSettingsNamespaces: readonly string[]
}

/** The complete child environment; identity-derived values only, never model input. */
export function runtimeEnvironment(inputs: RuntimeEnvironmentInputs): NodeJS.ProcessEnv {
  const { layout, principal, defaultModel } = inputs
  const namespaces = [...new Set(['dshserver-integration', ...inputs.exposedSettingsNamespaces])]
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
    DSHSERVER_EXPOSED_SETTINGS_NAMESPACES: JSON.stringify(namespaces),
    DSHSERVER_EXPOSED_TOOLS: JSON.stringify(principal.tools),
    DSHSERVER_WORKSPACE_ROOT: layout.workspace,
    DSHSERVER_MODEL_PROVIDER: defaultModel.provider,
    DSHSERVER_MODEL_ID: defaultModel.model,
    DSHSERVER_MODEL_NAME: defaultModel.name ?? defaultModel.model,
    DSHSERVER_MODEL_API_KEY_ENV: defaultModel.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    DSHSERVER_MODEL_BASE_URL: defaultModel.baseURL ?? '',
  }
}
