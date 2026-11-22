/**
 * Antigravity's gate answer, from its own confirmation (see architecture/grants.md): Antigravity's
 * hook can deny but cannot allow, and a static allow rule would run unasked what its dialog
 * asks about today (`ask` is silence against one). So a permitted command goes through
 * Antigravity's confirmation, and Novadeck presses its run-once option as the person would,
 * through the same driver that answers a request from the chat or the Inbox, and only where:
 *
 * - the hook, silent because a permit covers the command, recorded that very call a moment before
 *   (its step, which names the confirmation's request, and its raw command whole), and it is the
 *   only one waiting (`Shipping.autoAnswer`); so a dialog of any call the hook didn't vet is never
 *   answered, whatever it shows;
 * - the request's own input is that command, so one the report path pruned never matches;
 * - its dialog was read and shows the command unwrapped, or cut short by the mark agy ends a long
 *   command with, which is the recorded command's start;
 * - the option is the one worded "Yes, run command", never an "always allow" or a persisted one.
 *
 * A subagent's command matching a recorded one is answered under the terminal's permit, as the
 * gate allows it for Claude Code. In any doubt nothing is pressed, and the person answers.
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
          readonly askedAt: number
          readonly requestId: string
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
    if (!shipping?.enabled() || info?.agent !== "agy") return
    const live = info.requests.map(({ ref }) => ref)
    for (const request of info.requests) {
      // Antigravity's status line names no tool: its request is a `confirmation`, whose input is the
      // call its conversation's latest PreToolUse named, which the dialog's adapter read the screen
      // against.
      if (request.kind !== "permission" || request.tool !== "confirmation") continue
      const dialog = this.host.dialog(terminalId, request.ref)
      if (dialog?.type !== "choices" || dialog.title !== "Run this command?") continue
      if (typeof dialog.detail !== "string") continue
      // Decided once, as its dialog first reads.
      if (!shipping.firstLook(terminalId, request.ref, live)) continue
      const options = dialog.options.filter(({ label }) => runOnce.test(label))
      if (options.length !== 1) continue
      // eslint-disable-next-line no-await-in-loop -- One request after another.
      const auto = await shipping.autoAnswer(terminalId, "agy", {
        detail: dialog.detail,
        requestId: request.requestId,
        call: commandOf(request.input),
        askedAt: request.askedAt,
      })
      if (!auto) continue
      try {
        // eslint-disable-next-line no-await-in-loop -- As above.
        await this.host.answer(terminalId, request.ref, {
          type: "choice",
          dialog: dialog.id,
          option: options[0]!.id,
        })
      } catch (error) {
        // Not typed: the permit goes back, and the person answers.
        auto.release()
        log.warn("shipping.auto-answer-failed", "Novadeck's answer to a confirmation failed", {
          data: {
            terminalId,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        continue
      }
      // The answer is typed: the permit was taken before it, and what the command voids ends now.
      auto.done()
      log.info(
        "shipping.auto-answer",
        `Novadeck answered Antigravity's confirmation: ${auto.note}`,
        {
          data: {
            terminalId,
            agent: "agy",
            detail: dialog.detail.slice(0, 200),
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
        askedAt: request.askedAt,
        requestId: request.requestId,
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
