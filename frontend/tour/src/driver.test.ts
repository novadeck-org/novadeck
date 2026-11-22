import {
  beginRun,
  coachNow,
  declineMs,
  nextTick,
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
  enter: [{ kind: "inbox" }],
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
    it("makes its moves once, on screen, whatever the agent is doing", () => {
      const { seen } = play(begin(), [
        { type: "signals", signals: starting, now: 1 },
        { type: "signals", signals: agent(), now: 2 },
      ])
      expect(seen[0]!.moves).toEqual([
        { kind: "view", view: "canvas" },
        { kind: "reveal", terminalId: "t1" },
      ])
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
      expect(seen[0]!.moves).toEqual([{ kind: "inbox" }])
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
  const cast = { lead: "t1", sculptor: "t2", fixer: "t3", artist: "t4" }
  // Signals with the whole cast found and nothing yet done, changed by `story`.
  const world = (story: Partial<TourSignals> = {}): TourSignals =>
    signals(quiet, true, {
      roles: cast,
      team: { count: 0, named: 0, ids: [] },
      artist: null,
      ...story,
    })
  const bare = (story: Partial<TourSignals> = {}): TourSignals =>
    signals(quiet, true, { roles: { lead: "t1" }, ...story })
  const item = (id: string) => id as TourSignals["shown"]["page"]
  const everything: Partial<TourSignals> = {
    served: true,
    answered: true,
    changed: { hero: true, score: true },
    shown: {
      page: item("page"),
      model: item("model"),
      changes: item("diff"),
      cover: item("cover"),
    },
    talk: { toLead: true, fromLead: true },
  }
  const at = (page = true): TourRun =>
    beginRun(
      { terminalId: "t1", agent: "claude", brief: "launch", command: "claude --model haiku", page },
      0,
    )
  const stepsFor = (run: TourRun) => stepsOfRun(run, true)
  const idAt = (run: TourRun) => stepsFor(run)[run.step]?.id
  const atStep = (id: string, page = true): TourRun => {
    const run = at(page)
    return { ...run, step: stepsFor(run).findIndex((step) => step.id === id), entered: true }
  }
  const feed = (run: TourRun, now1: TourSignals, now = 1) =>
    stepRun(run, stepsFor(run), { type: "signals", signals: now1, now }, patience)
  const tick = (run: TourRun, now1: TourSignals, now: number) =>
    stepRun(run, stepsFor(run), { type: "tick", signals: now1, now }, patience)

  it("plays four acts, in order", () => {
    expect(tourSteps.map(({ id, act }) => [id, act])).toEqual([
      ["start", 1],
      ["team", 2],
      ["run", 2],
      ["page", 2],
      ["shape", 2],
      ["ask", 3],
      ["files", 3],
      ["model", 3],
      ["diff", 3],
      ["outsider", 3],
      ["talk", 3],
      ["cover", 3],
      ["play", 4],
    ])
  })

  it("leaves out the run and the page where this computer has no way to serve it", () => {
    expect(stepsOf(true, true)).toBe(tourSteps)
    const played = stepsOf(false, true).map(({ id }) => id)
    expect(played).not.toContain("run")
    expect(played).not.toContain("page")
    expect(played.at(-1)).toBe("play")
    expect(stepsOf(true, false).map(({ id }) => id)).not.toContain("outsider")
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
      // A step done holds a while: the clock moves past it.
      if (run && typeof run.doneAt === "number") {
        now += 30_000
        outcome = tick(run, world(state), now)
        run = outcome.run
      }
      end = outcome.end ?? end
      after.push(run ? (idAt(run) ?? "end") : "end")
    }
    return { after, end }
  }
  const named = { team: { count: 2, named: 2, ids: ["t2", "t3"] } }
  const showing = (part: Partial<TourSignals["shown"]>): Partial<TourSignals> => ({
    shown: { ...world().shown, ...part },
  })

  it("plays the whole story in order, as the agents do it", () => {
    // After each stage of the world, the step the run is at.
    const { after, end } = through(true, [
      {},
      named,
      { approving: true },
      { approving: false, served: true },
      showing({ page: item("page") }),
      showing({ model: item("model") }),
      { asking: true },
      { asking: false, answered: true },
      { changed: { hero: true, score: false } },
      { changed: { hero: true, score: true } },
      showing({ model: item("model") }),
      showing({ changes: item("diff") }),
      { artist: quiet },
      { talk: { toLead: true, fromLead: false } },
      { talk: { toLead: true, fromLead: true } },
      showing({ cover: item("cover") }),
      {},
    ])
    expect(after).toEqual([
      "team",
      "run",
      "run",
      "page",
      "shape",
      "ask",
      "ask",
      "files",
      "files",
      "model",
      "diff",
      "outsider",
      "talk",
      "talk",
      "cover",
      "play",
      "end",
    ])
    expect(end).toBe("done")
  })

  it("lets agents finish steps out of order: each step stays done, held until its time is up", () => {
    // The sculptor, the fixer and the cover are all done before the tour reaches their steps.
    const all = world(everything)
    const held = feed(atStep("files"), all, 100)
    expect(held.run).toMatchObject({ step: 6, doneAt: 100 })
    expect(tick(held.run!, all, 1_000).run?.step).toBe(6)
    const next = tick(held.run!, all, 5_100)
    expect(idAt(next.run!)).toBe("model")
    // And the next step begins at once, its moves made with those signals.
    expect(next.moves).toEqual([{ kind: "reveal", terminalId: "t2" }])
    expect(next.tab).toEqual({ terminalId: "t2", key: "model" })
  })

  it("holds each step a while, as its line is read, before it moves on", () => {
    const holds = Object.fromEntries(tourSteps.map(({ id, holdMs }) => [id, holdMs]))
    expect(holds).toMatchObject({
      team: 3_000,
      page: 6_000,
      files: 5_000,
      model: 5_000,
      diff: 6_000,
      outsider: 3_000,
      talk: 6_000,
      cover: 4_000,
      shape: 8_000,
      play: 25_000,
    })
  })

  it("opens in Canvas on its lead, and frames the team as it comes, the artist too", () => {
    expect(tourSteps.filter(({ frameTeam }) => frameTeam).map(({ id }) => id)).toEqual([
      "team",
      "outsider",
    ])
  })

  context("at the team", () => {
    it("waits for both teammates to be there and named", () => {
      const one = bare({ team: { count: 1, named: 1, ids: ["t2"] } })
      expect(feed(atStep("team"), one).run?.doneAt).toBeNull()
      const unnamed = bare({ team: { count: 2, named: 1, ids: ["t2", "t3"] } })
      expect(feed(atStep("team"), unnamed).run?.doneAt).toBeNull()
      expect(
        feed(atStep("team"), bare({ team: { count: 2, named: 2, ids: [] } })).run?.doneAt,
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
    it("reveals the lead and opens the page's tab once it is shown", () => {
      const begun = feed({ ...atStep("page"), entered: false }, world({ served: true }))
      expect(begun.moves).toEqual([{ kind: "reveal", terminalId: "t1" }])
      expect(begun.tab).toBeNull()
      const shown = feed(begun.run!, world({ shown: { ...world().shown, page: item("p1") } }), 2)
      expect(shown.tab).toEqual({ terminalId: "t1", key: "p1" })
      expect(shown.run).toMatchObject({ tabbed: true, doneAt: 2 })
      // Once: the next signals open nothing again.
      expect(
        feed(shown.run!, world({ shown: { ...world().shown, page: item("p1") } }), 3).tab,
      ).toBeNull()
    })
  })

  context("at the shape", () => {
    it("shows the hero as it is, once the sculptor has its model up, and waits on the sculptor", () => {
      const entered = feed({ ...atStep("shape"), entered: false }, world())
      expect(entered.moves).toEqual([{ kind: "reveal", terminalId: "t2" }])
      expect(entered.run?.doneAt).toBeNull()
      const shown = world({ shown: { ...world().shown, model: item("m1") } })
      expect(feed(entered.run!, shown, 2)).toMatchObject({
        tab: { terminalId: "t2", key: "m1" },
        run: { doneAt: 2 },
      })
      const waiting = { ...atStep("shape"), waitingSince: 0 }
      expect(tick(waiting, world(), patience).nudge).toBe("t2")
    })
  })

  context("at the ask", () => {
    it("takes a question gone from the Inbox, once seen, as the person's answer", () => {
      const asking = feed(atStep("ask"), world({ asking: true }))
      expect(asking.run).toMatchObject({ step: 5, asked: true })
      expect(idAt(feed(asking.run!, world({ asking: false })).run!)).toBe("files")
    })

    it("nudges no one while the person has a question to answer", () => {
      const run = { ...atStep("ask"), asked: true, waitingSince: 0 }
      expect(nextTick(run, stepsFor(run), world({ asking: true }), patience)).toBeNull()
    })

    it("nudges the lead while the question hasn't come", () => {
      const run = { ...atStep("ask"), waitingSince: 0 }
      expect(nextTick(run, stepsFor(run), world(), patience)).toBe(patience)
    })
  })

  context("at the files and the model", () => {
    it("wait for both files to be changed", () => {
      expect(
        feed(atStep("files"), world({ changed: { hero: true, score: false } })).run?.doneAt,
      ).toBeNull()
      expect(
        feed(atStep("files"), world({ changed: { hero: true, score: true } })).run?.doneAt,
      ).toBe(1)
    })

    it("reveals the sculptor with the Files panel and its model beside it, framing nothing", () => {
      const files = world({ shown: { ...world().shown, model: item("m1") } })
      const entered = feed({ ...atStep("files"), entered: false }, files)
      expect(entered.moves).toEqual([{ kind: "reveal", terminalId: "t2", panel: "files" }])
      expect(entered.tab).toEqual({ terminalId: "t2", key: "m1" })
    })

    it("opens the sculptor's model", () => {
      const model = world({ ...everything, shown: { ...world().shown, model: item("m1") } })
      const begun = feed({ ...atStep("model"), entered: false }, model)
      expect(begun.moves).toEqual([{ kind: "reveal", terminalId: "t2" }])
      expect(begun.tab).toEqual({ terminalId: "t2", key: "m1" })
    })

    it("waits to move until the role it looks at is found, on a step still to begin", () => {
      const unknown = bare({ ...everything, changed: { hero: true, score: true } })
      const waiting = feed({ ...atStep("model"), entered: false }, unknown)
      expect(waiting.moves).toEqual([])
      expect(waiting.run?.entered).toBe(false)
      expect(feed(waiting.run!, world(everything), 2).moves).toHaveLength(1)
    })
  })

  context("at the diff", () => {
    it("reveals the fixer and opens its changes as soon as they are shown", () => {
      const begun = feed({ ...atStep("diff"), entered: false }, world())
      expect(begun.moves).toEqual([{ kind: "reveal", terminalId: "t3" }])
      expect(begun.tab).toBeNull()
      const shown = feed(begun.run!, world({ shown: { ...world().shown, changes: item("c1") } }), 2)
      expect(shown.tab).toEqual({ terminalId: "t3", key: "c1" })
      expect(shown.run?.doneAt).toBe(2)
    })
  })

  context("with the artist", () => {
    const atOutsider = (): TourRun => ({ ...atStep("outsider"), entered: false })

    it("opens its terminal once, as its step begins on screen, and keeps its id", () => {
      const begun = feed(atOutsider(), bare())
      expect(begun).toMatchObject({ artist: "open", moves: [{ kind: "fit-all" }] })
      const opened = stepRun(
        begun.run!,
        stepsFor(begun.run!),
        { type: "artist-opened", terminalId: "t4" },
        patience,
      )
      expect(opened.run).toMatchObject({ artist: "t4", artistBriefed: false })
      // Not again, however many signals follow.
      expect(feed(opened.run!, bare(), 2).artist).toBeNull()
    })

    it("waits to open it while the tour's project isn't on screen", () => {
      const away = feed(atOutsider(), signals(quiet, false, { roles: { lead: "t1" } }))
      expect(away.artist).toBeNull()
    })

    it("rings its brief once its agent shows, and again where the backend refused", () => {
      const run = { ...atStep("outsider"), artist: "t4" }
      const booting = world({ artist: { kind: "starting" } })
      expect(feed(run, booting).artist).toBeNull()
      const shown = feed(
        run,
        world({ artist: { kind: "agent", working: true, named: false, answered: false } }),
      )
      expect(shown.artist).toBe("brief")
      expect(shown.run?.artistBriefed).toBe(true)
      expect(feed(shown.run!, world({ artist: quiet }), 2).artist).toBeNull()
      const refused = stepRun(
        shown.run!,
        stepsFor(shown.run!),
        { type: "artist-brief-failed" },
        patience,
      )
      expect(refused.run?.artistBriefed).toBe(false)
      expect(feed(refused.run!, world({ artist: quiet }), 3).artist).toBe("brief")
    })

    it("drops the artist's steps once its brief failed for good, nudging nothing", () => {
      for (const id of ["outsider", "talk", "cover"]) {
        const run = { ...atStep(id), artist: "t4", artistBriefed: false }
        const gaveUp = stepRun(
          run,
          stepsFor(run),
          { type: "artist-brief-gave-up", now: 5 },
          patience,
        )
        expect(gaveUp.run).toMatchObject({ artistDropped: true, artistBriefed: true })
        const played = stepsOfRun(gaveUp.run!, true)
        expect(played.map(({ id: stepId }) => stepId)).not.toContain("outsider")
        expect(played[gaveUp.run!.step]?.id).toBe("play")
        // Even with the artist's agent up and quiet, nothing rings or nudges it any more.
        const after = feed(gaveUp.run!, world({ artist: quiet }), 5 + 10 * patience)
        expect(after).toMatchObject({ artist: null, nudge: null })
        expect(coachNow(gaveUp.run!, played, world())?.line).toBe(
          "Three agents. One game. Go play.",
        )
      }
    })

    it("keeps its terminal through a reload: a run restored with it opens none and rings none again", () => {
      const restored = { ...atStep("talk"), artist: "t4", artistBriefed: true }
      const outcome = feed(restored, world())
      expect(outcome).toMatchObject({ artist: null, brief: false })
    })

    it("is done once the artist described itself, and not before", () => {
      const run = { ...atStep("outsider"), artist: "t4", artistBriefed: true }
      const unnamed: LeadState = { kind: "agent", working: false, named: false, answered: false }
      expect(feed(run, world({ artist: unnamed })).run?.doneAt).toBeNull()
      expect(feed(run, world({ artist: quiet })).run?.doneAt).toBe(1)
      expect(feed(run, world({ artist: { kind: "starting" } })).run?.doneAt).toBeNull()
    })

    it("reveals the artist and opens its Messages once it has talked with the lead", () => {
      const begun = feed({ ...atStep("talk"), entered: false }, world())
      expect(begun.moves).toEqual([{ kind: "reveal", terminalId: "t4" }])
      expect(begun.tab).toEqual({ terminalId: "t4", key: "messages" })
      expect(
        feed(atStep("talk"), world({ talk: { toLead: true, fromLead: false } })).run?.doneAt,
      ).toBeNull()
      expect(
        feed(atStep("talk"), world({ talk: { toLead: true, fromLead: true } })).run?.doneAt,
      ).toBe(1)
    })

    it("opens its cover's tab as soon as it is shown", () => {
      const shown = feed(
        { ...atStep("cover"), entered: true },
        world({ shown: { ...world().shown, cover: item("c1") } }),
      )
      expect(shown.tab).toEqual({ terminalId: "t4", key: "c1" })
    })
  })

  context("in its nudges", () => {
    const patient = (id: string, seen: TourSignals, now = 0) => {
      const run = { ...atStep(id), waitingSince: now }
      return tick(run, seen, now + patience)
    }

    it("go to the lead by default", () => {
      expect(patient("team", world({ team: { count: 1, named: 1, ids: ["t2"] } })).nudge).toBe("t1")
    })

    it("go to the artist at the steps on the artist", () => {
      const unnamed: LeadState = { kind: "agent", working: false, named: false, answered: false }
      expect(patient("outsider", world({ artist: unnamed })).nudge).toBe("t4")
      expect(patient("cover", world({ artist: quiet })).nudge).toBe("t4")
    })

    it("go to the artist until it has asked, then to the lead for its answer", () => {
      expect(patient("talk", world({ artist: quiet })).nudge).toBe("t4")
      const replied = world({ artist: quiet, talk: { toLead: true, fromLead: false } })
      expect(patient("talk", replied).nudge).toBe("t1")
    })

    it("count the artist's silence only while it is there and quiet", () => {
      const working: LeadState = { kind: "agent", working: true, named: false, answered: false }
      const run = { ...atStep("cover"), waitingSince: 0 }
      expect(nextTick(run, stepsFor(run), world({ artist: working }), patience)).toBeNull()
      expect(
        nextTick(run, stepsFor(run), world({ artist: { kind: "starting" } }), patience),
      ).toBeNull()
      expect(nextTick(run, stepsFor(run), world({ artist: quiet }), patience)).toBe(patience)
    })

    it("move a step on after the nudge and as long again", () => {
      const run = { ...atStep("cover"), waitingSince: 0 }
      const waiting = world({ artist: quiet })
      const nudged = tick(run, waiting, patience)
      expect(nudged).toMatchObject({ nudge: "t4", run: { nudged: true } })
      expect(idAt(tick(nudged.run!, waiting, 2 * patience).run!)).toBe("play")
    })
  })

  context("at the end", () => {
    it("plays the game in the lead's pane, 25 seconds, then the story ends", () => {
      const run = atStep("play")
      const held = feed({ ...run, entered: false }, world(everything), 100)
      expect(held.moves).toEqual([{ kind: "reveal", terminalId: "t1" }])
      expect(held.tab).toEqual({ terminalId: "t1", key: "page" })
      expect(coachNow(held.run!, tourSteps, world())).toMatchObject({
        look: "lead-pane",
        line: "Four agents. One game. Go play.",
      })
      expect(nextTick(held.run!, tourSteps, world(), patience)).toBe(25_100)
      expect(tick(held.run!, world(), 6_000).run).toMatchObject({ doneAt: 100 })
      expect(tick(held.run!, world(), 25_100)).toMatchObject({ run: null, end: "done" })
    })

    it("looks at the sculptor's model instead where there is no page", () => {
      const noPage = atStep("play", false)
      const held = feed({ ...noPage, entered: false }, world(everything), 100)
      expect(held.moves).toEqual([{ kind: "reveal", terminalId: "t2" }])
      expect(held.tab).toEqual({ terminalId: "t2", key: "model" })
      expect(coachNow(held.run!, stepsFor(noPage), world())).toMatchObject({
        look: "sculptor-pane",
        line: "Four agents. One game. Yours.",
      })
    })
  })

  context("with no page to run", () => {
    it("goes from the team to the ask, and plays the whole story to its end", () => {
      const { after, end } = through(false, [
        named,
        showing({ model: item("model") }),
        { asking: true },
        { asking: false, answered: true, changed: { hero: true, score: true } },
        showing({ model: item("model") }),
        showing({ model: item("model"), changes: item("diff") }),
        { artist: quiet },
        { talk: { toLead: true, fromLead: true } },
        showing({ model: item("model"), changes: item("diff"), cover: item("cover") }),
        {},
      ])
      expect(after).toEqual([
        "shape",
        "ask",
        "ask",
        "model",
        "diff",
        "outsider",
        "talk",
        "cover",
        "play",
        "end",
      ])
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
    expect(readTourRun(true)).toBeNull()
  })

  it("is followed again at the same step, with the artist's terminal and its ring", () => {
    const run: TourRun = {
      ...beginRun(
        { terminalId: "t1", agent: "claude", brief: "doorbell", command: "claude", page: true },
        0,
      ),
      step: 10,
      artist: "t4",
      artistBriefed: true,
    }
    sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "talk" }))
    expect(readTourRun(true)).toMatchObject({ step: 10, artist: "t4", artistBriefed: true })
    // At another index, the same id isn't there: dropped.
    sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "cover" }))
    expect(readTourRun(true)).toBeNull()
    // Without a page, the story is shorter: the index names another step.
    sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, page: false, stepId: "talk" }))
    expect(readTourRun(true)).toBeNull()
  })
})

