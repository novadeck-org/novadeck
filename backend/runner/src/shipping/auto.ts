/**
 * Antigravity's gate answer, from its own confirmation (see architecture/grants.md): Antigravity's
 * hook can deny but cannot allow, and a static allow rule would run unasked what its dialog
 * asks about today (`ask` is silence against one). So a permitted command goes through
 * Antigravity's confirmation, and Novadeck presses its run-once option as the person would,
 * through the same driver that answers a request from the chat or the Inbox, and only where:
 *
 * - the request is the terminal's own root agent's confirmation of a `run_command` call, and its
 *   dialog was read in full, showing the very command the request's hook recorded (the call the adapter already
 *   matched), never a cut or wrapped one;
 * - a live permit covers that whole command as the gate reads it for Claude Code;
 * - the option is the one worded "Yes, run command", never an "always allow" or a persisted one.
 *
 * In any doubt nothing is pressed, and the person answers.
 */
import type { RequestAnswer, RequestDialog } from "@novadeck/protocol"

import { requestRef } from "../harnesses/detail.js"
import { logs } from "../log.js"
import type { Record } from "../terminals/record.js"
import type { Shipping } from "./service.js"

const log = logs.for("shipping")

/** What the answerer needs of the terminals, by terminal. */
export type PermitAnswersHost = {
  readonly shipping: () => Shipping | undefined
  /** The agent bound there and the requests it waits on; undefined with none, or once it is gone. */
  readonly pending: (terminalId: string) =>
    | {
        readonly agent: string
        readonly cwd: string | null
        readonly requests: readonly {
          readonly ref: string
          readonly actor: string | null
          readonly kind: string
          readonly tool: string
          readonly input: unknown
        }[]
      }
    | undefined
  /** The request's dialog as it shows now, null where none does. */
  readonly dialog: (terminalId: string, ref: string) => RequestDialog | null
  /** Answers the request through its dialog, as the person would. */
  readonly answer: (terminalId: string, ref: string, answer: RequestAnswer) => Promise<void>
}

/** The option whose words are exactly Antigravity's run-once one. */
const runOnce = /^Yes, run command$/

export class PermitAnswers {
  // The requests looked at already, by terminal and ref: each is decided once, when its dialog
  // first reads, so a permit given later never answers a dialog that was waiting for the person.
  private readonly decided = new Set<string>()

  constructor(private readonly host: PermitAnswersHost) {}

  /** The terminal's requests or dialogs changed. */
  changed(terminalId: string): void {
    this.look(terminalId).catch((error: unknown) => {
      log.warn("shipping.auto-answer-failed", "Novadeck's answer to a confirmation failed", {
        data: { terminalId, error: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  private async look(terminalId: string): Promise<void> {
    const shipping = this.host.shipping()
    const info = this.host.pending(terminalId)
    const live = new Set(info?.requests.map(({ ref }) => `${terminalId}\n${ref}`))
    for (const key of this.decided)
      if (key.startsWith(`${terminalId}\n`) && !live.has(key)) this.decided.delete(key)
    if (!shipping?.enabled() || info?.agent !== "agy") return
    for (const request of info.requests) {
      const key = `${terminalId}\n${request.ref}`
      if (this.decided.has(key)) continue
      // Antigravity's status line names no tool: its request is a `confirmation`, whose input is the
      // call its conversation's latest PreToolUse named, which the dialog's adapter read the screen
      // against.
      if (
        request.actor !== null ||
        request.kind !== "permission" ||
        request.tool !== "confirmation"
      )
        continue
      const dialog = this.host.dialog(terminalId, request.ref)
      if (dialog?.type !== "choices" || dialog.title !== "Run this command?") continue
      this.decided.add(key)
      const { command, cwd } = { command: commandOf(request.input), cwd: info.cwd }
      // The dialog shows the call's command whole (the adapter gives that only where it does).
      if (command === undefined || cwd === null || dialog.detail !== command) continue
      const options = dialog.options.filter(({ label }) => runOnce.test(label))
      if (options.length !== 1) continue
      // eslint-disable-next-line no-await-in-loop -- One request after another.
      const auto = await shipping.autoAnswer(terminalId, "agy", command, cwd)
      if (!auto) continue
      try {
        // eslint-disable-next-line no-await-in-loop -- As above.
        await this.host.answer(terminalId, request.ref, {
          type: "choice",
          dialog: dialog.id,
          option: options[0]!.id,
        })
      } catch (error) {
        log.warn("shipping.auto-answer-failed", "Novadeck's answer to a confirmation failed", {
          data: {
            terminalId,
            command,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        continue
      }
      // The answer is typed: a single-use permit ends here, and the permit's record says so.
      auto.used()
      log.info(
        "shipping.auto-answer",
        `Novadeck answered Antigravity's confirmation: ${auto.note}`,
        {
          data: {
            terminalId,
            agent: "agy",
            command,
            permits: auto.note,
            at: new Date().toISOString(),
          },
        },
      )
    }
  }
}

const commandOf = (input: unknown): string | undefined => {
  const call = input as { name?: unknown; args?: { CommandLine?: unknown } } | null | undefined
  const command = call?.name === "run_command" ? call.args?.CommandLine : undefined
  return typeof command === "string" && command.trim() !== "" ? command : undefined
}

/** The answerer's view of the runner's terminals: a record's bound agent and its waiting requests. */
export const permitAnswersHost = (deps: {
  readonly shipping: () => Shipping | undefined
  readonly record: (terminalId: string) => Pick<Record, "bound" | "summary"> | undefined
  readonly dialog: PermitAnswersHost["dialog"]
  readonly answer: PermitAnswersHost["answer"]
}): PermitAnswersHost => ({
  shipping: deps.shipping,
  pending: (terminalId) => {
    const record = deps.record(terminalId)
    const bound = record?.bound
    if (!record || !bound) return undefined
    const { binding, activity } = bound
    return {
      agent: binding.agent,
      cwd: record.summary.cwd,
      requests: activity.pending.map((request) => ({
        ref: requestRef(binding, request),
        actor: request.actor,
        kind: request.kind,
        tool: request.toolName,
        input: request.input,
      })),
    }
  },
  dialog: deps.dialog,
  answer: deps.answer,
})

/** The answerer for the runner's terminals, over their typing (the dialogs read and the answers driver). */
export const permitAnswersOf = (deps: {
  readonly shipping: () => Shipping | undefined
  readonly record: (terminalId: string) => Pick<Record, "bound" | "summary"> | undefined
  readonly typing: () => {
    readonly dialogs: { readonly shown: PermitAnswersHost["dialog"] }
    readonly answer: PermitAnswersHost["answer"]
  }
}): PermitAnswers =>
  new PermitAnswers(
    permitAnswersHost({
      shipping: deps.shipping,
      record: deps.record,
      dialog: (terminalId, ref) => deps.typing().dialogs.shown(terminalId, ref),
      answer: (terminalId, ref, answer) => deps.typing().answer(terminalId, ref, answer),
    }),
  )
