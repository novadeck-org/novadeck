import {
  beginRun,
  coachNow,
  captionWaitMs,
  declineMs,
  nextTick,
  showAgain,
  stepRun,
  stepsFor as stepsOfRun,
  type TourRun,
} from "./driver"
import { noTeam, type LeadState, type TourSignals } from "./signals"
import { screenCoach, startStep, stepsOf, tourSteps, type TourStep } from "./steps"
import { context, describe, expect, it } from "./test"
import { readTourRun } from "./useTourDriver"

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
  show: [{ kind: "travel" }],
  coach: { click: ["asking-row"], line: "Your call." },
  done: () => false,
  wait: "patient",
}
const steps = [startStep, asked]

const begin = (brief: TourRun["brief"] = "launch") =>
  beginRun({ terminalId: "t1", agent: "claude", brief, command: "claude", page: true }, 0)

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
    it("moves nothing of its own: what follows from an event has no moves or tab", () => {
      const { seen } = play(begin(), [
        { type: "signals", signals: starting, now: 1 },
        { type: "signals", signals: agent(true), now: 2 },
        { type: "tick", signals: agent(true), now: 2 + captionWaitMs + 4_000 },
      ])
      for (const outcome of seen) {
        expect(outcome).not.toHaveProperty("moves")
        expect(outcome).not.toHaveProperty("tab")
      }
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
      // It holds first, for its caption (which never shows here): then the next step begins.
      const { run, seen } = play(begin(), [
        { type: "signals", signals: agent(true), now: 1 },
        { type: "tick", signals: agent(true), now: 1 + captionWaitMs + 4_000 },
      ])
      expect(seen[0]!.run).toMatchObject({ step: 0, doneAt: 1 })
      expect(run).toMatchObject({ step: 1, nudged: false })
    })

    it("nudges the agent once after its patience, then moves on after as long again", () => {
      const { seen, run } = play(begin(), [
        { type: "signals", signals: agent(), now: 0 },
        { type: "tick", signals: agent(), now: patience },
        { type: "tick", signals: agent(), now: patience + 10 },
        { type: "tick", signals: agent(), now: 2 * patience },
      ])
      expect(seen.map(({ nudge }) => nudge)).toEqual([null, "t1", null, null])
      expect(run?.step).toBe(1)
    })

    it("counts only while the agent is quiet: a long turn is no silence", () => {
      const { seen } = play(begin(), [
        { type: "signals", signals: agent(false, true), now: 0 },
        { type: "tick", signals: agent(false, true), now: 5 * patience },
        { type: "signals", signals: agent(), now: 5 * patience + 1 },
        { type: "tick", signals: agent(), now: 5 * patience + 500 },
      ])
      expect(seen.some(({ nudge }) => nudge !== null)).toBe(false)
    })

    it("moves on once the agent's first turn ends, where it skipped describing itself", () => {
      const answered = signals({ kind: "agent", working: false, named: false, answered: true })
      const { run } = play(begin(), [
        { type: "signals", signals: answered, now: 1 },
        { type: "tick", signals: answered, now: 1 + captionWaitMs + 4_000 },
      ])
      expect(run?.step).toBe(1)
    })

    it("counts only while the agent is there, starting over after a screen of its own", () => {
      const { seen } = play(begin(), [
        { type: "signals", signals: agent(), now: 0 },
        { type: "signals", signals: signals({ kind: "screen", screen: "sign-in" }), now: 900 },
        { type: "signals", signals: agent(), now: 1_200 },
        { type: "tick", signals: agent(), now: 1_500 },
      ])
      expect(seen.some(({ nudge }) => nudge !== null)).toBe(false)
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
      expect(outcome).toMatchObject({ nudge: null, run: { step: 1 } })
      expect(nextTick(atAsk, steps, agent(true), patience)).toBeNull()
    })
  })

  context("as it ends", () => {
    it("keeps a run whose last step ends as its first line rings, to ring it again if refused", () => {
      const lastOnly = [startStep]
      const at = beginRun(
        { terminalId: "t1", agent: "agy", brief: "doorbell", command: "agy", page: true },
        0,
      )
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
        screenCoach("sign-in"),
      )
    })

    it("says each screen's own words", () => {
      expect(screenCoach("sign-in").note).toMatch(/its own question/)
      expect(screenCoach("startup").note).toMatch(/its own question/)
      expect(screenCoach("hooks").note).toMatch(/until that's answered/)
    })

    it("says what its step says otherwise", () => {
      expect(coachNow(begin(), steps, agent())).toBe(startStep.coach)
      expect(coachNow(begin(), steps, signals({ kind: "ended" }))?.line).toBe(
        "Your agent stopped. Ugh. Rude.",
      )
    })
  })
})

