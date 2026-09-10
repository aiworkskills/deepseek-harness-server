/**
 * Host half: a placeholder that puts the browser brand plugin in the Web module
 * graph, and the gate that rejects a mistyped profile.
 *
 * The brand itself is entirely a browser concern — see `./client`. Validating
 * here rather than there is deliberate: a typo in the profile fails the Runtime
 * at load with the offending key named, instead of silently rendering nothing
 * in a sidebar nobody is looking at yet.
 */
// Type-only: this package is symlinked into a profile with no `node_modules`
// beside it, so it must import nothing at runtime. See `assertBrandConfig`.
import type { Context } from '@deepseek-ai/cordis'

import { assertBrandConfig, type BrandConfig } from './contract.js'

export {
  EMPTY_WORKSPACE_ACTIONS_CSS, assertBrandConfig, hasHeadline, hasMark, hasName, type BrandConfig,
} from './contract.js'

export const name = 'dshserver-brand'

/** @see BrandConfig — the schema lives there as plain types, for the reason in `assertBrandConfig`. */
export type Config = BrandConfig

export function apply(_ctx: Context, config: Config = {}): void {
  assertBrandConfig(config)
}
