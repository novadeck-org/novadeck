import { maxAutoRunValue, type AutoRunOutcome, type AutoRunState } from "@novadeck/protocol"
import { Latest } from "@novadeck/wire/server"

import { logs } from "../log.js"
import {
  type AutoRunRead,
  readAutoRun,
  type Scope,
  swapAutoRun,
  type Swap,
} from "./autorun-relay.js"
import {
  decodeValue,
  encodeValue,
  shown,
  silenced,
  unwrapped,
  type AutoRunValue,
} from "./autorun-value.js"
import { type CmdOutput, cmdOutput } from "./cmd-output.js"

const log = logs.for("autorun")

/** What a check of cmd found (`CmdOutput`). */
export type Printing = CmdOutput

/**
 * Runs the person's AutoRun value alone, as `cmd /d /s /c "<value>"` (`/d` keeps every AutoRun
 * out, so only the value runs), with the runner's child environment, and tells whether it
 * printed on stdout or stderr. Five seconds, or a cmd that doesn't start, is not clean.
 */
export const runsClean = (
  value: string,
  {
    program = process.env.COMSPEC || "cmd.exe",
    timeoutMs = 5_000,
    relay,
    args = (each: string) => ["/d", "/s", "/c", `"${each}"`],
  }: {
    readonly program?: string
    readonly timeoutMs?: number
    readonly relay?: string
    /** For tests: the arguments the program is started with. */
    readonly args?: (value: string) => string[]
  } = {},
): Promise<Printing> =>
  // Verbatim, as Node would escape the quotes in a way cmd does not read.
  cmdOutput({ program, args: args(value), timeoutMs, relay, verbatim: true })

/** What the state machine asks of the rest of the runner; tests give it fakes. */
export type AutoRunHost = {
  readonly platform: NodeJS.Platform
  /** `novadeck-relay autorun`, parsed: undefined where it could not be read. */
  readonly read: () => Promise<AutoRunRead | undefined>
  /** `novadeck-relay autorun-set` on the person's value. */
  readonly swap: (kind: "sz" | "expand", expected: string, next: string) => Promise<Swap>
  /** The isolation check of one value (`runsClean`). */
  readonly isolated: (value: string) => Promise<Printing>
  /**
   * The check of the real thing: `cmd /c rem` with every AutoRun, stdout and stderr. Only
   * "clean" is clean: a cmd that did not start, or ran too long, is not.
   */
  readonly recheck: () => Promise<CmdOutput>
  /**
   * Why Antigravity's installed plugin would not be replaced now (`Harnesses.held`): the
   * Novadeck terminals running it, or a previous runner's narrowed terminals.
   */
  readonly held: () =>
    | { readonly why: "running" | "restart"; readonly terminals: readonly string[] }
    | undefined
  /** Writes Antigravity's plugin files again (alone), registering PreToolUse unless `printing`. */
  readonly writePlugin: (printing: boolean) => Promise<void>
  /** Installs the written plugin into Antigravity under the refresh rules (which may hold it). */
  readonly refresh: () => Promise<void>
  /** Whether Antigravity is connected with an installed plugin that differs from the one written. */
  readonly stale: () => Promise<boolean>
  /** Tells each Antigravity terminal its live grants again, with the caveat as it stands now. */
  readonly announce: () => void
  /** Whether Antigravity is installed here: the fix is offered only where it is. */
  readonly installed: () => Promise<boolean>
  /**
   * The registry state (`readKey`) the person last dismissed the Inbox's line for, if any:
   * the value of HKCU and of HKLM, or their absence.
   */
  readonly dismissedFor: () => string | undefined
  /** Keeps the registry state the person dismissed the line for; null forgets it. */
  readonly rememberDismissed: (value: string | null) => void
}

type Start = "prints" | "slow" | undefined

/**
 * The whole registry state a dismissal is for: what HKCU and HKLM hold, or that one is absent
 * or unreadable. Another state, by either, offers the fix again.
 */
const readKey = (read: AutoRunRead | undefined): string =>
  read ? JSON.stringify([read.user, read.machine]) : "unread"