describe("The tour's story", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const cast = { lead: "t1", modeller: "t2", builder: "t3" }
  // Signals with the whole cast found and nothing yet done, changed by `story`.
  const world = (story: Partial<TourSignals> = {}): TourSignals =>
    signals(quiet, true, {
      roles: cast,
      team: { count: 0, named: 0, ids: [], reported: 0, working: false },
      ...story,
    })
  const bare = (story: Partial<TourSignals> = {}): TourSignals =>
    signals(quiet, true, { roles: { lead: "t1" }, ...story })
  const item = (id: string) => id as TourSignals["shown"]["page"]
  const sheet = (asking: boolean, answered = false): Partial<TourSignals> => ({
    sheet: { asking, row: asking ? "r1" : null, answered },
  })
  const everything: Partial<TourSignals> = {
    served: true,
    ...sheet(false, true),
    changed: { models: true, game: true },
    shown: { page: item("page"), model: item("model"), changes: item("diff") },
  }
  const at = (page = true): TourRun =>
    beginRun(
      { terminalId: "t1", agent: "claude", brief: "launch", command: "claude --model haiku", page },
      0,
    )
  const stepsFor = (run: TourRun) => stepsOfRun(run)
  const idAt = (run: TourRun) => stepsFor(run)[run.step]?.id
  const atStep = (id: string, page = true): TourRun => {
    const run = at(page)
    return { ...run, step: stepsFor(run).findIndex((step) => step.id === id) }
  }
  const feed = (run: TourRun, now1: TourSignals, now = 1) =>
    stepRun(run, stepsFor(run), { type: "signals", signals: now1, now }, patience)
  const tick = (run: TourRun, now1: TourSignals, now: number) =>
    stepRun(run, stepsFor(run), { type: "tick", signals: now1, now }, patience)
  // The person touches what the run's step shows, its caption on screen.
  const touch = (run: TourRun, now1: TourSignals, now: number, line?: string) =>
    stepRun(
      run,
      stepsFor(run),
      { type: "touched", line: line ?? stepsFor(run)[run.step]!.coach.line, signals: now1, now },
      patience,
    )

  it("plays four acts, in order", () => {
    expect(tourSteps.map(({ id, act }) => [id, act])).toEqual([
      ["start", 1],
      ["ask", 2],
      ["run", 2],
      ["page", 3],
      ["team", 3],
      ["shape", 3],
      ["files", 3],
      ["diff", 3],
      ["finish", 3],
      ["play", 4],
    ])
  })

  it("leaves out the run and the page where this computer has no way to serve it", () => {
    expect(stepsOf(true)).toBe(tourSteps)
    expect(stepsOf(false).map(({ id }) => id)).toEqual([
      "start",
      "ask",
      "team",
      "shape",
      "files",
      "diff",
      "finish",
      "play",
    ])
  })

  // Plays a run through the world's stages, each state kept as the next comes: the run's step
  // after each, with the clock moved past any hold.
  const through = (page: boolean, stages: Partial<TourSignals>[]) => {
    let run: TourRun | null = at(page)
    let now = 0
    let state: Partial<TourSignals> = {}
    const after: string[] = []
    let end: string | undefined
    for (const stage of stages) {
      if (!run) break
      state = { ...state, ...stage }
      now += 1
      let outcome = feed(run, world(state), now)
      run = outcome.run
      // A step done holds a while, or until the person touches what it shows: the clock moves
      // past it, or they touch it.
      for (let turns = 0; turns < 3 && run && typeof run.doneAt === "number"; turns += 1) {
        const step = stepsFor(run)[run.step]
        now += step?.person && run.touched === null ? 1 : 60_000
        outcome =
          step?.person && run.touched === null
            ? touch(run, world(state), now)
            : tick(run, world(state), now)
        run = outcome.run
      }
      end = outcome.end ?? end
      after.push(run ? (idAt(run) ?? "end") : "end")
    }
    return { after, end }
  }
  const named = { team: { count: 2, named: 2, ids: ["t2", "t3"], reported: 0, working: false } }
  const reported = { team: { count: 2, named: 2, ids: ["t2", "t3"], reported: 2, working: false } }
  const showing = (part: Partial<TourSignals["shown"]>): Partial<TourSignals> => ({
    shown: { ...world().shown, ...part },
  })

  it("plays the whole story in order, as the agents do it", () => {
    // After each stage of the world, the step the run is at.
    const { after, end } = through(true, [
      {},
      sheet(true),
      sheet(false, true),
      { approving: true },
      { approving: false, served: true },
      showing({ page: item("page") }),
      named,
      showing({ page: item("page"), model: item("model") }),
      { changed: { models: true, game: false } },
      { changed: { models: true, game: true } },
      showing({ page: item("page"), model: item("model"), changes: item("diff") }),
      reported,
      {},
    ])
    expect(after).toEqual([
      "ask",
      "ask",
      "run",
      "run",
      "page",
      "team",
      "shape",
      "files",
      "files",
      "diff",
      "finish",
      // The person plays, touching it: the story ends in the same stage.
      "end",
    ])
    expect(end).toBe("done")
  })

  it("lets agents finish steps out of order: each step stays done, held until the person has seen it", () => {
    // The models, the game and the changes are all done before the tour reaches their steps.
    const all = world(everything)
    const held = feed(atStep("files"), all, 100)
    expect(held.run).toMatchObject({ step: 6, doneAt: 100 })
    // However long it waits: the person hasn't touched it.
    expect(tick(held.run!, all, 1e9).run?.step).toBe(6)
    const next = touch(held.run!, all, 5_000)
    expect(idAt(next.run!)).toBe("files")
    // Its line's caption showed with the panel open: it holds from then, then the next begins.
    const read = stepRun(
      next.run!,
      stepsFor(next.run!),
      {
        type: "caption",
        line: "See the files blink? That's an agent, writing.",
        signals: all,
        now: 5_500,
      },
      patience,
    )
    expect(read.run).toMatchObject({ step: 6, captionAt: 5_500 })
    expect(idAt(tick(read.run!, all, 10_499).run!)).toBe("files")
    expect(idAt(tick(read.run!, all, 10_500).run!)).toBe("diff")
  })

  context("a held step's caption", () => {
    // The lead named itself, nothing else yet: the start is done, and the ask waits for the sheet.
    const all = world()
    const caption = (run: TourRun, line: string, now: number) =>
      stepRun(run, stepsFor(run), { type: "caption", line, signals: all, now }, patience)
    const line = "That's your agent. It does the work. I talk."
    // The start, done at 100 with no caption yet: it holds 4 s for its line, long enough for Nyx
    // to say it.
    const done = () => feed(atStep("start"), all, 100).run!
    const unnamed = signals(
      { kind: "agent", working: false, named: false, answered: false },
      true,
      {
        roles: cast,
      },
    )

    it("holds its full time from when the caption shows, however late", () => {
      const shown = caption(done(), line, 3_000).run!
      expect(shown).toMatchObject({ doneAt: 100, captionAt: 3_000 })
      expect(nextTick(shown, tourSteps, all, patience)).toBe(7_000)
      expect(idAt(tick(shown, all, 6_999).run!)).toBe("start")
      expect(idAt(tick(shown, all, 7_000).run!)).toBe("ask")
    })

    it("waits for the caption, up to the cap, then holds from there", () => {
      const waiting = done()
      expect(nextTick(waiting, tourSteps, all, patience)).toBe(100 + captionWaitMs + 4_000)
      expect(idAt(tick(waiting, all, 100 + captionWaitMs + 3_999).run!)).toBe("start")
      expect(idAt(tick(waiting, all, 100 + captionWaitMs + 4_000).run!)).toBe("ask")
    })

    it("ignores a caption that comes after the wait for it ran out", () => {
      const last = done()
      const ends = 100 + captionWaitMs + 4_000
      const late = caption(last, line, 100 + captionWaitMs - 1)
      // One just inside the wait counts; one at its end, or after, doesn't move the end out.
      expect(late.run!.captionAt).toBe(100 + captionWaitMs - 1)
      const over = caption(last, line, 100 + captionWaitMs)
      expect(over.run!.captionAt).toBeNull()
      expect(nextTick(over.run!, tourSteps, all, patience)).toBe(ends)
    })

    it("holds from when it was done where the caption showed before that", () => {
      const early = stepRun(
        atStep("start"),
        tourSteps,
        { type: "caption", line, signals: unnamed, now: 50 },
        patience,
      ).run!
      expect(early.captionAt).toBe(50)
      const held = feed(early, all, 100).run!
      expect(nextTick(held, tourSteps, all, patience)).toBe(4_100)
    })

    it("ignores a box for any other line, or a step that holds none", () => {
      expect(
        caption(done(), "A teammate wants an answer first. From you.", 3_000).run!.captionAt,
      ).toBeNull()
      const run = atStep("run")
      expect(caption(run, stepsFor(run)[run.step]!.coach.line, 3_000).run!.captionAt).toBeNull()
    })

    it("counts its hold from the done step as before for a step with no line", () => {
      const quietStep: TourStep = { ...tourSteps[1]!, coach: { line: "" }, holdMs: 3_000 }
      const run = { ...at(), step: 0, doneAt: 100 }
      expect(nextTick(run, [quietStep], all, patience)).toBe(3_100)
    })

    it("starts over, as does its done time, while the project is away", () => {
      const shown = caption(done(), line, 3_000).run!
      const away = feed(shown, signals(quiet, false, { roles: cast }), 4_000).run!
      expect(away).toMatchObject({ doneAt: 4_000, captionAt: null })
    })

    it("is waited for again after a reload, never stuck and never skipped", () => {
      const shown = caption(done(), line, 3_000).run!
      sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...shown, stepId: "start" }))
      const reloaded = readTourRun()!
      expect(reloaded.captionAt).toBeNull()
      // The reload makes it done as of now (useTourDriver); the box shows again a moment later.
      const again = { ...reloaded, doneAt: 20_000 }
      expect(nextTick(again, tourSteps, all, patience)).toBe(20_000 + captionWaitMs + 4_000)
      const reshown = caption(again, line, 21_500).run!
      expect(nextTick(reshown, tourSteps, all, patience)).toBe(25_500)
      expect(idAt(tick(reshown, all, 25_500).run!)).toBe("ask")
    })
  })

  context("a step that waits on the person", () => {
    const all = world(everything)
    // The page step, done at 100.
    const done = () => feed(atStep("page"), all, 100).run!

    it("stays, done, however long they take, nudging no one", () => {
      const waiting = done()
      expect(waiting.doneAt).toBe(100)
      expect(nextTick(waiting, tourSteps, all, patience)).toBeNull()
      expect(tick(waiting, all, 1e9)).toMatchObject({ nudge: null, run: { step: waiting.step } })
    })

    it("moves on once they touch what it shows, its own caption on screen", () => {
      expect(idAt(touch(done(), all, 5_000).run!)).toBe("team")
      // A touch under another caption (a teammate's question) isn't its.
      const other = touch(done(), all, 5_000, "A teammate has a question. Huh? For you, not me.")
      expect(other.run).toMatchObject({ touched: null })
      expect(idAt(other.run!)).toBe("page")
    })

    it("moves on as it is done where they touched it before that", () => {
      const early = touch({ ...atStep("page") }, world(), 50).run!
      expect(early).toMatchObject({ touched: 50, doneAt: null })
      const held = feed(early, all, 100).run!
      expect(nextTick(held, tourSteps, all, patience)).toBe(100)
      expect(idAt(tick(held, all, 100).run!)).toBe("team")
    })

    it("is touched again after a reload", () => {
      const touched = { ...done(), touched: 4_000 }
      sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...touched, stepId: "page" }))
      expect(readTourRun()!.touched).toBeNull()
    })

    it("brings what it is about back only when the person asks, the calm way", () => {
      // The Builder's changes: its terminal again, and its tab.
      expect(showAgain(atStep("diff"), tourSteps, all)).toEqual({
        moves: [{ kind: "travel", terminalId: "t3" }],
        tab: { terminalId: "t3", key: "diff" },
      })
      // The team, once there: every window framed.
      const hired = world({
        ...everything,
        team: { count: 1, named: 1, ids: ["t2"], reported: 0, working: false },
      })
      expect(showAgain(atStep("team"), tourSteps, hired)).toEqual({
        moves: [{ kind: "fit-all" }],
        tab: null,
      })
      // The Files panel: nothing to move, its button is in the rail.
      expect(showAgain(atStep("files"), tourSteps, all)).toEqual({ moves: [], tab: null })
    })

    it("counts the Files panel on screen as the person's touch", () => {
      const files = tourSteps.find(({ id }) => id === "files")!
      expect(files.coach).toMatchObject({ click: ["files", "files-button"], opened: true })
    })

    it("holds a while from its line's caption where that comes after the touch", () => {
      // The files step, done at 100, opened at 4 000; its line shows a second later.
      const opened = touch(feed(atStep("files"), all, 100).run!, all, 4_000).run!
      expect(nextTick(opened, tourSteps, all, patience)).toBe(4_000 + captionWaitMs + 5_000)
      const line = "See the files blink? That's an agent, writing."
      const read = stepRun(
        opened,
        tourSteps,
        { type: "caption", line, signals: all, now: 5_000 },
        patience,
      ).run!
      expect(nextTick(read, tourSteps, all, patience)).toBe(10_000)
      // Its cue's box is no caption of its own.
      const cue = stepRun(
        opened,
        tourSteps,
        { type: "caption", line: "Open your Files. I'll wait.", signals: all, now: 5_000 },
        patience,
      ).run!
      expect(cue.captionAt).toBeNull()
    })

    it("leaves a step that waits on the agents alone", () => {
      expect(touch(atStep("finish"), all, 50).run!.touched).toBeNull()
    })
  })

  it("waits on the person's touch at each step that shows them something, and holds only the agents' steps a while", () => {
    expect(tourSteps.filter(({ person }) => person).map(({ id }) => id)).toEqual([
      "page",
      "team",
      "shape",
      "files",
      "diff",
      "play",
    ])
    const holds = Object.fromEntries(tourSteps.map(({ id, holdMs }) => [id, holdMs]))
    expect(holds).toMatchObject({ start: 4_000, finish: 4_000, play: 20_000 })
    expect(holds.ask).toBeUndefined()
    expect(holds.page).toBeUndefined()
  })

  it("gives a button to bring a role or the team into view, never a view or a sidebar panel", () => {
    for (const step of tourSteps)
      for (const move of step.show) expect(["travel", "fit-all"]).toContain(move.kind)
    expect(tourSteps.filter(({ show }) => show.length === 0).map(({ id }) => id)).toEqual([
      "start",
      "ask",
      "run",
      "files",
    ])
  })

  it("says nothing at a step until what it's about is there", () => {
    const silent = (id: string, story: Partial<TourSignals>) =>
      coachNow(atStep(id), tourSteps, world(story))
    expect(silent("page", {})).toBeNull()
    expect(silent("page", { shown: { ...world().shown, page: item("p1") } })?.line).toBe(
      "There. Nothing in it yet. Give it time.",
    )
    expect(silent("team", {})).toBeNull()
    expect(silent("shape", {})).toBeNull()
    expect(silent("diff", {})).toBeNull()
    // Its button brings nothing yet either.
    expect(showAgain(atStep("shape"), tourSteps, world())).toEqual({ moves: [], tab: null })
  })

  it("has a cue for the person's part wherever its line would come before its subject", () => {
    const cued = tourSteps.filter(({ coach }) => coach.cue).map(({ id }) => id)
    expect(cued).toEqual(["page", "team", "shape", "files", "diff", "play"])
    expect(tourSteps.find(({ id }) => id === "files")!.coach).toMatchObject({
      cue: { line: "Open your Files. I'll wait." },
      line: "See the files blink? That's an agent, writing.",
    })
  })

  context("at the ask", () => {
    it("points at the sheet's answers, else its row, else the Inbox's button", () => {
      const begun = feed(atStep("ask"), world())
      expect(coachNow(begun.run!, tourSteps, world(sheet(true)))).toMatchObject({
        click: ["answers", "asking-row", "inbox-button"],
        line: "Your call. What game? Make it a good one.",
      })
    })

    it("takes the sheet gone from the Inbox, once seen, as the person's answer", () => {
      const asking = feed(atStep("ask"), world(sheet(true)))
      expect(asking.run).toMatchObject({ step: 1, asked: true })
      expect(idAt(feed(asking.run!, world(sheet(false))).run!)).toBe("run")
    })

    it("is done once answered, even before the tour came to it", () => {
      expect(idAt(feed(atStep("ask"), world(sheet(false, true))).run!)).toBe("run")
    })

    it("nudges no one while the person has the sheet to answer", () => {
      const run = { ...atStep("ask"), asked: true, waitingSince: 0 }
      expect(nextTick(run, stepsFor(run), world(sheet(true)), patience)).toBeNull()
    })

    it("nudges the lead while the sheet hasn't come", () => {
      const run = { ...atStep("ask"), waitingSince: 0 }
      expect(nextTick(run, stepsFor(run), world(), patience)).toBe(patience)
      expect(tick(run, world(), patience).nudge).toBe("t1")
    })
  })

  context("at the team", () => {
    it("waits for both teammates to be there and named", () => {
      const one = bare({ team: { count: 1, named: 1, ids: ["t2"], reported: 0, working: false } })
      expect(feed(atStep("team"), one).run?.doneAt).toBeNull()
      const unnamed = bare({
        team: { count: 2, named: 1, ids: ["t2", "t3"], reported: 0, working: false },
      })
      expect(feed(atStep("team"), unnamed).run?.doneAt).toBeNull()
      expect(
        feed(
          atStep("team"),
          bare({ team: { count: 2, named: 2, ids: [], reported: 0, working: false } }),
        ).run?.doneAt,
      ).toBe(1)
    })
  })

  context("at the run", () => {
    const run = { ...atStep("run"), waitingSince: 0 }

    it("waits on the agent until its approval shows, then on the person as long as they take", () => {
      expect(nextTick(run, stepsFor(run), world(), patience)).toBe(patience)
      const asking = world({ approving: true })
      expect(nextTick(run, stepsFor(run), asking, patience)).toBeNull()
      expect(tick(run, asking, patience * 10)).toMatchObject({ nudge: null, run: { step: 2 } })
    })

    it("is done once allowed, or once the page shows, with no mind to who was quicker", () => {
      expect(feed(run, world({ served: true })).run).toMatchObject({ step: 3 })
      expect(feed(run, world()).run?.step).toBe(2)
    })

    it("points at the approval dialog's button", () => {
      expect(coachNow(run, stepsFor(run), world())).toMatchObject({ click: ["approve"] })
    })
  })

  context("at the page", () => {
    it("brings the lead and the page's tab only by its button, once the page is shown", () => {
      const begun = feed(atStep("page"), world({ served: true }))
      expect(showAgain(begun.run!, tourSteps, world({ served: true }))).toEqual({
        moves: [],
        tab: null,
      })
      const page = world({ shown: { ...world().shown, page: item("p1") } })
      const shown = feed(begun.run!, page, 2)
      expect(shown.run).toMatchObject({ doneAt: 2 })
      expect(showAgain(shown.run!, tourSteps, page)).toEqual({
        moves: [{ kind: "travel", terminalId: "t1" }],
        tab: { terminalId: "t1", key: "p1" },
      })
    })
  })

  context("at the shape", () => {
    it("is done once the modeller's first model is up, and waits on the modeller", () => {
      const entered = feed(atStep("shape"), world())
      expect(entered.run?.doneAt).toBeNull()
      const shown = world({ shown: { ...world().shown, model: item("m1") } })
      expect(feed(entered.run!, shown, 2)).toMatchObject({ run: { doneAt: 2 } })
      expect(showAgain(atStep("shape"), tourSteps, shown)).toEqual({
        moves: [{ kind: "travel", terminalId: "t2" }],
        tab: { terminalId: "t2", key: "m1" },
      })
      const waiting = { ...atStep("shape"), waitingSince: 0 }
      expect(tick(waiting, world(), patience).nudge).toBe("t2")
    })
  })

  context("at the files", () => {
    it("waits for both the models and the game to be changed", () => {
      expect(
        feed(atStep("files"), world({ changed: { models: true, game: false } })).run?.doneAt,
      ).toBeNull()
      expect(
        feed(atStep("files"), world({ changed: { models: true, game: true } })).run?.doneAt,
      ).toBe(1)
    })

    it("points at the Files panel, else the rail's button that opens it", () => {
      const entered = feed(atStep("files"), world())
      expect(coachNow(entered.run!, tourSteps, world())).toMatchObject({
        click: ["files", "files-button"],
      })
    })
  })

  context("at the diff", () => {
    it("is done once the builder's changes are shown, which its button brings", () => {
      const begun = feed(atStep("diff"), world())
      const changes = world({ shown: { ...world().shown, changes: item("c1") } })
      const shown = feed(begun.run!, changes, 2)
      expect(shown.run?.doneAt).toBe(2)
      expect(showAgain(shown.run!, tourSteps, changes)).toEqual({
        moves: [{ kind: "travel", terminalId: "t3" }],
        tab: { terminalId: "t3", key: "c1" },
      })
    })
  })

  context("with a teammate's own question", () => {
    const asking = world({ askingRow: "q1" })

    it("points at it in the Inbox, whatever the step, until it is answered", () => {
      for (const id of ["team", "shape", "files", "diff"])
        expect(coachNow(atStep(id), tourSteps, asking)).toMatchObject({
          click: ["answers", "asking-row", "inbox-button"],
          line: "A teammate has a question. Huh? For you, not me.",
        })
      expect(
        coachNow(
          atStep("shape"),
          tourSteps,
          world({ shown: { ...world().shown, model: item("m") } }),
        )?.line,
      ).toBe("A model, made from nothing. Go on. Spin it.")
    })

    it("nudges no one while it waits", () => {
      const run = { ...atStep("shape"), waitingSince: 0 }
      expect(nextTick(run, stepsFor(run), asking, patience)).toBeNull()
      expect(tick(run, asking, patience * 3)).toMatchObject({ nudge: null, run: { step: 5 } })
    })

    it("lets a step that holds a while, done, show its own caption first", () => {
      const held = { ...atStep("finish"), doneAt: 100 }
      expect(coachNow(held, tourSteps, asking)?.line).toBe("They're finishing it. Relax.")
      expect(coachNow({ ...held, doneAt: null }, tourSteps, asking)?.line).toBe(
        "A teammate has a question. Huh? For you, not me.",
      )
    })

    it("comes before a step waiting on the person's touch, which may wait long", () => {
      const waiting = { ...atStep("shape"), doneAt: 100 }
      expect(coachNow(waiting, tourSteps, asking)?.line).toBe(
        "A teammate has a question. Huh? For you, not me.",
      )
    })

    it("lets a permission come first", () => {
      const both = world({ askingRow: "q1", permission: { terminalId: "t3" } })
      expect(coachNow(atStep("shape"), tourSteps, both)?.line).toBe(
        "It's asking your permission. Read it first.",
      )
    })
  })

  context("at the finish", () => {
    const team = (part: Partial<TourSignals["team"]>): Partial<TourSignals> => ({
      team: { count: 2, named: 2, ids: ["t2", "t3"], reported: 2, working: false, ...part },
    })

    it("waits for every teammate to report, quiet, with nothing asked of the person", () => {
      const done = (story: Partial<TourSignals>) => feed(atStep("finish"), world(story)).run?.doneAt
      expect(done(team({ reported: 1 }))).toBeNull()
      expect(done(team({ working: true }))).toBeNull()
      expect(done({ ...team({}), askingRow: "q1" })).toBeNull()
      expect(done({ ...team({}), permission: { terminalId: "t2" } })).toBeNull()
      expect(done(team({}))).toBe(1)
    })

    it("moves on after its cap, whatever the team is doing", () => {
      const busy = world(team({ working: true }))
      const run = { ...atStep("finish"), stepAt: 0, waitingSince: 0 }
      expect(nextTick(run, stepsFor(run), busy, patience)).toBe(5 * 60_000)
      expect(idAt(tick(run, busy, 5 * 60_000 - 1).run!)).toBe("finish")
      expect(idAt(tick(run, busy, 5 * 60_000).run!)).toBe("play")
    })

    it("keeps the closing card back while a teammate's question waits", () => {
      const asking = feed(atStep("play"), world({ askingRow: "q1" }), 100)
      expect(asking.run?.doneAt).toBeNull()
      expect(tick(asking.run!, world({ askingRow: "q1" }), 1e9).run).not.toBeNull()
    })
  })

  context("in its nudges", () => {
    const patient = (id: string, seen: TourSignals, now = 0) => {
      const run = { ...atStep(id), waitingSince: now }
      return tick(run, seen, now + patience)
    }

    it("go to the lead by default", () => {
      expect(
        patient(
          "team",
          world({ team: { count: 1, named: 1, ids: ["t2"], reported: 0, working: false } }),
        ).nudge,
      ).toBe("t1")
    })

    it("go to the lead in a teammate's place while it isn't found", () => {
      expect(patient("shape", bare()).nudge).toBe("t1")
    })

    it("move a step on after the nudge and as long again", () => {
      const run = { ...atStep("diff"), waitingSince: 0 }
      const nudged = tick(run, world(), patience)
      expect(nudged).toMatchObject({ nudge: "t3", run: { nudged: true } })
      expect(idAt(tick(nudged.run!, world(), 2 * patience).run!)).toBe("finish")
    })
  })

  context("at the end", () => {
    it("plays the game in the lead's pane: 20 seconds after the person clicks into it, the story ends", () => {
      const run = atStep("play")
      const held = feed(run, world(everything), 100)
      expect(showAgain(held.run!, tourSteps, world(everything))).toEqual({
        moves: [{ kind: "travel", terminalId: "t1" }],
        tab: { terminalId: "t1", key: "page" },
      })
      expect(coachNow(held.run!, tourSteps, world(everything))).toMatchObject({
        click: ["lead-pane", "lead"],
        line: "Three agents, one game. Go play.",
      })
      // Until they click into it, it waits.
      expect(nextTick(held.run!, tourSteps, world(), patience)).toBeNull()
      const playing = touch(held.run!, world(), 2_000).run!
      expect(nextTick(playing, tourSteps, world(), patience)).toBe(22_000)
      expect(tick(playing, world(), 21_999).run).not.toBeNull()
      expect(tick(playing, world(), 22_000)).toMatchObject({ run: null, end: "done" })
    })

    it("looks at the modeller's model instead where there is no page", () => {
      const noPage = atStep("play", false)
      const held = feed(noPage, world(everything), 100)
      expect(showAgain(held.run!, stepsFor(noPage), world(everything))).toEqual({
        moves: [{ kind: "travel", terminalId: "t2" }],
        tab: { terminalId: "t2", key: "model" },
      })
      expect(coachNow(held.run!, stepsFor(noPage), world(everything))).toMatchObject({
        click: ["modeller-pane", "modeller"],
        line: "Three agents, one model. Yours.",
      })
    })
  })

  context("with no page to run", () => {
    it("goes from the team to the model, and plays the whole story to its end", () => {
      const { after, end } = through(false, [
        {},
        sheet(true),
        sheet(false, true),
        named,
        showing({ model: item("model") }),
        { changed: { models: true, game: true } },
        showing({ model: item("model"), changes: item("diff") }),
        reported,
        {},
      ])
      expect(after).toEqual(["ask", "ask", "team", "shape", "files", "diff", "finish", "end"])
      expect(end).toBe("done")
    })
  })
})

