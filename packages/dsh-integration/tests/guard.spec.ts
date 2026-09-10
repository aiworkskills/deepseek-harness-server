import { describe, expect, it } from 'vitest'

import { compileGuard, externalToolProblem, type GuardConfig } from '../src/guard.js'

const noScopes = { grantedScopes: new Set<string>() }

function guard(config: GuardConfig) {
  const compiled = compileGuard(config)
  if (compiled === undefined) throw new Error('expected a compiled guard')
  return compiled
}

function decide(config: GuardConfig, name: string, args: unknown = {}, scopes: string[] = []): string | undefined {
  return externalToolProblem(guard(config), { name, arguments: args }, { grantedScopes: new Set(scopes) })
}

describe('guard configuration', () => {
  it('stays absent when the deployment configured no policy', () => {
    expect(compileGuard(undefined)).toBeUndefined()
  })

  it('refuses a policy that does not say what happens to unmatched tools', () => {
    expect(() => compileGuard({ default: 'permit' } as unknown as GuardConfig))
      .toThrow('guard.default must be')
  })

  it('names the offending rule when a command pattern cannot compile', () => {
    expect(() => compileGuard({
      default: 'allow',
      rules: [{ match: 'shell' }, { match: 'shell', allowCommands: ['^ok', '([unclosed'] }],
    })).toThrow('guard.rules[1].allowCommands[1]')
  })

  it('rejects an empty tool-name glob', () => {
    expect(() => compileGuard({ default: 'allow', rules: [{ match: '  ' }] }))
      .toThrow('guard.rules[0].match must not be empty')
  })
})

describe('default disposition', () => {
  const rules = [{ match: 'mcp__mf__*', requireScopes: ['assistant:use'] }]

  it('lets unmatched tools through when the deployment chose allow', () => {
    expect(decide({ default: 'allow', rules }, 'read_file')).toBeUndefined()
  })

  it('denies unmatched tools when the deployment chose deny', () => {
    expect(decide({ default: 'deny', rules }, 'read_file')).toBe('该工具未被部署方允许调用。')
  })

  it('uses the deployment wording for the default denial', () => {
    expect(decide({ default: 'deny', denyMessage: '本部署只开放查询工具。', rules }, 'shell'))
      .toBe('本部署只开放查询工具。')
  })
})

describe('tool-name matching', () => {
  const config: GuardConfig = { default: 'deny', rules: [{ match: 'mcp__mf__*' }] }

  it('matches an MCP namespace prefix', () => {
    expect(decide(config, 'mcp__mf__list_projects')).toBeUndefined()
  })

  it('does not let a lookalike server name through', () => {
    expect(decide(config, 'mcp__mfx__list_projects')).toBeDefined()
  })

  it('treats regular-expression characters in a glob as literals', () => {
    const dotted: GuardConfig = { default: 'deny', rules: [{ match: 'a.b' }] }
    expect(decide(dotted, 'a.b')).toBeUndefined()
    expect(decide(dotted, 'axb')).toBeDefined()
  })

  it('accepts several globs on one rule', () => {
    const many: GuardConfig = { default: 'deny', rules: [{ match: ['read_file', 'glob', 'grep'] }] }
    expect(decide(many, 'grep')).toBeUndefined()
    expect(decide(many, 'write_file')).toBeDefined()
  })
})

describe('scope requirements', () => {
  const config: GuardConfig = {
    default: 'allow',
    rules: [{ match: 'mcp__mf__*', requireScopes: ['assistant:use', 'mf:read:tenant'] }],
  }

  it('allows the call once every scope is granted', () => {
    expect(decide(config, 'mcp__mf__list_projects', {}, ['assistant:use', 'mf:read:tenant'])).toBeUndefined()
  })

  it('names the missing scopes so the model can explain the refusal', () => {
    expect(decide(config, 'mcp__mf__list_projects', {}, ['assistant:use'])).toContain('mf:read:tenant')
  })
})