/**
 * cmd's AutoRun and the person's one-click silencing of its output (approvals-design.md,
 * Appendix F). It reads the registry, offers a rewrite that `silenced` accepts and the
 * isolation check shows to work, makes it on the person's click alone, checks the real cmd
 * afterwards and keeps or undoes the change. It also holds the one live answer to whether cmd
 * prints, which grant texts, leasing, the launch-grant gate and the plugin's files all read.
 */
export class AutoRun {
  private prints = false
  // Silenced, but Antigravity's plugin is still to be installed (a refresh held it).
  private held = false
  private eligible = false
  private outcome: AutoRunOutcome | null = null
  private current: AutoRunState = { state: "none", outcome: null, dismissed: false }
  private readonly readers = new Set<Latest<AutoRunState>>()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly host: AutoRunHost) {}

  /** Whether cmd prints something of its own before every command, as far as is known now. */
  printing(): boolean {
    return this.prints
  }

  /**
   * What a grant's note says of cmd: true while it prints, "held" once it doesn't but
   * Antigravity's plugin is still to be installed, false otherwise. `printing` is the former
   * alone, the gate of everything that acts.
   */
  note(): boolean | "held" {
    return this.prints || (this.held ? "held" : false)
  }

  /**
   * A refresh ran: if the plugin held after a silence is installed now, the grants are told
   * again, with a note that is true.
   */
  async refreshed(): Promise<void> {
    if (!this.held || this.host.held() !== undefined) return
    if (await this.host.stale().catch(() => true)) return
    this.held = false
    this.host.announce()
  }

  /**
   * Sets what the start's check found, then reads the registry: the offer is made only where
   * the check returned "prints" (a "slow" one offers nothing), on Windows alone, and where
   * Antigravity is installed, as nothing else is helped by it.
   */
  async started(check: Start): Promise<void> {
    this.prints = check !== undefined
    this.held = false
    this.eligible = check === "prints" && (await this.host.installed().catch(() => false))
    this.outcome = null
    await this.reload()
  }

  /** The state now, then again on each change. */
  async *watch(signal?: AbortSignal): AsyncGenerator<AutoRunState> {
    const reader = new Latest<AutoRunState>()
    this.readers.add(reader)
    reader.push(this.current)
    const abort = () => reader.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (this.closed || signal?.aborted) reader.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- States are delivered in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.finish()
      this.readers.delete(reader)
    }
  }

  close(): void {
    this.closed = true
    for (const reader of this.readers) reader.finish()
    this.readers.clear()
  }

  /**
   * Hides the Inbox's line for the registry state the person has now (both values, or their
   * absence), and keeps that across starts: a changed state offers again. The state still carries the offer, as `dismissed`, for
   * Preferences.
   */
  dismiss(): Promise<void> {
    return this.exclusive(async () => {
      const read = await this.host.read().catch(() => undefined)
      // A registry that could not be read is a state too: it offers again once a read works.
      this.host.rememberDismissed(readKey(read))
      this.outcome = null
      await this.reload()
    })
  }

  /**
   * Rewrites the person's AutoRun to `value`, which the card showed, when it is still what
   * Novadeck would write now, and checks the real cmd afterwards. The outcome is part of the
   * state that follows; nothing throws for a refusal.
   */
  silence(value: string): Promise<void> {
    return this.exclusive(async () => {
      this.host.rememberDismissed(null)
      this.outcome = await this.silenceNow(value).catch((error: unknown) => {
        log.error("autorun.silence-failed", "Novadeck could not silence cmd's AutoRun", {
          err: error,
        })
        return failed("Novadeck could not change it.")
      })
      await this.reload()
    })
  }

  /**
   * Puts back the value inside Novadeck's wrapper, only while the person's AutoRun is exactly
   * the wrapper and no Novadeck Antigravity terminal runs. The plugin without PreToolUse is
   * installed before the registry changes.
   */
  undo(): Promise<void> {
    return this.exclusive(async () => {
      this.host.rememberDismissed(null)
      this.outcome = await this.undoNow().catch((error: unknown) => {
        log.error("autorun.undo-failed", "Novadeck could not undo silencing cmd's AutoRun", {
          err: error,
        })
        return failed("Novadeck could not undo it.")
      })
      await this.reload()
    })
  }

  // One click at a time: each reads the registry and writes it.
  private exclusive(work: () => Promise<void>): Promise<void> {
    // Nothing but Windows has an AutoRun: a click there reaches no registry, relay or cmd.
    if (this.host.platform !== "win32") return Promise.resolve()
    const done = this.queue.then(work, work)
    this.queue = done.catch(() => {})
    return done
  }

  private async silenceNow(value: string): Promise<AutoRunOutcome | null> {
    const read = await this.host.read()
    // A second click, or another window's, on a change already made: the earlier outcome stands.
    if (read?.user.found === "value") {
      const now = decodeValue(read.user.type, read.user.encoded)
      if (now?.text === value && unwrapped(value) !== undefined) return this.outcome
    }
    const found = this.candidate(read)
    if (!this.eligible || found.kind !== "offerable" || found.next !== value) {
      log.info("autorun.conflict", "The AutoRun is not what the card showed; nothing was written.")
      return { kind: "conflict" }
    }
    const { user, next, machine } = found
    // Once more, before writing: the original prints and the rewrite does not.
    const [before, after] = await Promise.all([
      this.host.isolated(user.text),
      this.host.isolated(next),
    ])
    if (before !== "prints" || after !== "clean") {
      log.warn("autorun.isolation-changed", "The isolation check no longer shows the rewrite works")
      return failed(
        after === "slow" || before === "slow"
          ? "A check of the new value didn't finish within 5 seconds."
          : after === "error" || before === "error"
            ? "cmd could not run the check of the new value."
            : "It no longer showed that the new value would print nothing.",
      )
    }
    const was = encodeValue(user.text)
    const will = encodeValue(next)
    const swapped = await this.host.swap(user.kind, was, will)
    if (swapped === "changed") return { kind: "conflict" }
    if (swapped !== "ok") {
      // A timeout or a failed read-back may have written it all the same: the registry decides
      // the message, so it and the state agree.
      log.warn("autorun.swap-failed", `Writing the AutoRun ended ${swapped}`)
      const now = await this.userBytes()
      if (now === was) return failed("Windows did not write it; the value is as it was.")
      if (now !== will) return failed("The value is now something else; it was left as it is.")
    }
    const again = await this.host.read()
    if (!(again?.user.found === "value" && again.user.encoded === will)) {
      return failed("The value changed again while it was written; it was left as it is.")
    }
    const check = await this.host.recheck()
    if (check === "clean") {
      this.prints = false
      const held = this.host.held()
      const unplugged = await this.plugin(false)
      if (unplugged !== undefined) return unplugged
      this.held = held !== undefined || (await this.host.stale().catch(() => true))
      this.host.announce()
      log.info("autorun.silenced", "cmd's AutoRun was silenced; cmd prints nothing now")
      return {
        kind: "applied-clean",
        waiting: held?.why === "running" ? held.terminals.slice(0, 256) : [],
        restart: held?.why === "restart",
      }
    }
    if (machine !== null) {
      log.info("autorun.hklm", "cmd still prints, and the machine's AutoRun holds a value")
      return { kind: "applied-still-prints-hklm" }
    }
    // Nothing else holds a value: it did not silence it, so it is put back.
    const back = await this.host.swap(user.kind, will, was)
    if (back !== "ok" && (await this.userBytes()) !== was) {
      log.error("autorun.rollback-failed", `Putting the AutoRun back ended ${back}`)
      return failed("It did not silence cmd, and Novadeck could not put the value back.")
    }
    log.info("autorun.rolled-back", "The change did not silence cmd, so it was undone")
    return { kind: "rolled-back" }
  }

  private async undoNow(): Promise<AutoRunOutcome | null> {
    const read = await this.host.read()
    const user = read?.user
    const value = user?.found === "value" ? decodeValue(user.type, user.encoded) : undefined
    const inner = value === undefined ? undefined : unwrapped(value.text)
    if (value === undefined || inner === undefined) {
      // A second click, or another window's, on an Undo already done: the outcome stands.
      if (this.outcome?.kind === "undone") return this.outcome
      log.info("autorun.not-silenced", "The AutoRun is not Novadeck's wrapper; nothing to undo")
      return { kind: "conflict" }
    }
    // Before any write: a refresh that would hold leaves the old plugin, which registers
    // PreToolUse, under an AutoRun that prints again.
    const held = this.host.held()
    if (held)
      return {
        kind: "undo-refused",
        terminals: [...held.terminals],
        restart: held.why === "restart",
      }
    // The plugin without PreToolUse and cmd printing again, before the registry says so.
    this.prints = true
    const unplugged = await this.plugin(true)
    if (unplugged !== undefined) return unplugged
    if (await this.host.stale().catch(() => true)) {
      // Still the old plugin: nothing may say cmd prints while it registers PreToolUse. The
      // registry was not touched.
      log.warn("autorun.undo-held", "Antigravity's plugin was not replaced; the AutoRun is left")
      await this.restore()
      return failed("Antigravity's plugin could not be replaced, so the AutoRun was left as it is.")
    }
    const swapped = await this.host.swap(value.kind, encodeValue(value.text), encodeValue(inner))
    const now = swapped === "ok" ? undefined : await this.userBytes()
    if (swapped === "ok" || now === encodeValue(inner)) {
      this.eligible = true
      this.held = false
      this.host.announce()
      log.info("autorun.undone", "cmd's AutoRun was put back as it was")
      return { kind: "undone" }
    }
    // The wrapper stays: if cmd is quiet still, the plugin goes back to registering PreToolUse.
    log.warn("autorun.undo-swap-failed", `Putting the AutoRun back ended ${swapped}`)
    await this.restore()
    return swapped === "changed" || now !== encodeValue(value.text)
      ? { kind: "conflict" }
      : failed("Windows would not let Novadeck put the value back.")
  }

  /** HKCU's AutoRun bytes now, in base64, or undefined where it holds none or can't be read. */
  private async userBytes(): Promise<string | undefined> {
    const now = (await this.host.read().catch(() => undefined))?.user
    return now?.found === "value" ? now.encoded : undefined
  }

  /**
   * After an Undo that went no further: if cmd is clean, Antigravity's plugin goes back to
   * registering PreToolUse and cmd is counted as quiet again.
   */
  private async restore(): Promise<void> {
    if ((await this.host.recheck()) !== "clean") return
    this.prints = false
    if ((await this.plugin(false)) === undefined) this.host.announce()
  }

  /**
   * Renders Antigravity's plugin for `printing` and installs it under the refresh rules. A
   * failure is an outcome, and leaves cmd counted as printing, which only withholds.
   */
  private async plugin(printing: boolean): Promise<AutoRunOutcome | undefined> {
    try {
      await this.host.writePlugin(printing)
      await this.host.refresh()
      return undefined
    } catch (error) {
      log.error("autorun.plugin-failed", "Novadeck could not update its Antigravity plugin", {
        err: error,
      })
      this.prints = true
      return failed("Novadeck could not update its Antigravity plugin.")
    }
  }

  /** Reads the registry, works out the state and tells the watchers if it changed. */
  private async reload(): Promise<void> {
    const next = await this.evaluate()
    const key = JSON.stringify(next)
    if (key === JSON.stringify(this.current)) return
    this.current = next
    for (const reader of this.readers) reader.push(next, key)
  }

  private async evaluate(): Promise<AutoRunState> {
    const outcome = this.outcome
    if (this.host.platform !== "win32") return { state: "none", outcome: null, dismissed: false }
    const read = await this.host.read().catch(() => undefined)
    const found = this.candidate(read)
    const machine = text(read?.machine)
    if (found.kind === "silenced")
      return {
        state: "silenced",
        current: found.current,
        restores: found.restores,
        machine,
        suggested: suggestion(read?.machine),
        outcome,
        dismissed: false,
      }
    if (!this.eligible) return { state: "none", outcome, dismissed: false }
    // Dismissed for the registry as it is now; another state is offered again.
    const dismissed = this.host.dismissedFor() === readKey(read)
    if (found.kind === "absent") return { state: "none", outcome, dismissed: false }
    if (found.kind === "manual")
      return {
        state: "manual",
        reason: found.reason,
        rule: found.rule ?? null,
        current: found.current ?? null,
        machine,
        suggested: found.reason === "machine" ? suggestion(read?.machine) : null,
        outcome,
        dismissed,
      }
    // Offerable: the isolation check decides, once for the original and once for the rewrite.
    const [before, after] = await Promise.all([
      this.host.isolated(found.user.text),
      this.host.isolated(found.next),
    ])
    if (before !== "prints") {
      return {
        state: "manual",
        reason:
          before === "slow" || before === "error"
            ? "unchecked"
            : machine === null
              ? "quiet"
              : "machine",
        rule: null,
        current: found.user.text,
        machine,
        suggested: machine === null ? null : suggestion(read?.machine),
        outcome,
        dismissed,
      }
    }
    if (after !== "clean")
      return {
        state: "manual",
        reason: "refused",
        rule:
          after === "slow"
            ? "trying the new value didn't finish within 5 seconds"
            : after === "error"
              ? "cmd could not run the new value to try it"
              : "the new value still printed when tried",
        current: found.user.text,
        machine,
        suggested: null,
        outcome,
        dismissed,
      }
    return {
      state: "offer",
      current: found.user.text,
      next: found.next,
      machine,
      outcome,
      dismissed,
    }
  }

  /** What the registry's values allow, before any check runs. */
  private candidate(read: AutoRunRead | undefined): Candidate {
    if (read === undefined || read.user.found === "unreadable")
      return { kind: "manual", reason: "form" }
    if (read.user.found === "absent")
      return read.machine.found === "absent"
        ? { kind: "absent" }
        : { kind: "manual", reason: "machine" }
    const value = decodeValue(read.user.type, read.user.encoded)
    if (value === undefined)
      return { kind: "manual", reason: "form", current: text(read.user) ?? undefined }
    const inner = unwrapped(value.text)
    if (inner !== undefined) return { kind: "silenced", current: value.text, restores: inner }
    // A blank value never prints.
    if (value.text.trim() === "")
      return read.machine.found === "absent"
        ? { kind: "absent" }
        : { kind: "manual", reason: "machine" }
    const rewrite = silenced(value.text)
    if ("refusal" in rewrite)
      return {
        kind: "manual",
        reason: "refused",
        rule: rewrite.refusal,
        current: value.text.slice(0, maxAutoRunValue),
      }
    return { kind: "offerable", user: value, next: rewrite.value, machine: text(read.machine) }
  }
}

