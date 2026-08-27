/**
 * 这个工具唯一的作用是让产出文件"算数"，而它和 DSH 的全部契约就是 `presentCall`
 * 返回的那个形状：`card: 'generic'` + `kind: 'edit'` + `locations`。
 *
 * 契约破了不会报错——文件只是安静地不再出现可点入口，而这正是当初要修的那个
 * 症状。所以这里钉的是形状本身，不是"函数没抛异常"。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { basename, confine, deliverableCallView, workspaceRoot } from '../src/deliverable-tool.js'

let root: string
let workspace: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deliverable-tool-'))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  await mkdir(join(workspace, 'out'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'out', 'report.docx'), 'PK-binary')
  await writeFile(join(outside, 'secret.txt'), 'tenant-owned-secret')
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('accumulator contract', () => {
  it('declares the call as an edit carrying the produced path', () => {
    // 这四个字段就是全部。DSH 的累加器读 card==='generic' && kind==='edit'，
    // 然后取 locations[].path；少任何一个，文件就不算产出。
    expect(deliverableCallView('out/报告.docx')).toEqual({
      card: 'generic',
      kind: 'edit',
      title: '产出文件 报告.docx',
      locations: [{ path: 'out/报告.docx' }],
    })
  })

  it('keeps the path verbatim in locations', () => {
    // locations 里的路径要和下游那条文件 URL 认的路径一字不差——basename 只进
    // 标题。把 basename 写进 locations 会让链接指向工作区根下一个不存在的文件。
    expect(deliverableCallView('a/b/c.pptx').locations).toEqual([{ path: 'a/b/c.pptx' }])
  })
})

describe('workspace confinement', () => {
  it('resolves a file inside the workspace', async () => {
    expect(await confine(workspace, 'out/report.docx')).toContain('report.docx')
  })

  it('refuses to climb out with ..', async () => {
    expect(await confine(workspace, '../outside/secret.txt')).toBeNull()
    expect(await confine(workspace, 'out/../../outside/secret.txt')).toBeNull()
  })

  it('refuses an absolute path', async () => {
    // 声明产物是模型给的参数，绝对路径没有任何正当用途——工作区相对路径才是
    // 下游那条 URL 认得的东西。
    expect(await confine(workspace, join(outside, 'secret.txt'))).toBeNull()
  })

  it('refuses a symlink pointing out of the workspace', async () => {
    await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.docx'))
    expect(await confine(workspace, 'escape.docx')).toBeNull()
  })

  it('refuses a NUL byte rather than handing it to the filesystem', async () => {
    expect(await confine(workspace, 'out/\0report.docx')).toBeNull()
  })

  it('returns null for a file that is not there', async () => {
    // execute 靠这个失败，而累加器丢弃失败的调用——所以"路径打错了"的结果是
    // 没有卡片，而不是一个点开 404 的卡片。
    expect(await confine(workspace, 'out/nope.docx')).toBeNull()
  })
})

describe('workspace root', () => {
  it('prefers the configured root and falls back to cwd', () => {
    const saved = process.env.DSHSERVER_WORKSPACE_ROOT
    try {
      process.env.DSHSERVER_WORKSPACE_ROOT = '/tmp/somewhere'
      expect(workspaceRoot()).toBe('/tmp/somewhere')
      // 空串要当成没设置：compose 的 `${VAR:-}` 送进来的就是空串，当成路径会
      // 让每一次声明都相对 `''` 解析。
      process.env.DSHSERVER_WORKSPACE_ROOT = ''
      expect(workspaceRoot()).toBe(process.cwd())
      delete process.env.DSHSERVER_WORKSPACE_ROOT
      expect(workspaceRoot()).toBe(process.cwd())
    } finally {
      if (saved === undefined) delete process.env.DSHSERVER_WORKSPACE_ROOT
      else process.env.DSHSERVER_WORKSPACE_ROOT = saved
    }
  })
})

describe('basename', () => {
  it('takes the trailing segment on both separators', () => {
    expect(basename('out/报告.docx')).toBe('报告.docx')
    expect(basename('out\\报告.docx')).toBe('报告.docx')
    expect(basename('报告.docx')).toBe('报告.docx')
  })
})
