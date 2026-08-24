/**
 * One verified identity, as the host's IAM describes it.
 *
 * Four of these fields decide which Runtime a request reaches, and they are
 * easy to mistake for one another — `issuer` in particular names a system, not
 * a person:
 *
 *   issuer       The identity system that signed the token (JWT `iss`). It is
 *                part of the key so that moving to another IdP cannot collide
 *                with identities minted by the previous one — two IdPs will
 *                happily both call someone `1`.
 *   subject      Who the token speaks for (JWT `sub`). A person, usually; a
 *                service account is equally valid.
 *   tenantId     The organisation whose members share administrator-owned
 *                settings and credentials.
 *   workspaceId  Which of that identity's workspaces this is, when one identity
 *                has several. See the field's own note.
 */
export interface GatewayPrincipal {
  readonly issuer: string
  readonly subject: string
  readonly clientId: string
  readonly name: string
  readonly role: string
  readonly tenantId: string
  /**
   * A second axis under one identity: a project, a site, a managed account.
   *
   * Without it a Subject has exactly one Runtime and one workspace, which is
   * the common shape and stays the default — omit this and nothing changes,
   * including the derived key. Deployments where one person owns several
   * independent working sets need the extra axis, and overloading `tenantId`
   * for it costs them the organisation dimension they will eventually want.
   *
   * The value is opaque here. It reaches the Runtime as
   * `DSHSERVER_WORKSPACE_ID` so a plugin can tell a multi-tenant backend which
   * working set it is acting on.
   */
  readonly workspaceId?: string
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
