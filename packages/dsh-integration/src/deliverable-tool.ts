/**
 * Announce a file the session produced, so it becomes clickable in the reply.
 *
 * DSH already turns produced files into chips and inline mentions. What counts
 * as "produced" is decided by render intent, not tool name: a diff card, or a
 * generic card whose `kind` is `edit`. That rule is deliberate and its own
 * comment says how to join it — *a new mutation tool joins by declaring what it
 * does*. This is that declaration.
 *
 * It exists because the rule, left alone, splits deliverables by how they
 * happened to be made. A model can type an HTML report out with an edit tool and
 * it gets a chip; the same report as `.docx` or `.pptx` gets none, because a
 * binary format can only come from running a script and a terminal card counts
 * for nothing. Same request, same session, one result clickable and the other
 * not — which reads as a broken feature, and there is no error anywhere to
 * suggest otherwise.
 *
 * So: no patching of DSH's accumulator, its chips, or its mention resolver. The
 * file enters through the door DSH left open, and every downstream surface —
 * chip, mention, follow-along — works because it was never bypassed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenericCallView, ToolCallView } from '@deepseek-ai/dsh-tools'

/** Name the skills call. Model-facing, so it says what it accomplishes. */
export const DELIVERABLE_TOOL_NAME = 'attach_deliverable'

/**
 * Where the session's files live.
 *
 * `DSHSERVER_WORKSPACE_ROOT` is what the connector's own sandbox policy is
 * configured from, so it is the same root every other part of this deployment
 * means by "the workspace". The `cwd` fallback covers a Runtime started without
 * it — a native checkout, mostly — rather than silently resolving against `/`.
 */
export function workspaceRoot(): string {
  const configured = process.env.DSHSERVER_WORKSPACE_ROOT?.trim()
  return configured === undefined || configured === '' ? process.cwd() : configured
}

/** Trailing path segment, for a title a person reads at a glance. */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * The real path of `path` inside `root`, or null when it is not inside.
 *
 * The same realpath comparison the deliverables route uses, and for the same
 * reason: the argument comes from the model, so `..` and a symlink pointing out
 * of the workspace both have to fail here. Announcing a file is a weaker act
 * than serving one, but it still names a path to a UI that will then fetch it.
 */
export async function confine(root: string, path: string): Promise<string | null> {
  if (path.includes('\0') || isAbsolute(path)) return null
  let base: string
  try {
    base = await realpath(root)
  } catch {
    return null
  }
  let real: string
  try {
    real = await realpath(resolve(base, path))
  } catch {
    return null
  }
  return real === base || real.startsWith(`${base}${sep}`) ? real : null
}

/**
 * The entire contract with DSH's deliverables accumulator.
 *
 * `card: 'generic'` plus `kind: 'edit'` is what makes the call count as a
 * mutation, and `locations` is where the paths are read from. Change either and
 * the file goes back to being invisible — with no error anywhere, which is the
 * exact symptom this tool exists to remove. Exported so a test can hold the
 * shape rather than merely assert the function did not throw.
 */
export function deliverableCallView(path: string): GenericCallView {
  return {
    card: 'generic',
    kind: 'edit',
    title: `产出文件 ${basename(path)}`,
    locations: [{ path }],
  }
}

/**
 * Register the tool.
 *
 * `presentCall` is where the whole effect lives — it runs at call time and is
 * what the accumulator reads. `execute` only decides whether the call succeeds,
 * and that matters too: the accumulator drops failed calls, so a path that is
 * not there produces no chip rather than a chip that 404s.
 */
export function registerDeliverableTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: DELIVERABLE_TOOL_NAME,
    description: [
      '把本次会话产出的文件挂到回复里，用户就能点开预览或下载。',
      '脚本生成的文件（.docx / .pptx / .xlsx / .pdf / 图片等）必须调用一次，否则回复里不会出现任何可点的入口——',
      '这类文件不会自动出现。用编辑工具直接写出的文本文件（.html / .md / .txt）已经自动挂上，不必重复调用。',
      'path 是相对会话工作区的路径，例如 out/报告.docx。',
    ].join(''),
    parameters: {
      path: {
        type: 'string', required: true,
        description: '相对会话工作区的文件路径，例如 out/报告.docx。不接受绝对路径或 .. 上跳。',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // Reading a file's size touches nothing; two of these can overlap safely.
    isConcurrencySafe: () => true,
    presentCall: (args): ToolCallView => deliverableCallView(args.path),
    async execute(args) {
      const real = await confine(workspaceRoot(), args.path)
      if (real === null) {
        throw new Error(`路径不在会话工作区内，或不存在：${args.path}`)
      }
      const info = await stat(real)
      if (!info.isFile()) {
        throw new Error(`不是一个文件：${args.path}`)
      }
      return { path: args.path, bytes: info.size } as never
    },
  }))
}
