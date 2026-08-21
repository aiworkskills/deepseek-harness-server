import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

/** Claims the Runtime Manager places in a short-lived, signed execution lease. */
export interface RuntimeLeaseClaims {
  readonly sub: string
  readonly tenant: string
  readonly scope: string
  readonly exp: number
  readonly runtime_id: string
}

function decodePayload(token: string): unknown {
  const part = token.trim().split('.')[1]
  if (part === undefined || part.length === 0) throw new Error('runtime lease is not a JWT')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

/** Decode claims only for local policy hints; the Token Broker performs cryptographic verification. */
export function decodeLeaseClaims(token: string): RuntimeLeaseClaims {
  const value = decodePayload(token)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runtime lease payload is not an object')
  }
  const claims = value as Record<string, unknown>
  if (typeof claims.sub !== 'string' || typeof claims.tenant !== 'string'
    || typeof claims.scope !== 'string' || typeof claims.exp !== 'number'
    || typeof claims.runtime_id !== 'string') {
    throw new Error('runtime lease is missing required claims')
  }
  return {
    sub: claims.sub,
    tenant: claims.tenant,
    scope: claims.scope,
    exp: claims.exp,
    runtime_id: claims.runtime_id,
  }
}

/** Read the current lease for a downstream token exchange. */
export async function readRuntimeLease(path: string): Promise<string> {
  const token = (await readFile(path, 'utf8')).trim()
  if (token.length === 0) throw new Error('runtime lease file is empty')
  return token
}

/** Check the locally protected lease before a tool leaves the Harness process. */
export function activeLeaseProblem(path: string, now = Date.now()): string | undefined {
  try {
    const token = readFileSync(path, 'utf8').trim()
    const claims = decodeLeaseClaims(token)
    if (claims.exp * 1000 <= now) return '当前登录授权已过期，请刷新业务系统页面后重试。'
    return undefined
  } catch {
    return '当前运行环境没有有效的用户执行授权。'
  }
}
