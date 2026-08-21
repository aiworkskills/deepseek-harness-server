import { describe, expect, it } from 'vitest'
import { decodeLeaseClaims } from '../src/lease.js'

function token(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('runtime lease claims', () => {
  it('decodes the trusted runtime identity fields', () => {
    expect(decodeLeaseClaims(token({
      sub: 'employee-1',
      tenant: 'acme',
      scope: 'customers:read:self',
      exp: 1_900_000_000,
      runtime_id: 'runtime-1',
    }))).toEqual({
      sub: 'employee-1',
      tenant: 'acme',
      scope: 'customers:read:self',
      exp: 1_900_000_000,
      runtime_id: 'runtime-1',
    })
  })

  it('rejects identity-incomplete payloads', () => {
    expect(() => decodeLeaseClaims(token({ sub: 'employee-1' }))).toThrow('missing required claims')
  })
})