describe("The tour, with a run kept through a reload", () => {
  it("is dropped where its steps are another story's", () => {
    // A run of the old story, whose step ids differ, has no `page` and no `command`: not a run.
    sessionStorage.setItem(
      "novadeck.tour",
      JSON.stringify({
        terminalId: "t1",
        agent: "claude",
        brief: "launch",
        step: 2,
        stepId: "yours",
      }),
    )
    expect(readTourRun()).toBeNull()
  })

  it("is followed again at the same step", () => {
    const run: TourRun = {
      ...beginRun(
        { terminalId: "t1", agent: "claude", brief: "doorbell", command: "claude", page: true },
        0,
      ),
      step: 5,
    }
    sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "shape" }))
    expect(readTourRun()).toMatchObject({ step: 5 })
    // At another index, the same id isn't there: dropped.
    sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "diff" }))
    expect(readTourRun()).toBeNull()
    // Without a page, the story is shorter: the index names another step.
    sessionStorage.setItem(
      "novadeck.tour",
      JSON.stringify({ ...run, page: false, stepId: "shape" }),
    )
    expect(readTourRun()).toBeNull()
  })

  it("drops a run of the story before, with its artist's steps", () => {
    const run = {
      ...beginRun(
        { terminalId: "t1", agent: "claude", brief: "doorbell", command: "claude", page: true },
        0,
      ),
      step: 10,
      artist: "t4",
      artistBriefed: true,
      artistDropped: false,
      startingSince: null,
    }
    sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "talk" }))
    expect(readTourRun()).toBeNull()
  })
})

