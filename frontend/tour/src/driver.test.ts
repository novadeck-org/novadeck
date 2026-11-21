import { beginRun, coachNow, nextTick, stepRun, type TourRun } from "./driver"
import { noTeam, type LeadState, type TourSignals } from "./signals"
import { screenCoach, startStep, stepsOf, tourSteps, type TourStep } from "./steps"
import { context, describe, expect, it } from "./test"

const patience = 1_000

const signals = (
  lead: LeadState,
  onScreen = true,
  story: Partial<TourSignals> = {},
): TourSignals => ({
  lead,
  onScreen,
  ...noTeam,
  ...story,
})
// The lead's agent there: quiet by default, `working` on a turn, `named` once it described itself.
const agent = (named = false, working = false): TourSignals =>
  signals({ kind: "agent", working, named, answered: false })
const starting = signals({ kind: "starting" })

// Two steps: the start, then one waiting on the person.
const asked: TourStep = {
  id: "asked",
  act: 3,
  enter: [{ kind: "inbox" }],
  coach: { click: ["asking-row"], line: "Your call." },
  done: () => false,
  wait: "patient",
}
const steps = [startStep, asked]

const begin = (brief: TourRun["brief"] = "launch") =>
  beginRun({ terminalId: "t1", agent: "claude", brief }, 0)

// Feeds the run each event in turn, gathering what came of them.
const play = (run: TourRun, events: Parameters<typeof stepRun>[2][]) => {
  let current: TourRun | null = run
  const seen = []
  for (const event of events) {
    if (!current) break
    const outcome = stepRun(current, steps, event, patience)
    seen.push(outcome)
    current = outcome.run
  }
  return { run: current, seen }
}

