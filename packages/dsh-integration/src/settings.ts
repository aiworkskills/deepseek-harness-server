import type { Context } from '@deepseek-ai/cordis'

import {
  ConnectorSettingsSchema, DEFAULT_CONNECTOR_SETTINGS, installConnectorSettings,
  type ConnectorSettings,
} from './connector-settings.js'

export const name = 'dshserver-integration-settings'
export const inject = ['settings']
export const Config = ConnectorSettingsSchema

/** Own the tenant settings namespace at Host lifetime, before any Agent Preset is mounted. */
export function apply(ctx: Context, input: ConnectorSettings = DEFAULT_CONNECTOR_SETTINGS): void {
  installConnectorSettings(ctx, input)
}
