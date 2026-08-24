/**
 * Where a Runtime executes, as a seam.
 *
 * The manager owns identity, policy, provisioning and lifecycle — *when* a
 * Runtime starts and dies, and for whom. What it deliberately does not own is
 * *where* the Runtime executes: a child process shares the gateway's kernel,
 * user id and filesystem, which is fine for one operator's machine and wrong
 * for a host serving strangers. That choice is a deployment posture, so it
 * hides behind this interface the way Kubernetes hides isolation strength
 * behind a RuntimeClass: the orchestrator stays the same, the isolation is a
 * parameter.
 *
 * A backend answers exactly one question — "run this Runtime, tell me where it
 * listens" — plus the three follow-ups a supervisor cannot do without: is it
 * still alive, what did it print, make it stop.
 */
import type { RuntimeLayout } from './runtime-provision.js'

/** Everything a backend needs to start one Runtime. */
export interface RuntimeStart {
  /** Stable runtime key; backends name their unit after it (process title, container name). */
  readonly key: string
  /** Host-side paths of the provisioned Runtime: CLI entry, home, workspace. */
  readonly layout: RuntimeLayout
  /**
   * The fully assembled child environment from `runtimeEnvironment`.
   *
   * Assembling it is the manager's job — it is derived from verified identity
   * and deployment policy. A backend transports it, never edits it.
   */
  readonly env: NodeJS.ProcessEnv
  /** Public host the Runtime's web server must accept in Host headers. */
  readonly publicHost: string
}

/** One running Runtime, wherever it runs. */
export interface RuntimeHandle {
  /** Origin the gateway proxies to, e.g. `http://127.0.0.1:41234`. */
  readonly target: string
  /**
   * Why the Runtime is gone — exit code or signal — or `null` while it runs.
   *
   * Synchronous on purpose: readiness polling checks this between probes, and
   * a check that awaited would race the very exit it is looking for.
   */
  exitCause(): number | string | null
  /** Resolves with the exit cause once the Runtime is gone. Never rejects. */
  readonly exited: Promise<number | string | null>
  /**
   * The most recent output lines, oldest first.
   *
   * This is how a failed start explains itself. A backend that returned
   * nothing here would reduce every startup failure to a status code.
   */
  logTail(lines: number): readonly string[]
  /** Stop the Runtime and release what it held. Idempotent. */
  stop(): Promise<void>
}

export interface RuntimeBackend {
  /** Isolation label surfaced to operators in `RuntimeView`. */
  readonly isolation: string
  start(start: RuntimeStart): Promise<RuntimeHandle>
}