describe("The tour's driver", () => {
  context("as a step begins", () => {
    it("makes its moves once, on screen, whatever the agent is doing", () => {
      const { seen } = play(begin(), [
        { type: "signals", signals: starting, now: 1 },
        { type: "signals", signals: agent(), now: 2 },
      ])
      expect(seen[0]!.moves).toEqual(startStep.enter)
      expect(seen[1]!.moves).toEqual([])
    })

    it("waits to make them while the tour's project isn't on screen", () => {
      const away = play(begin(), [
        { type: "signals", signals: signals({ kind: "starting" }, false), now: 1 },
      ])
      expect(away.seen[0]!.moves).toEqual([])
    })
  })

  context("with a lead whose launch line takes no first line", () => {
    it("rings it once its agent shows, past any screen of its own", () => {
      const { seen } = play(begin("doorbell"), [
        { type: "signals", signals: signals({ kind: "screen", screen: "startup" }), now: 1 },
        { type: "signals", signals: agent(), now: 2 },
        { type: "signals", signals: agent(), now: 3 },
      ])
      expect(seen.map(({ brief }) => brief)).toEqual([false, true, false])
    })

    it("rings it again at the next signal where the backend refused", () => {
      const { seen } = play(begin("doorbell"), [
        { type: "signals", signals: agent(), now: 1 },
        { type: "brief-failed" },
        { type: "signals", signals: agent(), now: 2 },
      ])
      expect(seen[2]!.brief).toBe(true)
    })
  })

  context("while it waits on the agent", () => {
    it("moves on once the step's signal comes, beginning the next at once", () => {
      const { run, seen } = play(begin(), [{ type: "signals", signals: agent(true), now: 1 }])
      expect(run).toMatchObject({ step: 1, nudged: false, entered: true })
      expect(seen[0]!.moves).toEqual(steps[1]!.enter)
    })

    it("nudges the agent once after its patience, then moves on after as long again", () => {
      const { seen, run } = play(begin(), [
        { type: "signals", signals: agent(), now: 0 },
        { type: "tick", signals: agent(), now: patience },
        { type: "tick", signals: agent(), now: patience + 10 },
        { type: "tick", signals: agent(), now: 2 * patience },
      ])
      expect(seen.map(({ nudge }) => nudge)).toEqual([false, true, false, false])
      expect(run?.step).toBe(1)
    })

    it("counts only while the agent is quiet: a long turn is no silence", () => {
      const { seen } = play(begin(), [
        { type: "signals", signals: agent(false, true), now: 0 },
        { type: "tick", signals: agent(false, true), now: 5 * patience },
        { type: "signals", signals: agent(), now: 5 * patience + 1 },
        { type: "tick", signals: agent(), now: 5 * patience + 500 },
      ])
      expect(seen.some(({ nudge }) => nudge)).toBe(false)
    })

    it("moves on once the agent's first turn ends, where it skipped describing itself", () => {
      const answered = signals({ kind: "agent", working: false, named: false, answered: true })
      const { run } = play(begin(), [{ type: "signals", signals: answered, now: 1 }])
      expect(run?.step).toBe(1)
    })

    it("counts only while the agent is there, starting over after a screen of its own", () => {
      const { seen } = play(begin(), [
        { type: "signals", signals: agent(), now: 0 },
        { type: "signals", signals: signals({ kind: "screen", screen: "sign-in" }), now: 900 },
        { type: "signals", signals: agent(), now: 1_200 },
        { type: "tick", signals: agent(), now: 1_500 },
      ])
      expect(seen.some(({ nudge }) => nudge)).toBe(false)
    })

    it("says when its wait ends, and nothing at a screen", () => {
      const run = { ...begin(), waitingSince: 50 }
      expect(nextTick(run, steps, agent(), patience)).toBe(1_050)
      expect(
        nextTick(run, steps, signals({ kind: "screen", screen: "hooks" }), patience),
      ).toBeNull()
    })
  })

  context("while it waits on the person", () => {
    it("waits as long as it takes, nudging no one", () => {
      const atAsk = { ...begin(), step: 1, entered: true }
      const outcome = stepRun(
        atAsk,
        steps,
        { type: "tick", signals: agent(true), now: 1e9 },
        patience,
      )
      expect(outcome).toMatchObject({ nudge: false, run: { step: 1 } })
      expect(nextTick(atAsk, steps, agent(true), patience)).toBeNull()
    })
  })

  context("as it ends", () => {
    it("keeps a run whose last step ends as its first line rings, to ring it again if refused", () => {
      const lastOnly = [startStep]
      const at = beginRun({ terminalId: "t1", agent: "agy", brief: "doorbell" }, 0)
      const done = stepRun(
        at,
        lastOnly,
        { type: "signals", signals: agent(true), now: 1 },
        patience,
      )
      expect(done).toMatchObject({ brief: true })
      expect(done.run).not.toBeNull()
      const refused = stepRun(done.run!, lastOnly, { type: "brief-failed" }, patience)
      const again = stepRun(
        refused.run!,
        lastOnly,
        { type: "signals", signals: agent(true), now: 2 },
        patience,
      )
      expect(again.brief).toBe(true)
    })

    it("ends when the person ends it", () => {
      expect(stepRun(begin(), steps, { type: "end" }, patience)).toMatchObject({
        run: null,
        end: "ended",
      })
    })
  })

  it("ends when its lead's terminal closes", () => {
    const outcome = stepRun(
      begin(),
      steps,
      { type: "signals", signals: signals({ kind: "gone" }), now: 1 },
      patience,
    )
    expect(outcome).toMatchObject({ run: null, end: "gone" })
  })

  context("in what it says", () => {
    it("coaches a screen of the agent's own first, whatever the step", () => {
      const run = { ...begin(), step: 1 }
      expect(coachNow(run, steps, signals({ kind: "screen", screen: "sign-in" }))).toEqual(
        screenCoach("sign-in", "claude"),
      )
    })

    it("says each screen's own words", () => {
      expect(screenCoach("sign-in", "claude").note).toMatch(/sign in/)
      expect(screenCoach("startup", "agy").note).toMatch(/trust the tour's folder/)
    })

    it("says what each harness's hooks being off asks of the person", () => {
      expect(screenCoach("hooks", "codex").note).toMatch(/Trust all and continue/)
      expect(screenCoach("hooks", "claude").note).toMatch(/its settings/)
      expect(screenCoach("hooks", "agy").note).not.toMatch(/\/hooks/)
    })

    it("says what its step says otherwise", () => {
      expect(coachNow(begin(), steps, agent())).toBe(startStep.coach)
      expect(coachNow(begin(), steps, signals({ kind: "ended" }))?.line).toBe("Your agent stopped.")
    })
  })
})

describe("The tour's story", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const at = () => beginRun({ terminalId: "t1", agent: "claude", brief: "launch" }, 0)
  const atStep = (id: string): TourRun => ({
    ...at(),
    step: tourSteps.findIndex((step) => step.id === id),
    entered: true,
  })
  const feed = (run: TourRun, story: Partial<TourSignals>) =>
    stepRun(
      run,
      tourSteps,
      { type: "signals", signals: signals(quiet, true, story), now: 1 },
      patience,
    )

  const stepNo = (id: string): number => tourSteps.findIndex((step) => step.id === id)

  it("opens in Canvas on its lead, and frames the team as it comes", () => {
    expect(tourSteps[0]!.enter).toEqual([{ kind: "view", view: "canvas" }, { kind: "reveal" }])
    expect(feed({ ...atStep("hire"), entered: false }, {}).moves).toEqual([{ kind: "fit-all" }])
    expect(tourSteps.filter(({ frameTeam }) => frameTeam).map(({ id }) => id)).toEqual(["hire"])
  })

  it("plays four acts, in order", () => {
    expect(tourSteps.map(({ id, act }) => [id, act])).toEqual([
      ["start", 1],
      ["hire", 2],
      ["yours", 2],
      ["ask", 3],
      ["make", 3],
      ["result", 4],
      ["merged", 4],
    ])
  })

  it("leaves out the person's own step where the backend can't start the second fixer", () => {
    expect(stepsOf(true)).toBe(tourSteps)
    expect(stepsOf(false).map(({ id }) => id)).toEqual([
      "start",
      "hire",
      "ask",
      "make",
      "result",
      "merged",
    ])
  })

  // A step done in moments stays a while, for its caption to be read, then the run moves on.
  const heldThen = (id: string, story: Partial<TourSignals>) => {
    const done = feed(atStep(id), story)
    const later = (now: number) =>
      stepRun(
        done.run!,
        tourSteps,
        { type: "tick", signals: signals(quiet, true, story), now },
        patience,
      ).run
    return { done: done.run, during: later(2_000), after: later(3_001) }
  }

  it("waits for the fixer to be there and named, then stays a moment", () => {
    expect(feed(atStep("hire"), { team: { count: 1, named: 0 } }).run?.step).toBe(stepNo("hire"))
    const { done, during, after } = heldThen("hire", { team: { count: 1, named: 1 } })
    expect(done).toMatchObject({ step: stepNo("hire"), doneAt: 1 })
    expect(during?.step).toBe(stepNo("hire"))
    expect(after?.step).toBe(stepNo("yours"))
  })

  it("waits on the person to open a terminal, as long as they take", () => {
    const run = { ...atStep("yours"), waitingSince: 0 }
    const one = signals(quiet, true, { team: { count: 1, named: 1 } })
    expect(
      stepRun(run, tourSteps, { type: "tick", signals: one, now: patience * 10 }, patience),
    ).toMatchObject({ run: { step: stepNo("yours") }, nudge: false })
    expect(nextTick(run, tourSteps, one, patience)).toBeNull()
    // Two teammates are not it: the person's own terminal has to have joined.
    expect(feed(run, { team: { count: 2, named: 1 } }).run?.step).toBe(stepNo("yours"))
    expect(feed(run, { team: { count: 1, named: 1 }, adopted: true }).run?.step).toBe(stepNo("ask"))
  })

  it("brings the Terminals panel, then the Files panel, as those steps begin", () => {
    expect(feed({ ...atStep("yours"), entered: false }, {}).moves).toEqual([
      { kind: "reveal", panel: "terminals" },
      { kind: "fit-all" },
    ])
    expect(feed({ ...atStep("result"), entered: false }, {}).moves).toEqual([
      { kind: "reveal", panel: "files" },
      { kind: "fit-all" },
    ])
  })

  it("takes a question gone from the Inbox, once seen, as the person's answer", () => {
    const asking = feed(atStep("ask"), { asking: true })
    expect(asking.run).toMatchObject({ step: stepNo("ask"), asked: true })
    const answered = feed(asking.run!, { asking: false })
    expect(answered.run?.step).toBe(stepNo("make"))
  })

  it("counts a question the person answered before its step came", () => {
    const early = feed(atStep("yours"), { asking: true, team: { count: 1, named: 1 } })
    const passed = feed({ ...early.run!, step: stepNo("ask"), entered: true }, { asking: false })
    expect(passed.run?.step).toBe(stepNo("make"))
  })

  it("nudges no one while the person has a question to answer", () => {
    const asking = feed(atStep("ask"), { asking: true }).run!
    expect(nextTick(asking, tourSteps, signals(quiet, true, { asking: true }), patience)).toBeNull()
  })

  it("nudges the lead while the question hasn't come", () => {
    const run = { ...atStep("ask"), waitingSince: 0 }
    expect(nextTick(run, tourSteps, signals(quiet), patience)).toBe(patience)
  })

  it("waits, once answered, for both fixers to have reported, then stays a moment", () => {
    const team = { count: 2, named: 2 }
    expect(feed(atStep("make"), { team, fixed: 1 }).run?.doneAt).toBeNull()
    expect(feed(atStep("make"), { team, fixed: 2 }).run).toMatchObject({
      step: stepNo("make"),
      doneAt: 1,
    })
    // With one fixer only, its report is enough.
    const alone = { team: { count: 1, named: 1 } }
    expect(feed(atStep("make"), { ...alone, fixed: 1 }).run?.doneAt).toBe(1)
    expect(feed(atStep("make"), { ...alone, fixed: 0 }).run?.doneAt).toBeNull()
    expect(heldThen("make", { team, fixed: 2 }).after?.step).toBe(stepNo("result"))
  })

  it("waits on the person to open the file, then looks at its preview", () => {
    expect(feed(atStep("result"), {}).run?.step).toBe(stepNo("result"))
    expect(feed(atStep("result"), { preview: { windowId: "w1" } }).run?.step).toBe(stepNo("merged"))
  })

  it("holds on the preview once it's open", () => {
    expect(feed(atStep("merged"), { preview: { windowId: "w1" } }).run).toMatchObject({
      step: stepNo("merged"),
      doneAt: 1,
    })
  })
})