describe('command allowlists', () => {
  const config: GuardConfig = {
    default: 'allow',
    rules: [{
      match: ['shell', 'subprocess'],
      allowCommands: ['^node /opt/skills/docx/scripts/generate-docx\\.mjs\\s'],
      deny: '该命令未被部署方允许，可用的只有文档生成脚本。',
    }],
  }

  it('permits the one command the deployment named', () => {
    const command = 'node /opt/skills/docx/scripts/generate-docx.mjs report.docx spec.json'
    expect(decide(config, 'shell', { command })).toBeUndefined()
  })

  it('refuses reading the runtime lease off disk', () => {
    expect(decide(config, 'shell', { command: 'cat /run/dsh/lease.jwt' })).toBe(config.rules![0].deny)
  })

  it('refuses reaching the business API directly', () => {
    expect(decide(config, 'shell', { command: 'curl -X POST http://api.internal/oauth/exchange' }))
      .toBe(config.rules![0].deny)
  })

  it('denies when the command argument is missing, rather than allowing an unchecked call', () => {
    expect(decide(config, 'shell', { cmd: 'node /opt/skills/docx/scripts/generate-docx.mjs a b' }))
      .toBe(config.rules![0].deny)
  })

  it('reads the command from the field the deployment named', () => {
    const renamed: GuardConfig = {
      default: 'allow',
      rules: [{ match: 'shell', commandField: 'cmd', allowCommands: ['^ls\\b'] }],
    }
    expect(decide(renamed, 'shell', { cmd: 'ls -la' })).toBeUndefined()
    expect(decide(renamed, 'shell', { cmd: 'rm -rf /' })).toBeDefined()
  })
})

describe('argument constraints', () => {
  const config: GuardConfig = {
    default: 'allow',
    rules: [{ match: 'mcp__mf__*', arguments: { size: { max: 50 }, tenantId: { forbidden: true } } }],
  }

  it('allows a page size within the deployment ceiling', () => {
    expect(decide(config, 'mcp__mf__list_projects', { size: 20 })).toBeUndefined()
  })

  it('stops a page size the deployment did not agree to serve', () => {
    expect(decide(config, 'mcp__mf__list_projects', { size: 9999 })).toContain('最大 50')
  })

  it('applies the ceiling to a numeric string as well', () => {
    expect(decide(config, 'mcp__mf__list_projects', { size: '9999' })).toContain('最大 50')
  })

  it('denies a bounded argument that cannot be compared at all', () => {
    expect(decide(config, 'mcp__mf__list_projects', { size: 'all' })).toContain('必须是数字')
  })

  it('keeps the model from naming the tenant it wants to read', () => {
    expect(decide(config, 'mcp__mf__list_projects', { tenantId: 42 })).toContain('不允许由调用方指定')
  })

  it('ignores a forbidden argument that was not passed', () => {
    expect(decide(config, 'mcp__mf__list_projects', {})).toBeUndefined()
  })

  it('enforces a value pattern', () => {
    const dated: GuardConfig = {
      default: 'allow',
      rules: [{ match: 'report', arguments: { month: { pattern: '^\\d{4}-\\d{2}$' } } }],
    }
    expect(decide(dated, 'report', { month: '2026-08' })).toBeUndefined()
    expect(decide(dated, 'report', { month: 'last august' })).toContain('取值不被允许')
  })
})

describe('composition', () => {
  it('cannot be talked out of a denial by a later permissive rule', () => {
    const config: GuardConfig = {
      default: 'allow',
      rules: [
        { match: 'shell', allowCommands: ['^node\\b'] },
        { match: '*' },
      ],
    }
    expect(decide(config, 'shell', { command: 'rm -rf /' })).toBeDefined()
  })

  it('requires every matching rule to pass', () => {
    const config: GuardConfig = {
      default: 'allow',
      rules: [
        { match: '*', requireScopes: ['assistant:use'] },
        { match: 'mcp__mf__*', arguments: { size: { max: 50 } } },
      ],
    }
    expect(decide(config, 'mcp__mf__list_projects', { size: 10 }, ['assistant:use'])).toBeUndefined()
    expect(decide(config, 'mcp__mf__list_projects', { size: 10 }, [])).toContain('assistant:use')
    expect(decide(config, 'mcp__mf__list_projects', { size: 99 }, ['assistant:use'])).toContain('最大 50')
  })
})
