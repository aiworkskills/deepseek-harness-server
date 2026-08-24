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
 * How the Runtime's sandbox treats the filesystem, passed through to DSH.
 *
 * `read-only` suits an Agent that reaches business data through narrow tools and
 * has no reason to write anything; it stays the default because it is the weaker
 * grant. `workspace-write` suits an Agent whose job is to produce files — it may
 * write inside its own workspace and nowhere else. A deployment choosing the
 * wider grant should be confident the Runtime host is expendable, because
 * containment then rests on process and host isolation rather than on the Agent
 * being unable to act.
 */
export type RuntimePermissionMode = 'read-only' | 'workspace-write'

/**
 * A Cordis plugin package made resolvable inside the managed Runtime.
 *
 * A Runtime resolves plugins from its own profile directory, so a package is
 * usable only once it is linked there. Deployments name the packages they ship;
 * nothing about this is specific to the connector this repository publishes.
 */
export interface RuntimePluginPackage {
  /** Package name as the profile references it, e.g. `@scope/name`. */
  readonly packageName: string
  /** Built package root on disk. */
  readonly root: string
  /**
   * Files that must exist before spawn, relative to `root`. A missing artifact
   * then fails the start with a clear cause, rather than a Runtime that boots
   * and only afterwards cannot load its plugin. Default `['dist/index.js']`.
   */
  readonly artifacts?: readonly string[]
}

/** A plugin package together with the profile path it gets linked at. */
export interface ResolvedRuntimePlugin extends RuntimePluginPackage {
  readonly link: string
  readonly artifacts: readonly string[]
}

/**
 * Where one deployment keeps the parts a Runtime is assembled from.
 *
 * The path overrides exist because this package is published on its own: the
 * defaults describe the reference deployment layout (`<projectRoot>/plugin`),
 * and a host application with a different tree names its own directories
 * instead of having to reproduce that one.
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
  /**
   * Plugin packages linked into every Runtime profile. A value replaces the
   * default pair rather than adding to it: a deployment shipping its own Agent
   * has no reason to carry this repository's connector. Default:
   * `@dshserver/dsh-integration` and `@dshserver/dsh-preferences`, located by
   * `pluginRoot` and `preferencesRoot`.
   */
  readonly runtimePlugins?: readonly RuntimePluginPackage[]
  /** Filesystem grant for the Runtime sandbox. Default `read-only`. */
  readonly permissionMode?: RuntimePermissionMode
  /**
   * Extra environment for the Runtime child, applied over the values derived
   * here. Deployment-owned configuration only: every entry is visible to the
   * plugins running inside the Runtime, so it must never carry another tenant's
   * data or a secret the Agent is not meant to reach.
   */
  readonly extraEnv?: Readonly<Record<string, string>>
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
  /** Plugin packages linked into this Runtime's profile, in load order. */
  readonly plugins: readonly ResolvedRuntimePlugin[]
  readonly permissionMode: RuntimePermissionMode
  readonly extraEnv: Readonly<Record<string, string>>
  readonly cli: string
}

const DEFAULT_PLUGIN_ARTIFACTS = ['dist/index.js'] as const

export function runtimeLayout(options: RuntimeLayoutOptions, key: string, principal: RuntimePrincipal): RuntimeLayout {
  const root = join(options.runtimeRoot, key)
  const home = join(root, 'home')
  const tenantConfigDir = join(options.runtimeRoot, '..', 'tenants', tenantKey(principal, options.tenantKey))
  const presetRoot = join(home, '.agent-presets')
  const pluginRoot = options.pluginRoot ?? join(options.projectRoot, 'plugin')
  const preferencesRoot = options.preferencesRoot ?? join(pluginRoot, 'preferences')
  const declared: readonly RuntimePluginPackage[] = options.runtimePlugins ?? [
    { packageName: '@dshserver/dsh-integration', root: pluginRoot },
    // The preferences plugin also ships a browser bundle, and a Runtime whose
    // client half is missing renders a broken panel rather than failing to start.
    { packageName: '@dshserver/dsh-preferences', root: preferencesRoot, artifacts: ['dist/index.js', 'dist/client.js'] },
  ]
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
    plugins: declared.map(plugin => ({
      ...plugin,
      artifacts: plugin.artifacts ?? DEFAULT_PLUGIN_ARTIFACTS,
      // Scoped names contribute two path segments, unscoped one; `join` on the
      // split parts keeps both correct without special-casing the scope.
      link: join(home, 'profiles', 'node_modules', ...plugin.packageName.split('/')),
    })),
    permissionMode: options.permissionMode ?? 'read-only',
    extraEnv: options.extraEnv ?? {},
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
  // A Runtime's own tree carries that Subject's work and, for Agents that keep
  // credentials in the workspace, their secrets. Default `0755` published all of
  // it to every other process on the host.
  //
  // Be clear about what this does and does not buy: Runtimes share one uid, so
  // `0700` stops other accounts and anything running as a different user — not a
  // Runtime that deliberately reads a sibling's directory, since to the kernel it
  // *is* the owner. Real separation between Subjects needs a uid per Runtime or a
  // container per Runtime; this closes the accidental exposure, not the deliberate
  // one.
  await Promise.all([
    chmod(layout.root, 0o700),
    chmod(layout.tenantConfigDir, 0o700),
  ])

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
    ...layout.plugins.map(async plugin => { await ensurePackageLink(plugin.link, plugin.root) }),
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
    ...layout.plugins.flatMap(plugin =>
      plugin.artifacts.map(async artifact => { await readFile(join(plugin.root, artifact)) })),
  ])
}

