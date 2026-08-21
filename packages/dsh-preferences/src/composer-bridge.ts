/**
 * External composer handoff: the embedding business system posts one prepared
 * sentence and the assistant drops it into the native composer draft. This
 * module is the pure protocol and its queueing state; the browser plugin owns
 * the window listener, the origin fence and the live composer resolution.
 *
 * The bridge only fills the box. Sending stays a human action inside DSH, so an
 * embedding page can never make the agent speak or act on its own.
 */

/** postMessage discriminator; a payload without it belongs to someone else. */
export const COMPOSER_CHANNEL = 'dshserver.composer'

/** Wire version. An unknown version is refused instead of guessed. */
export const COMPOSER_PROTOCOL_VERSION = 1

/** Longest single handoff accepted from the business system. */
export const MAX_PROMPT_LENGTH = 4000

/** Longest draft the bridge is willing to leave in the composer. */
export const MAX_DRAFT_LENGTH = 8000

/** Longest accepted correlation id. */
const MAX_REQUEST_ID_LENGTH = 128

/** How many settled request ids stay replay-safe. */
const HANDLED_HISTORY = 16

/**
 * C0 controls, DEL, and U+FFFC: the composer's input machine reserves U+FFFC
 * as its reference-chip placeholder, so external text must never carry one.
 */
const FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFC]/gu

/** How a handoff meets a draft the user already started. */
export type ComposerInsertMode = 'append' | 'replace'

/** Terminal outcome reported back to the business system. */
export type ComposerStatus = 'applied' | 'pending' | 'rejected'

/** Why a handoff was refused; stable strings the host may branch on. */
export type ComposerRefusal =
  | 'unsupported-version'
  | 'malformed'
  | 'empty-text'
  | 'text-too-long'
  | 'draft-too-long'
  | 'composer-busy'

/** One accepted handoff, normalized. */
export interface ComposerInsert {
  readonly type: 'insert'
  readonly text: string
  readonly mode: ComposerInsertMode
  readonly requestId?: string
}

/** A readiness probe. */
export interface ComposerPing {
  readonly type: 'ping'
  readonly requestId?: string
}

/** An addressed but unusable payload. */
export interface ComposerProblem {
  readonly type: 'problem'
  readonly reason: ComposerRefusal
  readonly requestId?: string
}

/** Outcome of one handoff. */
export interface ComposerResult {
  readonly channel: typeof COMPOSER_CHANNEL
  readonly version: number
  readonly type: 'result'
  readonly status: ComposerStatus
  readonly reason?: ComposerRefusal
  readonly requestId?: string
}

/** Announced once at activation and again for every ping. */
export interface ComposerReady {
  readonly channel: typeof COMPOSER_CHANNEL
  readonly version: number
  readonly type: 'ready'
}

/** Everything the assistant frame posts back. */
export type ComposerReply = ComposerResult | ComposerReady

/** The live composer as the bridge needs it (the native input machine). */
export interface ComposerTarget {
  /** Current draft plus whether a submit transaction owns the composer. */
  read(): { readonly draft: string; readonly busy: boolean }
  /** The input machine's single draft write path. */
  write(draft: string): void
}

/** Where one reply goes; the wiring layer binds it to the sender window. */
export type ComposerResponder = (reply: ComposerReply) => void

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requestIdOf(value: unknown): string | undefined {
  const id = textOf(value)
  return id === undefined || id === '' || id.length > MAX_REQUEST_ID_LENGTH ? undefined : id
}

/** Strip what the composer must not receive and settle on LF line breaks. */
export function normalizePrompt(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(FORBIDDEN_CHARACTERS, '').trim()
}

/** The reply announcing that the bridge is listening. */
export function composerReady(): ComposerReady {
  return { channel: COMPOSER_CHANNEL, version: COMPOSER_PROTOCOL_VERSION, type: 'ready' }
}