describe("The tour, with a teammate at a screen of its own", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const held = signals(quiet, true, {
    teamScreen: { terminalId: "t3", screen: "startup", program: "codex" },
  })
  const run = { ...beginRun({ terminalId: "t1", agent: "claude", brief: "launch" }, 0), step: 1 }

  it("points at that teammate, in its harness's words", () => {
    expect(coachNow(run, tourSteps, held)).toMatchObject({
      line: "A teammate wants an answer first.",
      terminalId: "t3",
      click: ["terminal"],
    })
  })

  it("nudges no one while it holds", () => {
    expect(nextTick(run, tourSteps, held, patience)).toBeNull()
  })

  it("takes the person's answer from the messages, the question gone or not", () => {
    const atAsk = { ...run, step: tourSteps.findIndex(({ id }) => id === "ask"), entered: true }
    const outcome = stepRun(
      atAsk,
      tourSteps,
      { type: "signals", signals: signals(quiet, true, { answered: true }), now: 1 },
      patience,
    )
    expect(tourSteps[outcome.run!.step]!.id).toBe("make")
  })
})

describe("The tour, with an agent asking the person's permission", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const wanted = signals(quiet, true, { permission: { terminalId: "t3" } })
  const run = { ...beginRun({ terminalId: "t1", agent: "claude", brief: "launch" }, 0), step: 1 }

  it("points at that agent's terminal, in a person's words", () => {
    expect(coachNow(run, tourSteps, wanted)).toMatchObject({
      line: "It's asking your permission.",
      terminalId: "t3",
      click: ["terminal"],
    })
    expect(coachNow(run, tourSteps, wanted)?.note).toContain("in its terminal")
  })

  it("lets a screen of the agent's own come first", () => {
    const screen = signals({ kind: "screen", screen: "startup" }, true, {
      permission: { terminalId: "t3" },
    })
    expect(coachNow(run, tourSteps, screen)?.line).toBe("It wants an answer first.")
  })

  it("counts no wait while it asks: no nudge, and none right after", () => {
    expect(nextTick(run, tourSteps, wanted, patience)).toBeNull()
    const waited = stepRun(
      run,
      tourSteps,
      { type: "tick", signals: wanted, now: patience * 3 },
      patience,
    )
    expect(waited.nudge).toBe(false)
    expect(waited.run!.step).toBe(run.step)
    expect(waited.run!.waitingSince).toBe(patience * 3)
  })

  it("goes back to the step's own coach once it is answered", () => {
    expect(coachNow(run, tourSteps, signals(quiet))).toBe(tourSteps[1]!.coach)
  })
})

describe("The tour's last act", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const atMerged: TourRun = {
    ...beginRun({ terminalId: "t1", agent: "claude", brief: "launch" }, 0),
    step: tourSteps.findIndex(({ id }) => id === "merged"),
  }
  const shown = signals(quiet, true, { preview: { windowId: "w1" } })

  it("holds on the merged preview a while, then the story ends", () => {
    const held = stepRun(
      atMerged,
      tourSteps,
      { type: "signals", signals: shown, now: 100 },
      patience,
    )
    expect(held.run).toMatchObject({ doneAt: 100, entered: true })
    expect(coachNow(held.run!, tourSteps, shown)?.line).toBe("Two agents. One file. Merged live.")
    expect(nextTick(held.run!, tourSteps, shown, patience)).toBe(6_100)
    const still = stepRun(
      held.run!,
      tourSteps,
      { type: "tick", signals: shown, now: 3_000 },
      patience,
    )
    expect(still.run).toMatchObject({ doneAt: 100 })
    const over = stepRun(
      held.run!,
      tourSteps,
      { type: "tick", signals: shown, now: 6_100 },
      patience,
    )
    expect(over).toMatchObject({ run: null, end: "done" })
  })
})
