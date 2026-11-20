import { awaitsNext, beginRun, coachNow, nextTick, stepRun, type TourRun } from "./driver"
import { noTeam, type LeadState, type TourSignals } from "./signals"
import { screenCoach, startStep, tourSteps, type TourStep } from "./steps"
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
  enter: [{ kind: "inbox" }],
  coach: { anchor: "inbox", title: "A teammate asks you", body: "Answer it." },
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

    it("waits to make them while the tour's project isn't on screen, or it is paused", () => {
      const away = play(begin(), [
        { type: "signals", signals: signals({ kind: "starting" }, false), now: 1 },
      ])
      expect(away.seen[0]!.moves).toEqual([])
      const paused = play(begin(), [
        { type: "pause" },
        { type: "signals", signals: starting, now: 1 },
      ])
      expect(paused.seen[1]!.moves).toEqual([])
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

    it("says when its wait ends, and nothing while paused or at a screen", () => {
      const run = { ...begin(), waitingSince: 50 }
      expect(nextTick(run, steps, agent(), patience)).toBe(1_050)
      expect(nextTick({ ...run, paused: true }, steps, agent(), patience)).toBeNull()
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

  context("as the person steers it", () => {
    it("pauses and resumes, starting its wait over", () => {
      const { run } = play(begin(), [{ type: "pause" }, { type: "resume", now: 77 }])
      expect(run).toMatchObject({ paused: false, waitingSince: 77 })
    })

    it("rings a doorbell's first line even past a skipped last step, then ends", () => {
      const lastOnly = [startStep]
      const at = beginRun({ terminalId: "t1", agent: "agy", brief: "doorbell" }, 0)
      const skipped = stepRun(at, lastOnly, { type: "skip", now: 1 }, patience)
      expect(skipped.run).not.toBeNull()
      const rung = stepRun(
        skipped.run!,
        lastOnly,
        { type: "signals", signals: agent(), now: 2 },
        patience,
      )
      expect(rung).toMatchObject({ brief: true, run: { briefed: true } })
      const after = stepRun(
        rung.run!,
        lastOnly,
        { type: "signals", signals: agent(), now: 3 },
        patience,
      )
      expect(after).toMatchObject({ run: null, end: "done" })
    })

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

    it("skips a step, and ends after the last", () => {
      const { run, seen } = play(begin(), [
        { type: "skip", now: 1 },
        { type: "skip", now: 2 },
      ])
      expect(run).toBeNull()
      expect(seen.at(-1)!.end).toBe("done")
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
      expect(screenCoach("sign-in", "claude").body).toMatch(/sign in/)
      expect(screenCoach("startup", "agy").body).toMatch(/trust the tour's folder/)
    })

    it("says what each harness's hooks being off asks of the person", () => {
      expect(screenCoach("hooks", "codex").body).toMatch(/Trust all and continue/)
      expect(screenCoach("hooks", "claude").body).toMatch(/its settings/)
      expect(screenCoach("hooks", "agy").body).not.toMatch(/\/hooks/)
    })

    it("says what its step says otherwise, and nothing while paused", () => {
      expect(coachNow(begin(), steps, agent())).toBe(startStep.coach)
      expect(coachNow({ ...begin(), paused: true }, steps, agent())).toBeNull()
      expect(coachNow(begin(), steps, signals({ kind: "ended" }))?.title).toBe("Your agent stopped")
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

  it("waits for both teammates to be there and named", () => {
    expect(feed(atStep("team"), { team: { count: 2, named: 1 } }).run?.step).toBe(1)
    expect(feed(atStep("team"), { team: { count: 2, named: 2 } }).run?.step).toBe(2)
  })

  it("waits for the team to talk", () => {
    expect(feed(atStep("talk"), { talks: 1 }).run?.step).toBe(2)
    expect(feed(atStep("talk"), { talks: 2 }).run?.step).toBe(3)
  })

  it("takes a question gone from the Inbox, once seen, as the person's answer", () => {
    const asking = feed(atStep("ask"), { asking: true })
    expect(asking.run).toMatchObject({ step: 3, asked: true })
    const answered = feed(asking.run!, { asking: false })
    expect(answered.run?.step).toBe(4)
  })

  it("counts a question the person answered before its step came", () => {
    const early = feed(atStep("talk"), { asking: true })
    const passed = feed({ ...early.run!, step: 3, entered: true }, { asking: false })
    expect(passed.run?.step).toBe(4)
  })

  it("nudges no one while the person has a question to answer", () => {
    const asking = feed(atStep("ask"), { asking: true }).run!
    expect(nextTick(asking, tourSteps, signals(quiet, true, { asking: true }), patience)).toBeNull()
  })

  it("nudges the lead while the question hasn't come", () => {
    const run = { ...atStep("ask"), waitingSince: 0 }
    expect(nextTick(run, tourSteps, signals(quiet), patience)).toBe(patience)
  })

  it("moves on once the lead shows its card", () => {
    expect(feed(atStep("show"), { shown: true }).run?.step).toBe(5)
  })

  it("frames every window as Canvas comes", () => {
    const outcome = feed({ ...atStep("canvas"), entered: false }, {})
    expect(outcome.moves).toEqual([{ kind: "view", view: "canvas" }, { kind: "fit-all" }])
  })

  it("shows the views until the person's Next, and ends after the last", () => {
    const grid = atStep("grid")
    expect(awaitsNext(grid, tourSteps)).toBe(true)
    expect(nextTick(grid, tourSteps, signals(quiet), patience)).toBeNull()
    const canvas = stepRun(grid, tourSteps, { type: "next", now: 2 }, patience).run!
    expect(canvas.step).toBe(6)
    expect(stepRun(canvas, tourSteps, { type: "next", now: 3 }, patience)).toMatchObject({
      run: null,
      end: "done",
    })
  })

  it("takes no Next on a step that waits on the agent", () => {
    const team = atStep("team")
    expect(stepRun(team, tourSteps, { type: "next", now: 1 }, patience).run).toBe(team)
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
      title: "A teammate is asking you something first",
      terminalId: "t3",
      anchor: "terminal",
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
    expect(tourSteps[outcome.run!.step]!.id).toBe("show")
  })
})

describe("The tour, with an agent asking the person's permission", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const wanted = signals(quiet, true, { permission: { terminalId: "t3" } })
  const run = { ...beginRun({ terminalId: "t1", agent: "claude", brief: "launch" }, 0), step: 1 }

  it("points at that agent's terminal, in a person's words", () => {
    expect(coachNow(run, tourSteps, wanted)).toMatchObject({
      title: "Your agent is asking your permission",
      terminalId: "t3",
      anchor: "terminal",
    })
    expect(coachNow(run, tourSteps, wanted)?.body).toContain("in its terminal")
  })

  it("lets a screen of the agent's own come first, and says nothing while paused", () => {
    const screen = signals({ kind: "screen", screen: "startup" }, true, {
      permission: { terminalId: "t3" },
    })
    expect(coachNow(run, tourSteps, screen)?.title).toBe("Your agent is asking you something first")
    expect(coachNow({ ...run, paused: true }, tourSteps, wanted)).toBeNull()
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