function composerResult(
  status: ComposerStatus,
  requestId: string | undefined,
  reason?: ComposerRefusal,
): ComposerResult {
  return {
    channel: COMPOSER_CHANNEL,
    version: COMPOSER_PROTOCOL_VERSION,
    type: 'result',
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

function problem(reason: ComposerRefusal, requestId: string | undefined): ComposerProblem {
  return { type: 'problem', reason, ...(requestId === undefined ? {} : { requestId }) }
}

/**
 * Classify one raw postMessage payload.
 * @param data - the untrusted `MessageEvent.data`.
 * @returns the parsed message, or undefined when the payload is not addressed
 * to this bridge and must be ignored without a reply.
 */
export function readComposerMessage(
  data: unknown,
): ComposerInsert | ComposerPing | ComposerProblem | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const envelope = data as Record<string, unknown>
  if (envelope.channel !== COMPOSER_CHANNEL) return undefined
  const requestId = requestIdOf(envelope.requestId)
  if (envelope.version !== COMPOSER_PROTOCOL_VERSION) return problem('unsupported-version', requestId)
  if (envelope.type === 'ping') return { type: 'ping', ...(requestId === undefined ? {} : { requestId }) }
  if (envelope.type !== 'insert') return problem('malformed', requestId)

  const raw = textOf(envelope.text)
  if (raw === undefined) return problem('malformed', requestId)
  if (raw.length > MAX_PROMPT_LENGTH) return problem('text-too-long', requestId)
  const mode = envelope.mode === undefined ? 'append' : envelope.mode
  if (mode !== 'append' && mode !== 'replace') return problem('malformed', requestId)
  const text = normalizePrompt(raw)
  if (text === '') return problem('empty-text', requestId)
  return { type: 'insert', text, mode, ...(requestId === undefined ? {} : { requestId }) }
}

/**
 * Decide the next draft. Appending keeps whatever the user already typed —
 * the business system contributes a line, it does not own the box.
 * @param current - the live composer draft.
 * @param insert - the accepted handoff.
 * @returns the draft to write.
 */
export function composeDraft(current: string, insert: ComposerInsert): string {
  if (insert.mode === 'replace' || current.trim() === '') return insert.text
  return `${current.replace(/\s+$/u, '')}\n${insert.text}`
}

/**
 * Protocol state machine: validates handoffs, applies them to the live
 * composer, and holds one handoff that arrived before a session existed.
 */
export class ComposerBridge {
  private held: { readonly insert: ComposerInsert; readonly respond: ComposerResponder } | undefined
  private readonly handled: string[] = []

  /**
   * @param resolve - live composer lookup; undefined while the assistant has
   * no current session (boot, or after the last session was closed).
   */
  constructor(private readonly resolve: () => ComposerTarget | undefined) {}

  /** Whether a handoff is still waiting for a composer to exist. */
  get holding(): boolean {
    return this.held !== undefined
  }

  /**
   * Handle one inbound payload from an already origin-checked sender.
   * @param data - the untrusted `MessageEvent.data`.
   * @param respond - reply channel back to that sender.
   */
  receive(data: unknown, respond: ComposerResponder): void {
    const message = readComposerMessage(data)
    if (message === undefined) return
    if (message.type === 'problem') {
      respond(composerResult('rejected', message.requestId, message.reason))
      return
    }
    if (message.type === 'ping') {
      respond(composerReady())
      return
    }
    // A repeated id is a retry of a delivery whose reply was lost, never a
    // second sentence: answer it without writing the text twice.
    if (message.requestId !== undefined && this.handled.includes(message.requestId)) {
      respond(composerResult('applied', message.requestId))
      return
    }
    this.apply(message, respond)
  }

  /** Retry the held handoff once a composer exists; a no-op otherwise. */
  flush(): void {
    const held = this.held
    if (held === undefined || this.resolve() === undefined) return
    this.held = undefined
    this.apply(held.insert, held.respond)
  }

  private apply(insert: ComposerInsert, respond: ComposerResponder): void {
    const target = this.resolve()
    if (target === undefined) {
      // One slot: a newer sentence supersedes the one still waiting.
      this.held = { insert, respond }
      respond(composerResult('pending', insert.requestId))
      return
    }
    const live = target.read()
    if (live.busy) {
      respond(composerResult('rejected', insert.requestId, 'composer-busy'))
      return
    }
    const draft = composeDraft(live.draft, insert)
    if (draft.length > MAX_DRAFT_LENGTH) {
      respond(composerResult('rejected', insert.requestId, 'draft-too-long'))
      return
    }
    target.write(draft)
    if (insert.requestId !== undefined) {
      this.handled.push(insert.requestId)
      if (this.handled.length > HANDLED_HISTORY) this.handled.shift()
    }
    respond(composerResult('applied', insert.requestId))
  }
}
