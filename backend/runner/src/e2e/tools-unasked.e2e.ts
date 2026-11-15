import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool, type Call } from "./model/script.js"
import {
  deliveries,
  opened,
  opens,
  own,
  prompted,
  replies,
  result,
  start,
  turn,
} from "./scenarios.js"

// Novadeck's own tools run without the harness asking, however its session started: typed in
// a terminal, opened by another agent with a task, resumed as the runner restarts, and resumed
// from History. No seed allows them (see agents/), so only Novadeck's shims do, adding the
// allow afresh at each start and resume (docs/harness-adapters.md, "Shims and the worktrees
// folder"). An asked tool shows the harness's own dialog, which nothing here answers, so its
// result never reaches the model. The same for every harness (see messaging.e2e.ts for the
// rule on parity).

/** Whether the call's latest turn asks, as a prompt or a delivered task, to describe as `word`. */
const wants = (call: Call, word: string): boolean => {
  const ask = `Describe this terminal as ${word}`
  return asked(call, ask) || deliveries(call).some(({ text }) => text.includes(ask))
}

/**
 * Answers a request to describe as `word` with `describe`, then says so once it ran: its
 * result first, as a task delivered beside the prompt stays in the turn the result ends.
 */
const describing = (word: string) => [
  own((call) =>
    result(call)?.includes("Described this terminal")
      ? { text: `Described as ${word}, unasked.` }
      : undefined,
  ),
  own((call) => {
    const describeIt = tool(call, "describe")
    return describeIt && wants(call, word)
      ? { calls: [{ name: describeIt, input: { title: word, summary: `About ${word}.` } }] }
      : undefined
  }),
]

/** Has the terminal's agent describe it as `word`, which only a tool that ran unasked titles. */
const describeAs = async (terminal: DeckTerminal, word: string): Promise<void> => {
  await terminal.submit(`Describe this terminal as ${word}`)
  await terminal.until(`Described as ${word}, unasked.`, 30_000)
  expect(terminal.summary().title).toBe(word)
}

for (const setup of setups) {
  describe.skipIf(!supported)(`Novadeck's tools unasked in ${setup.name}`, () => {
    const it = e2e(setup)

    it("runs them in a session typed in its terminal", async ({ e2e: run }) => {
      run.model.use(...describing("heron"))
      const t1 = await start(run, setup)
      await describeAs(t1, "heron")
    })

    it("runs them in a session another agent opened with a task", async ({ e2e: run }) => {
      const requests = run.deck.answerRequests()
      run.model.use(
        opens("Start a describer", setup.agent, "Describe this terminal as egret"),
        own((call) => (opened(call, "fox") ? { text: "Started fox." } : undefined)),
        ...describing("egret"),
      )
      const t1 = await start(run, setup)
      await t1.submit("Start a describer")
      const t2 = await requests.next()
      await t2.until("Described as egret, unasked.", 60_000)
      expect(t2.summary().title).toBe("egret")
      await t1.until("Started fox.")
    })

    it("runs them in a session resumed as the runner restarts", async ({ e2e: run }) => {
      run.model.use(replies("Remember the word osprey", "Osprey noted."), ...describing("osprey"))
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word osprey", "Osprey noted.")
      await run.deck.restart()
      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      await describeAs(resumed, "osprey")
    })

    it("runs them in a session resumed from History", async ({ e2e: run }) => {
      run.model.use(replies("Remember the word plover", "Plover noted."), ...describing("plover"))
      const { terminals, store } = run.deck
      const projectId = store.session(run.deck.sessionId).projectId
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word plover", "Plover noted.")
      await expect.poll(() => t1.summary().restorable, { timeout: 30_000 }).toBe(true)
      await terminals.close({ terminalId: t1.id })
      const [row] = store.closed(projectId)
      const restored = await run.deck.restoreClosed(row!.id)
      await restored.reached("ready", { timeoutMs: 60_000 })
      await prompted(restored, setup, 30_000)
      await describeAs(restored, "plover")
    })
  })
}
