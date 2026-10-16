import type { TerminalMetadata, Workspace } from "../../../model/types"
import type { Backend, BackendSink, TerminalKey } from "../../port"
import { demoHandle } from "../handles"
import { demoAgent, demoTerminalId } from "../samples"
import { createShowcase } from "../showcase/simulation"
import { orderSummary } from "../showcase/storefront"
import { terminalOf } from "../terminals"
import type { DemoTranscript } from "../transcripts"
import type { DemoTurns, TurnEvent } from "../turns"

// What happens on the visitor's desk, one step at a time, and only once the visitor has
// dealt with what asks for them: nothing new turns up while something waits. Claude Code
// waits on its plan from the start, after a few seconds at its reading where the desk opens
// that way, so something moves as the visitor first looks. Once its turn after the answer ends, it shows a
// preview of the page it built, if the plan was approved; a moment later Codex, which
// was reviewing all along, asks to run the checkout tests. Answered, it finishes, and
// nothing else comes: the desk stays quiet.

const session = { projectId: "storefront", workspaceSessionId: "initial" }
const claude: TerminalKey = { ...session, terminalId: demoTerminalId(session, 1) }
const codex: TerminalKey = { ...session, terminalId: demoTerminalId(session, 4) }

// How long Codex takes to ask after Claude Code's turn ends, in milliseconds.
const visitorNudgeMs = 5000

// How long Claude Code reads before it asks for its plan to be reviewed, in milliseconds:
// long enough to see it work once the app is shown, which comes about two seconds after it
// boots, and short enough not to keep the visitor waiting (see `readOpensMs`).
export const visitorReadingMs = 5000

const same = (a: TerminalKey, b: TerminalKey): boolean =>
  a.projectId === b.projectId &&
  a.workspaceSessionId === b.workspaceSessionId &&
  a.terminalId === b.terminalId

// Whether any agent on the desk waits on the visitor.
const asking = (workspace: Workspace): boolean =>
  workspace.projects.some((project) =>
    project.history.some((each) =>
      each.state.roster.terminals.some(
        (terminal) => terminal.state === "running" && terminal.agent?.attention !== undefined,
      ),
    ),
  )

// Claude Code as the desk opened it with its plan still to come: working in plan mode, asking
// nothing, not stopped or prompted.
const reading = (terminal: TerminalMetadata | undefined): terminal is TerminalMetadata =>
  terminal?.state === "running" &&
  demoAgent(terminal) === "claude" &&
  terminal.agent?.planning === true &&
  terminal.agent.working &&
  terminal.agent.attention === undefined

// Still at work and asking nothing: Codex as the desk opened, not stopped or prompted.
export const reviewing = (terminal: TerminalMetadata | undefined): terminal is TerminalMetadata =>
  terminal?.state === "running" &&
  demoAgent(terminal) === "codex" &&
  terminal.agent?.working === true &&
  terminal.agent.attention === undefined