describe("The tour, with a teammate at a screen of its own", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const run = { ...begin(), step: 1 }
  const held = signals(quiet, true, {
    roles: { lead: "t1" },
    teamScreen: { terminalId: "t3", screen: "startup", program: "codex" },
  })

  it("points at that teammate, in its harness's words", () => {
    expect(coachNow(run, tourSteps, held)).toMatchObject({
      line: "A teammate wants an answer first. From you.",
      terminalId: "t3",
      click: ["terminal"],
    })
  })

  it("nudges no one while it holds", () => {
    expect(nextTick(run, tourSteps, held, patience)).toBeNull()
  })
})

describe("The tour, with an agent asking the person's permission", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const wanted = signals(quiet, true, { permission: { terminalId: "t3" } })
  const run = { ...begin(), step: 1 }

  it("points at that agent's terminal, in a person's words", () => {
    expect(coachNow(run, steps, wanted)).toMatchObject({
      line: "It's asking your permission. Read it first.",
      terminalId: "t3",
      click: ["terminal"],
    })
  })

  it("lets a screen of the agent's own come first", () => {
    const screen = signals({ kind: "screen", screen: "startup" }, true, {
      permission: { terminalId: "t3" },
    })
    expect(coachNow(run, steps, screen)?.line).toBe("It wants an answer first. From you.")
  })

  it("counts no wait while it asks: no nudge, and none right after", () => {
    expect(nextTick(run, steps, wanted, patience)).toBeNull()
    const waited = stepRun(
      run,
      steps,
      { type: "tick", signals: wanted, now: patience * 3 },
      patience,
    )
    expect(waited.nudge).toBeNull()
    expect(waited.run!.step).toBe(run.step)
    expect(waited.run!.waitingSince).toBe(patience * 3)
  })
})