describe("The tour, with a teammate or the artist at a screen of its own", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const run = { ...begin(), step: 1 }
  const held = signals(quiet, true, {
    roles: { lead: "t1", artist: "t4" },
    teamScreen: { terminalId: "t3", screen: "startup", program: "codex" },
  })

  it("points at that teammate, in its harness's words", () => {
    expect(coachNow(run, tourSteps, held)).toMatchObject({
      line: "A teammate wants an answer first.",
      terminalId: "t3",
      click: ["terminal"],
    })
  })

  it("says the artist isn't a teammate", () => {
    const artist = { ...held, teamScreen: { ...held.teamScreen!, terminalId: "t4" } }
    expect(coachNow(run, tourSteps, artist)?.line).toBe("The other agent wants an answer first.")
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
      line: "It's asking your permission.",
      terminalId: "t3",
      click: ["terminal"],
    })
  })

  it("lets a screen of the agent's own come first", () => {
    const screen = signals({ kind: "screen", screen: "startup" }, true, {
      permission: { terminalId: "t3" },
    })
    expect(coachNow(run, steps, screen)?.line).toBe("It wants an answer first.")
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
  const roles = { lead: "t1", artist: "t4" }
  const startFor = (brief: "launch" | "doorbell" = "doorbell") =>
    beginRun({ terminalId: "t1", agent: "claude", brief, command: "claude", page: true }, 0)

  it("says it didn't start, with the lead's terminal marked, and counts no wait", () => {
    const run = startFor()
    const left = signals({ kind: "left" })
    expect(coachNow(run, tourSteps, left)).toMatchObject({
      line: "It didn't start.",
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

  it("rings the artist's brief the same way after it left", () => {
    const run = { ...startFor(), briefed: true, artist: "t4" }
    const left = signals(quiet, true, {
      roles,
      artist: { kind: "left" },
      teamLeft: { terminalId: "t4" },
    })
    const gone = stepRun(run, tourSteps, { type: "signals", signals: left, now: 1 }, patience)
    expect(gone.artist).toBeNull()
    expect(coachNow(run, tourSteps, left)).toMatchObject({
      line: "It didn't start.",
      terminalId: "t4",
    })
    expect(coachNow(run, tourSteps, left)?.note).toMatch(/End the tour and take it again/)
    const back = signals(quiet, true, { roles, artist: quiet })
    expect(
      stepRun(gone.run!, tourSteps, { type: "signals", signals: back, now: 2 }, patience).artist,
    ).toBe("brief")
  })

  it("tells a teammate that left to take the tour again", () => {
    const left = signals(quiet, true, { roles, teamLeft: { terminalId: "t3" } })
    expect(coachNow(startFor(), tourSteps, left)?.note).toBe(
      "Its terminal says why. End the tour and take it again.",
    )
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

  it("says exactly what to pick on the folder trust screen, by harness", () => {
    expect(screenCoach("startup", "claude").note).toContain('"Yes, I trust this folder"')
    expect(screenCoach("startup", "codex").note).toContain('"Trust and continue"')
    expect(screenCoach("startup", "agy").note).toMatch(/trust the tour's folder/)
    expect(screenCoach("startup", "claude").line).toBe("It wants an answer first.")
  })
})

describe("The tour's parts that drop out", () => {
  const quiet: LeadState = { kind: "agent", working: false, named: true, answered: true }
  const working: LeadState = { kind: "agent", working: true, named: true, answered: true }
  const cast = { lead: "t1", sculptor: "t2", fixer: "t3", artist: "t4" }
  const world = (story: Partial<TourSignals> = {}): TourSignals =>
    signals(quiet, true, {
      roles: cast,
      mates: { sculptor: quiet, fixer: quiet },
      artist: quiet,
      ...story,
    })
  const run0 = (): TourRun =>
    beginRun(
      { terminalId: "t1", agent: "claude", brief: "doorbell", command: "claude", page: true },
      0,
    )
  const at = (id: string, parts: Partial<TourRun> = {}): TourRun => {
    const run = { ...run0(), briefed: true, ...parts }
    return {
      ...run,
      step: stepsOfRun(run, true).findIndex((step) => step.id === id),
      entered: true,
    }
  }
  const feed = (run: TourRun, story: TourSignals, now: number) =>
    stepRun(run, stepsOfRun(run, true), { type: "signals", signals: story, now }, patience)
  const ids = (run: TourRun) => stepsOfRun(run, true).map(({ id }) => id)

  it("keeps the shape step in the story without a page, leaving out only the run and the page", () => {
    expect(stepsOf(false, true).map(({ id }) => id)).toEqual([
      "start",
      "team",
      "shape",
      "ask",
      "files",
      "model",
      "diff",
      "outsider",
      "talk",
      "cover",
      "play",
    ])
  })

  context("when the lead's run is declined", () => {
    it("goes on as it did when allowed: the page steps stay", () => {
      let run: TourRun = at("run")
      run = feed(run, world({ approving: true }), 1).run!
      run = feed(run, world({ served: true }), 2).run!
      expect(run).toMatchObject({ declined: false })
      expect(ids(run)).toContain("page")
      expect(stepsOfRun(run, true)[run.step]?.id).toBe("page")
      // Nothing is taken as declined later, however long it takes.
      expect(feed(run, world({ served: true }), 2 + 10 * declineMs).run?.declined).toBe(false)
    })

    it("drops the page steps once the approval is gone and no terminal opened, then plays on", () => {
      let run: TourRun = at("run")
      run = feed(run, world({ approving: true }), 1).run!
      // Gone, not served: a few seconds are allowed for the terminal to open.
      run = feed(run, world(), 100).run!
      expect(run.declined).toBe(false)
      expect(nextTick(run, stepsOfRun(run, true), world(), 1e9)).toBe(100 + declineMs)
      const after = feed(run, world(), 100 + declineMs)
      expect(after.run).toMatchObject({ declined: true })
      expect(stepsOfRun(after.run!, true)[after.run!.step]?.id).toBe("shape")
      expect(ids(after.run!)).not.toContain("page")
      expect(ids(after.run!)).not.toContain("run")
    })

    it("ends on the sculptor's model with the no-page line", () => {
      const run = at("play", { declined: true })
      expect(coachNow(run, stepsOfRun(run, true), world())).toMatchObject({
        look: "sculptor-pane",
        line: "Four agents. One game. Yours.",
      })
    })

    it("is not brought back by a reload", () => {
      const run: TourRun = { ...at("shape", { declined: true }), approvalSeen: true }
      sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "shape" }))
      expect(readTourRun(true)).toMatchObject({ declined: true, approvalSeen: false })
      // The same index of a story with the page would be another step: dropped.
      sessionStorage.setItem(
        "novadeck.tour",
        JSON.stringify({ ...run, declined: false, stepId: "shape" }),
      )
      expect(readTourRun(true)).toBeNull()
    })
  })

  context("when the artist is gone for good", () => {
    const withArtist = (id: string) => at(id, { artist: "t4", artistBriefed: true })

    it("drops its steps once its terminal is closed, and ends on a line for three agents", () => {
      const run = withArtist("talk")
      const outcome = feed(run, world({ artist: null }), 1)
      expect(outcome.run).toMatchObject({ artistDropped: true })
      expect(stepsOfRun(outcome.run!, true)[outcome.run!.step]?.id).toBe("play")
      expect(coachNow(outcome.run!, stepsOfRun(outcome.run!, true), world())?.line).toBe(
        "Three agents. One game. Go play.",
      )
    })

    it("does the same once its process ended", () => {
      const outcome = feed(withArtist("cover"), world({ artist: { kind: "ended" } }), 1)
      expect(outcome.run?.artistDropped).toBe(true)
    })

    it("does the same where its agent never came up within the step's patience", () => {
      const run = withArtist("outsider")
      const first = feed(run, world({ artist: { kind: "starting" } }), 10)
      expect(first.run).toMatchObject({ artistDropped: false, startingSince: 10 })
      expect(
        nextTick(
          first.run!,
          stepsOfRun(first.run!, true),
          world({ artist: { kind: "starting" } }),
          patience,
        ),
      ).toBe(10 + patience)
      const later = feed(first.run!, world({ artist: { kind: "starting" } }), 10 + patience)
      expect(later.run?.artistDropped).toBe(true)
    })

    it("keeps the artist while its terminal has not been opened, or has left", () => {
      expect(feed(at("outsider"), world({ artist: null }), 1).run?.artistDropped).toBe(false)
      const left = world({ artist: { kind: "left" }, teamLeft: { terminalId: "t4" } })
      expect(feed(withArtist("cover"), left, 1).run?.artistDropped).toBe(false)
      expect(coachNow(withArtist("cover"), tourSteps, left)?.line).toBe("It didn't start.")
    })

    it("is kept through a reload, and the three-agent story is the one followed", () => {
      const run = at("play", { artist: "t4", artistDropped: true })
      sessionStorage.setItem("novadeck.tour", JSON.stringify({ ...run, stepId: "play" }))
      expect(readTourRun(true)).toMatchObject({ artistDropped: true })
    })
  })

  context("in whom a step waits on", () => {
    const tickAt = (id: string, story: TourSignals) =>
      stepRun(
        { ...at(id), waitingSince: 0 },
        stepsOfRun(at(id), true),
        { type: "tick", signals: story, now: patience },
        patience,
      )

    it("nudges the sculptor at the files until the hero changed, then the fixer", () => {
      expect(tickAt("files", world()).nudge).toBe("t2")
      expect(tickAt("files", world({ changed: { hero: true, score: false } })).nudge).toBe("t3")
    })

    it("nudges the sculptor at the model and the fixer at the diff", () => {
      expect(tickAt("model", world()).nudge).toBe("t2")
      expect(tickAt("diff", world()).nudge).toBe("t3")
    })

    it("counts no silence while that teammate works on its turn, though the lead is quiet", () => {
      const busy = world({ mates: { sculptor: working, fixer: quiet } })
      expect(tickAt("model", busy).nudge).toBeNull()
      const run = { ...at("model"), waitingSince: 0 }
      expect(nextTick(run, stepsOfRun(run, true), busy, patience)).toBeNull()
      expect(nextTick(run, stepsOfRun(run, true), world(), patience)).toBe(patience)
    })
  })
})