export const visitorStory = (
  agentTranscripts: Readonly<Record<string, DemoTranscript>>,
  turns: DemoTurns,
  nudgeMs = visitorNudgeMs,
  // How long Claude Code reads before its plan comes, where the desk opens that way (see
  // `visitorSeed`); none where it asks from the start.
  readingMs = 0,
) => {
  let approved = false
  // Approving Claude Code's plan has it build the cart summary and show a preview of it.
  const planned = agentTranscripts["01"]!
  const review = agentTranscripts["04"]!
  const transcripts: Readonly<Record<string, DemoTranscript>> = {
    "01": {
      ...planned,
      outcomes: {
        "01:plan": (answer, dialog) => {
          const outcome = planned.outcomes!["01:plan"]!(answer, dialog)
          if (!("reply" in outcome) || (answer.type === "choice" && answer.option === "3"))
            return outcome
          approved = true
          return {
            ...outcome,
            reply:
              "Step one is done: the cart summary is in `src/cart/CartSummary.tsx`. I've shown you a preview of the page.",
          }
        },
      },
    },
    // Codex's review, without the terminal it opened, which this desk doesn't have, and
    // without the test run it asks for: allowed to, it runs the checkout tests then, as its
    // screen tells a command, and reports.
    "04": {
      ...review,
      items: review.items.filter((item) => item.call !== "call_04n" && item.call !== "call_04d"),
      outcomes: {
        "04:permission": (answer, dialog) => {
          const outcome = review.outcomes!["04:permission"]!(answer, dialog)
          if (!("reply" in outcome)) return outcome
          return {
            items: [
              {
                role: "assistant",
                kind: "tool-call",
                tool: "Ran",
                call: "call_04d",
                text: JSON.stringify({ command: "pnpm test --filter checkout" }),
              },
              {
                role: "tool",
                kind: "tool-result",
                call: "call_04d",
                text: "Test Files 3 passed · Tests 41 passed",
              },
            ],
            reply:
              "No regressions found. The total updates with quantity changes, an empty cart disables checkout, and the checkout tests pass.",
          }
        },
      },
    },
  }
  const showcase = createShowcase({
    agents: [],
    shown: [{ key: claude, handle: demoHandle(1), artifacts: [orderSummary] }],
  })

  const wrap = (backend: Backend): Backend => {
    let sink: BackendSink | undefined
    let latest: Workspace | undefined
    // The steps still to come: Claude Code's turn to end, then Codex to ask.
    let step: "plan" | "nudge" | "review" | "done" = "plan"
    let timer: ReturnType<typeof setTimeout> | undefined
    let planTimer: ReturnType<typeof setTimeout> | undefined
    // Codex asks once nothing else does, as long as it still reviews.
    const nudge = (): void => {
      if (step !== "review" || !latest || asking(latest)) return
      step = "done"
      const terminal = terminalOf(latest, codex)
      if (reviewing(terminal)) turns.ask(codex, terminal, "permission", 1)
    }
    // Claude Code's plan comes, if it is still at its reading: the visitor may have stopped
    // it, and the commit that opened the desk may not have come yet.
    const plan = (): void => {
      if (!latest) {
        planTimer = setTimeout(plan, 100)
        return
      }
      const terminal = terminalOf(latest, claude)
      if (reading(terminal)) turns.ask(claude, terminal, "plan", 1)
    }
    const heard = (event: TurnEvent): void => {
      if (step !== "plan" || event.type !== "end" || !same(event.key, claude)) return
      // However the visitor dealt with the plan, answering it or stopping Claude Code, the
      // story goes on; only a build that ran to its end has a page to show.
      step = "nudge"
      if (approved && event.outcome === "completed") {
        const [item] = showcase.items
        sink?.dispatch([
          { type: "item/upsert", target: session, item: { ...item!, shownAt: Date.now() } },
        ])
      }
      wait()
    }
    // Codex's turn to ask comes a moment later, as if it had been reviewing meanwhile.
    const wait = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        step = "review"
        nudge()
      }, nudgeMs)
    }
    return {
      ...backend,
      companions: showcase,
      commit: (workspace, actions) => {
        backend.commit(workspace, actions)
        latest = workspace
        // Once the commit is done: asking is a commit of its own.
        if (step === "review") queueMicrotask(nudge)
      },
      start: (next) => {
        sink = next
        const stop = backend.start?.(next)
        const unwatch = turns.watch(heard)
        if (readingMs > 0 && Number.isFinite(readingMs) && step === "plan")
          planTimer = setTimeout(plan, readingMs)
        // Stopped while Codex was about to ask: it asks once started again.
        if (step === "nudge") wait()
        return () => {
          stop?.()
          unwatch()
          clearTimeout(timer)
          clearTimeout(planTimer)
          if (sink === next) sink = undefined
        }
      },
    }
  }
  return { transcripts, wrap }
}