describe("The tour, with an agent whose program ended", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: false, answered: false }
  const roles = { lead: "t1" }
  const startFor = (brief: "launch" | "doorbell" = "doorbell") =>
    beginRun({ terminalId: "t1", agent: "claude", brief, command: "claude", page: true }, 0)

  it("says it didn't start, with the lead's terminal marked, and counts no wait", () => {
    const run = startFor()
    const left = signals({ kind: "left" })
    expect(coachNow(run, tourSteps, left)).toMatchObject({
      line: "What? It didn't even start.",
      click: ["lead"],
    })
    expect(coachNow(run, tourSteps, left)?.note).toMatch(/End the tour and take it again/)
    expect(nextTick(run, tourSteps, left, patience)).toBeNull()
  })

  it("rings the lead's brief once its agent shows again, and the run carries on", () => {
    const run = startFor()
    const gone = stepRun(
      run,
      tourSteps,
      { type: "signals", signals: signals({ kind: "left" }), now: 1 },
      patience,
    )
    expect(gone).toMatchObject({ brief: false, nudge: null, run: { briefed: false, step: 0 } })
    const back = stepRun(
      gone.run!,
      tourSteps,
      { type: "signals", signals: signals(quiet), now: 2 },
      patience,
    )
    expect(back.brief).toBe(true)
    expect(back.run).toMatchObject({ briefed: true })
  })

  it("tells a teammate that left to take the tour again", () => {
    const left = signals(quiet, true, { roles, teamLeft: { terminalId: "t3" } })
    expect(coachNow(startFor(), tourSteps, left)).toMatchObject({
      line: "A teammate quit.",
      terminalId: "t3",
      note: "Its terminal says why. End the tour and take it again.",
    })
  })

  it("takes a normal start for no leaving", () => {
    const run = startFor()
    const outcome = stepRun(
      run,
      tourSteps,
      { type: "signals", signals: signals({ kind: "starting" }), now: 1 },
      patience,
    )
    expect(coachNow(run, tourSteps, signals({ kind: "starting" }))).toBe(tourSteps[0]!.coach)
    expect(outcome.run?.step).toBe(0)
  })
})

