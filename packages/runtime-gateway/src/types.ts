export interface GatewayPrincipal {
  readonly issuer: string
  readonly subject: string
  readonly clientId: string
  readonly name: string
  readonly role: string
  readonly tenantId: string
  readonly teamId: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly tokenId: string
}

export interface RuntimePrincipal<Role extends string = string, Tool extends string = string> extends GatewayPrincipal {
  readonly presetRole: Role
  readonly tools: readonly Tool[]
  readonly models: readonly AllowedModel[]
  readonly policyRevision: number
  readonly canConfigureDsh: boolean
}

export interface AllowedModel {
  readonly provider: string
  readonly model: string
  readonly name?: string
  readonly apiKeyEnv?: string
  readonly baseURL?: string
}

export interface RuntimeLeaseIssuer {
  issueRuntimeLease(principal: GatewayPrincipal, runtimeId: string): Promise<string>
}