export interface RuntimeEnvironmentInputs {
  readonly layout: RuntimeLayout
  readonly principal: RuntimePrincipal
  readonly defaultModel: AllowedModel
  readonly internalOrigin: string
}

/** The complete child environment; identity-derived values only, never model input. */
/**
 * Variables a child process needs from the host to run at all.
 *
 * Everything outside this list stays with the Gateway. The Runtime executes
 * model-directed code, so whatever is in its environment is readable by anyone
 * who can make it run a command — which for a filesystem-capable Agent is
 * everyone using it. Blanket-inheriting `process.env` therefore handed every
 * Runtime the Gateway's own secrets, including the key it signs Runtime Leases
 * with.
 *
 * Deployments that need something else in the child pass it through `extraEnv`,
 * which makes each such secret a deliberate decision rather than an accident of
 * however the Gateway happened to be started.
 */
const INHERITED_ENV = [
  'PATH',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'TZ',
  'LD_LIBRARY_PATH',
  // Corporate CA bundles; without these an intercepting TLS proxy breaks
  // every outbound call the Runtime makes.
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Egress proxies. A Runtime that cannot reach its model is useless, and the
  // proxy address is deployment topology rather than a secret.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
] as const

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {}
  for (const name of INHERITED_ENV) {
    const value = process.env[name]
    if (value !== undefined) inherited[name] = value
  }
  return inherited
}

export function runtimeEnvironment(inputs: RuntimeEnvironmentInputs): NodeJS.ProcessEnv {
  const { layout, principal, defaultModel } = inputs
  return {
    ...inheritedEnvironment(),
    DSH_HOME: layout.home,
    // Without this the child inherits the Gateway's HOME, and every Runtime on
    // the host shares one dotfile directory: `git config`, package caches and
    // any tool that falls back to `~` would read and write the same files
    // across tenants. Pointing it at the Runtime's own home keeps that
    // per-Subject like the rest of the layout.
    HOME: layout.home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: layout.permissionMode,
    DSHSERVER_PRESET_ROOT: layout.presetRoot,
    DSHSERVER_RUNTIME_LEASE_FILE: layout.leaseFile,
    DSHSERVER_INTERNAL_ORIGIN: inputs.internalOrigin,
    DSHSERVER_SCOPES: principal.scopes.join(' '),
    DSHSERVER_SETTINGS_ENABLED: principal.canConfigureDsh ? '1' : '0',
    DSHSERVER_SETTINGS_PATH: layout.settingsPath,
    DSHSERVER_CREDENTIALS_PATH: layout.credentialsPath,
    DSHSERVER_EXPOSED_TOOLS: JSON.stringify(principal.tools),
    DSHSERVER_WORKSPACE_ROOT: layout.workspace,
    // Who the Runtime is acting for. It already receives its workspace, its
    // scopes and its tool allowlist — everything except the identity all three
    // were derived from, which any plugin talking to a multi-tenant backend
    // needs: to scope a request, to label output, or to deep-link a hosted
    // configuration page at the right tenant instead of letting it roam.
    //
    // Neither value is a secret. They name the tenant and working set this
    // Runtime is already confined to, so knowing them grants nothing.
    DSHSERVER_TENANT_ID: principal.tenantId,
    ...(principal.workspaceId === undefined || principal.workspaceId.length === 0
      ? {}
      // Absent rather than empty when there is one workspace per Subject: a
      // plugin can then test for presence instead of comparing to ''.
      : { DSHSERVER_WORKSPACE_ID: principal.workspaceId }),
    DSHSERVER_MODEL_PROVIDER: defaultModel.provider,
    DSHSERVER_MODEL_ID: defaultModel.model,
    DSHSERVER_MODEL_NAME: defaultModel.name ?? defaultModel.model,
    DSHSERVER_MODEL_API_KEY_ENV: defaultModel.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    DSHSERVER_MODEL_BASE_URL: defaultModel.baseURL ?? '',
    // Last, so a deployment can correct a derived value it disagrees with —
    // and, by the same token, can break the Runtime with a bad override.
    //
    // This is also where model credentials belong: a provider reads its key
    // from the environment named by `apiKeyEnv`, so that one variable has to
    // reach the child. Naming it here keeps it the only secret that does.
    ...layout.extraEnv,
  }
}