describe("The tour's parts that drop out", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const working: LeadState = { kind: "agent", working: true, named: true, answered: true }
  const cast = { lead: "t1", modeller: "t2", builder: "t3" }
  const world = (story: Partial<TourSignals> = {}): TourSignals =>
    signals(quiet, true, {
      roles: cast,
      mates: { modeller: quiet, builder: quiet },
      ...story,
    })
  const run0 = (): TourRun =>
    beginRun(
      { terminalId: "t1", agent: "claude", brief: "doorbell", command: "claude", page: true },
      0,
    )
  const at = (id: string, parts: Partial<TourRun> = {}): TourRun => {
    const run = { ...run0(), briefed: true, ...parts }
    return { ...run, step: stepsOfRun(run).findIndex((step) => step.id === id) }
  }
  const feed = (run: TourRun, story: TourSignals, now: number) =>
    stepRun(run, stepsOfRun(run), { type: "signals", signals: story, now }, patience)
  const ids = (run: TourRun) => stepsOfRun(run).map(({ id }) => id)

  context("when the lead's run is declined", () => {
    it("goes on as it did when allowed: the page steps stay", () => {
      let run: TourRun = at("run")
      run = feed(run, world({ approving: true }), 1).run!
      run = feed(run, world({ served: true }), 2).run!
      expect(run).toMatchObject({ declined: false })
      expect(ids(run)).toContain("page")
      expect(stepsOfRun(run)[run.step]?.id).toBe("page")
      // Nothing is taken as declined later, however long it takes.
      expect(feed(run, world({ served: true }), 2 + 10 * declineMs).run?.declined).toBe(false)
    })

    it("drops the page steps once the approval is gone and no terminal opened, then plays on", () => {
      let run: TourRun = at("run")
      run = feed(run, world({ approving: true }), 1).run!
      // Gone, not served: a few seconds are allowed for the terminal to open.
      run = feed(run, world(), 100).run!
      expect(run.declined).toBe(false)
      expect(nextTick(run, stepsOfRun(run), world(), 1e9)).toBe(100 + declineMs)
      const after = feed(run, world(), 100 + declineMs)
      expect(after.run).toMatchObject({ declined: true })
      // The lead opens its team whether or not the person let it run the server.
      expect(stepsOfRun(after.run!)[after.run!.step]?.id).toBe("team")
      expect(ids(after.run!)).not.toContain("page")
      expect(ids(after.run!)).not.toContain("run")
    })

    it("ends on the modeller's model with the no-page line", () => {
      const run = at("play", { declined: true })
      const model = world({
        shown: { page: null, model: "m" as TourSignals["shown"]["model"], changes: null },
      })
      expect(coachNow(run, stepsOfRun(run), model)).toMatchObject({
        click: ["modeller-pane", "modeller"],
        line: "Three agents, one model. Yours.",
      })
    })

    it("is not brought back by a reload", () => {
      const run: TourRun = { ...at("shape", { declined: true }), approvalSeen: true }
      sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "shape" }))
      expect(readTourRun()).toMatchObject({ declined: true, approvalSeen: false })
      // The same index of a story with the page would be another step: dropped.
      sessionStorage.setItem(
        "novadeck.tour",
        JSON.stringify({ ...run, declined: false, stepId: "shape" }),
      )
      expect(readTourRun()).toBeNull()
    })
  })

  context("in whom a step waits on", () => {
    const tickAt = (id: string, story: TourSignals) =>
      stepRun(
        { ...at(id), waitingSince: 0 },
        stepsOfRun(at(id)),
        { type: "tick", signals: story, now: patience },
        patience,
      )

    it("nudges the modeller at the files until the models changed, then the builder", () => {
      expect(tickAt("files", world()).nudge).toBe("t2")
      expect(tickAt("files", world({ changed: { models: true, game: false } })).nudge).toBe("t3")
    })

    it("nudges the modeller at the shape and the builder at the diff", () => {
      expect(tickAt("shape", world()).nudge).toBe("t2")
      expect(tickAt("diff", world()).nudge).toBe("t3")
    })

    it("counts no silence while that teammate works on its turn, though the lead is quiet", () => {
      const busy = world({ mates: { modeller: working, builder: quiet } })
      expect(tickAt("shape", busy).nudge).toBeNull()
      const run = { ...at("shape"), waitingSince: 0 }
      expect(nextTick(run, stepsOfRun(run), busy, patience)).toBeNull()
      expect(nextTick(run, stepsOfRun(run), world(), patience)).toBe(patience)
    })
  })
})