type Candidate =
  | { readonly kind: "absent" }
  | {
      readonly kind: "manual"
      readonly reason: "machine" | "refused" | "form"
      readonly rule?: string
      readonly current?: string | undefined
    }
  | { readonly kind: "silenced"; readonly current: string; readonly restores: string }
  | {
      readonly kind: "offerable"
      readonly user: AutoRunValue
      readonly next: string
      readonly machine: string | null
    }

const failed = (message: string): AutoRunOutcome => ({ kind: "failed", message })

/** A scope's value as the person reads it, or null where it holds none. */
const text = (scope: Scope | undefined): string | null => {
  const found = scope?.found === "value" ? shown(scope.encoded) : null
  return found === null || found.trim() === "" ? null : found
}

/** The machine's value as it could be rewritten, for the manual step that asks to change it. */
const suggestion = (scope: Scope | undefined): string | null => {
  if (scope?.found !== "value") return null
  const value = decodeValue(scope.type, scope.encoded)
  const rewrite = value === undefined ? undefined : silenced(value.text)
  return rewrite !== undefined && "value" in rewrite ? rewrite.value : null
}

/** The host for the machine's own registry, relay and cmd. */
export const systemHost = (
  relay: string,
  rest: Omit<AutoRunHost, "platform" | "read" | "swap" | "isolated">,
  platform: NodeJS.Platform = process.platform,
): AutoRunHost => ({
  platform,
  read: () => readAutoRun(relay),
  swap: (kind, expected, next) => swapAutoRun(relay, kind, expected, next),
  isolated: (value) => runsClean(value, { relay }),
  ...rest,
})
