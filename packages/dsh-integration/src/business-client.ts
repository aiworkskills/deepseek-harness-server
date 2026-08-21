import { readRuntimeLease } from './lease.js'

interface TokenExchangeResponse {
  readonly access_token: string
  readonly token_type: 'Bearer'
}

export interface BusinessClientConfig {
  readonly brokerUrl: string
  readonly tokenEndpointPath: string
  readonly businessApiUrl: string
  readonly businessApiAudience: string
  readonly runtimeLeaseFile: string
  readonly timeoutMs: () => number
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid JSON object`)
  }
  return value as Record<string, unknown>
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`${label} returned non-JSON data (${response.status})`)
  }
  const record = objectRecord(body, label)
  if (!response.ok) {
    const message = typeof record.message === 'string' ? record.message : `${label} failed (${response.status})`
    throw new Error(message)
  }
  return record
}

/** Delegated OAuth client used by every protected business tool. */
export class BusinessApiClient {
  constructor(private readonly config: BusinessClientConfig) {}

  private async exchangeToken(scope: string, signal: AbortSignal): Promise<string> {
    const subjectToken = await readRuntimeLease(this.config.runtimeLeaseFile)
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource: this.config.businessApiAudience,
      scope,
    })
    const response = await fetch(new URL(this.config.tokenEndpointPath, this.config.brokerUrl), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal,
    })
    const value = await responseJson(response, 'Token Broker') as Partial<TokenExchangeResponse>
    if (typeof value.access_token !== 'string' || value.token_type !== 'Bearer') {
      throw new Error('Token Broker returned an invalid access token response')
    }
    return value.access_token
  }

  /** Exchange the current Runtime Lease and call the protected Resource Server. */
  async call(
    scope: string,
    path: string,
    init: RequestInit,
    callerSignal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs())
    const signal = AbortSignal.any([callerSignal, timeout])
    const accessToken = await this.exchangeToken(scope, signal)
    const response = await fetch(new URL(path, this.config.businessApiUrl), {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
        authorization: `Bearer ${accessToken}`,
      },
      signal,
    })
    return await responseJson(response, 'Business API')
  }
}
