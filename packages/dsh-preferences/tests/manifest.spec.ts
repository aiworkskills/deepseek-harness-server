import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('DSH client manifest', () => {
  it('exports the browser bundle and package metadata used by client discovery', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    expect(manifest.exports['./client']).toBe('./dist/client.js')
    expect(manifest.exports['./package.json']).toBe('./package.json')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
  })
})
