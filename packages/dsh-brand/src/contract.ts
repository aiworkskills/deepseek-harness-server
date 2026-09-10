/**
 * What a deployment supplies to replace DSH's own brand.
 *
 * Every field is optional, and that is the design: a slot this plugin has
 * nothing to put in is a slot it does not take. Occupying one and rendering
 * nothing is not neutral — DSH renders `sidebar.brand.mark` inside the collapse
 * toggle as its resting state, so an empty occupant leaves a control that is
 * invisible until hovered, and a registered occupant also suppresses the
 * fallback that would otherwise have drawn something. This plugin exists partly
 * because that mistake was made once already.
 */
export interface BrandConfig {
  /**
   * The wordmark, shown beside the mark in the expanded sidebar.
   *
   * Absent leaves DSH's own line — which on a non-official build reads
   * `DSH Local Build <sha>`, almost never what a deployment wants.
   */
  readonly name?: string
  /**
   * Inline SVG source for the mark, rendered as-is.
   *
   * Preferred over {@link markUrl} when the artwork is an SVG: an inline SVG
   * using `fill="currentColor"` follows the light/dark theme, which an `<img>`
   * cannot. The markup is injected without sanitizing, so this is **deployment
   * input, never user input** — it comes from the profile, which only an
   * operator writes.
   */
  readonly markSvg?: string
  /**
   * Image URL for the mark, used when {@link markSvg} is absent.
   *
   * Safe for artwork of any format, at the cost of theme-following: the browser
   * paints the file as given.
   */
  readonly markUrl?: string
  /** Accessible name for the mark. Defaults to {@link name} when that is set. */
  readonly markAlt?: string
  /** Replaces the blank-session headline. Absent leaves DSH's own. */
  readonly headline?: string
  /**
   * Take only the mark seat, leaving the wordmark and headline to another plugin.
   *
   * For deployments that are *both* embedded and want their own logo. The
   * embedding plugin owns the brand line (it renders a workspace switcher there)
   * and the hero headline, but it structurally cannot fill the mark seat — its
   * protocol carries text, not artwork — so the mark is the one seat left over.
   *
   * Set it, and supplying {@link name} or {@link headline} anyway is an error
   * rather than a silent no-op: those seats are already taken, and slots shadow
   * — the loser renders nothing and says nothing about it.
   */
  readonly markOnly?: boolean
  /**
   * Hide the workspace-actions container when it renders empty.
   *
   * **Temporary workaround, off by default.** A deployment that mounts no
   * directory picker (because the Gateway refuses `workspace.create`) makes DSH
   * hide its "add workspace" button — correct — but the flex container holding
   * it still reserves space, leaving a blank box in the collapsed rail. The rule
   * anchors on `data-slot` attributes rather than DSH's content-hashed class
   * names, which change between builds.
   *
   * Delete this, and the CSS it installs, once DSH collapses that container.
   */
  readonly hideEmptyWorkspaceActions?: boolean
}

/** Every key {@link BrandConfig} accepts, in declaration order. */
const STRING_KEYS = ['name', 'markSvg', 'markUrl', 'markAlt', 'headline'] as const
const BOOLEAN_KEYS = ['markOnly', 'hideEmptyWorkspaceActions'] as const

/**
 * Validate what a deployment wrote in its profile, throwing on the first problem.
 *
 * 刻意不用 schemastery 的 `z.object()` 做这件事：这个包以符号链接进 profile，
 * 身边没有自己的 `node_modules`，任何真实的运行时 import 都会让 Runtime 以
 * `ERR_MODULE_NOT_FOUND` 起不来。`dsh-embed-chrome` 正是这么挂过一次。
 * cordis 在插件没有 `Config` 模式时原样透传配置，所以校验用普通代码来做。
 * `tests/bundle.spec.ts` 盯着这条规矩。
 *
 * Unknown keys are rejected rather than ignored. A profile that says `markSVG`
 * would otherwise load clean and render nothing — the exact silent-empty outcome
 * this plugin's whole shape is built to avoid.
 * @param config - the raw value from the profile.
 * @throws Error naming the offending key.
 */
export function assertBrandConfig(config: BrandConfig): void {
  const record = config as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const known: readonly string[] = [...STRING_KEYS, ...BOOLEAN_KEYS]
    if (!known.includes(key)) {
      throw new Error(`dshserver-brand: unknown config key ${key}; expected one of ${known.join(', ')}`)
    }
  }
  for (const key of STRING_KEYS) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`dshserver-brand: ${key} must be a string, got ${typeof value}`)
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`dshserver-brand: ${key} must be a boolean, got ${typeof value}`)
    }
  }
  // Slots shadow: two occupants of one cell means the loser renders nothing and
  // reports nothing. Where we already know the seat is taken, say so at load
  // instead of letting registration order decide in silence.
  if (config.markOnly === true) {
    for (const key of ['name', 'headline'] as const) {
      if ((config[key] ?? '') !== '') {
        throw new Error(
          `dshserver-brand: ${key} cannot be set with markOnly — that seat belongs to the embedding plugin`,
        )
      }
    }
  }
}

/** True when the config carries artwork for the mark slot. */
export function hasMark(config: BrandConfig): boolean {
  return (config.markSvg ?? '') !== '' || (config.markUrl ?? '') !== ''
}

/** True when the config carries a wordmark for the name slot. */
export function hasName(config: BrandConfig): boolean {
  return config.markOnly !== true && (config.name ?? '') !== ''
}

/** True when the config carries a replacement blank-session headline. */
export function hasHeadline(config: BrandConfig): boolean {
  return config.markOnly !== true && (config.headline ?? '') !== ''
}

/**
 * The stylesheet for {@link BrandConfig.hideEmptyWorkspaceActions}.
 *
 * `:has()` over `data-slot`, because those attributes are DSH's public contract
 * while the class names beside them (`ELhcta_headerActions`) are content hashes
 * that change on every upstream build — a rule written against those would stop
 * matching silently.
 */
export const EMPTY_WORKSPACE_ACTIONS_CSS =
  '[data-slot="sidebar.workspaces"] div:has(> [data-slot="sidebar.workspaces.directoryFlow"])'
  + ' > div:first-child:empty { display: none; }'
