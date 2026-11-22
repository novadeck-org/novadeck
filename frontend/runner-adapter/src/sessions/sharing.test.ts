import { createTerminalState, workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import { terminalFixture, workspaceFixture } from "@novadeck/core/testing"
import type { Workspace } from "@novadeck/core/types"
import type { SessionChange, SessionPatch } from "@novadeck/protocol"
import type { Runner } from "@novadeck/runner-client"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { channel } from "../testing/channel"
import { applyPatch } from "./patch"
import { createSessionSaves } from "./saves"
import { createSessionSharing } from "./sharing"
import { encodeSession } from "./state"

const target = { projectId: "project", workspaceSessionId: "initial" }
const at = (x: number) => ({ position: { x, y: 0 }, width: 400, height: 300 })

// A change sent to the runner: it lands, and is answered, when the test says.
type Call = {
  readonly patch: SessionPatch
  readonly land: () => number
  readonly answer: () => Promise<void>
}

// One window's saves and sharing over a runner the test plays: it holds the session's state
// and revision, lands the window's changes and another client's when told, and feeds what
// lands as the test pushes it.
const sharedWindow = async ({
  stored = true,
  named = {},
}: {
  readonly stored?: boolean
  // Terminals' canvas places the stored state holds beyond the window's own.
  readonly named?: Record<string, object>
} = {}) => {
  let workspace: Workspace = [
    {
      type: "canvas/layout",
      target,
      layout: { geometry: { "01": at(0), "02": at(500) } },
    } satisfies WorkspaceAction,
  ].reduce(workspaceReducer, workspaceFixture({ view: "canvas" }))
  // Where `stored` is false, no client saved the session yet.
  const server = {
    state: stored
      ? withPlaces(encodeSession(workspace.projects[0]!.history[0]!), named)
      : (null as string | null),
    revision: stored ? 5 : 0,
    name: "initial",
    // The project went on the runner, as another client removed it.
    gone: false,
  }
  const held = () => ({
    id: "initial",
    projectId: "project",
    name: server.name,
    state: server.state,
    visitedAt: 0,
    revision: server.revision,
  })
  const feed = channel<SessionChange>()
  const calls: Call[] = []
  const dispatched: WorkspaceAction[] = []
  const runner = {
    supports: () => true,
    sessions: {
      change: (input: { readonly patch: SessionPatch }) =>
        new Promise<{ revision: number }>((resolve) => {
          let revision = 0
          calls.push({
            patch: input.patch,
            land: () => {
              server.state = JSON.stringify(
                applyPatch(JSON.parse(server.state ?? "{}"), input.patch),
              )
              revision = ++server.revision
              return revision
            },
            answer: async () => {
              resolve({ revision })
              await new Promise((done) => setTimeout(done, 0))
            },
          })
        }),
      watch: () => feed.iterator,
      list: async () => {
        if (server.gone) throw new WireError("NOT_FOUND", "Project not found")
        return [held()]
      },
      save: async () => {},
    },
  } as unknown as Pick<Runner, "sessions" | "supports">
  const sharing = createSessionSharing({
    runner,
    saves: () => saves,
    latest: () => workspace,
    dispatch: (actions) => commit(actions as WorkspaceAction[]),
    track: (work) => work,
    // As the backend does: listed unopened, unless held already.
    arrive: (session) => {
      const project = workspace.projects.find(({ id }) => id === session.projectId)
      if (!project || project.history.some(({ id }) => id === session.id)) return false
      commit([
        {
          type: "session/arrived",
          projectId: project.id,
          session: {
            id: session.id,
            name: session.name,
            visitedAt: null,
            state: createTerminalState([], "grid", "grid"),
          },
        },
      ])
      return true
    },
  })
  const saves = createSessionSaves({
    save: sharing.save,
    ready: () => Promise.resolve(true),
    latest: () => workspace,
    track: (work) => work,
    halted: () => false,
    delay: 60_000,
    saved: [],
  })
  const commit = (actions: readonly WorkspaceAction[]): void => {
    workspace = actions.reduce(workspaceReducer, workspace)
    dispatched.push(...actions)
    saves.note(workspace)
    sharing.seen(
      false,
      actions.flatMap((action) => (action.type === "project/sync" ? [action.project.id] : [])),
    )
  }
  sharing.listed([held()])
  saves.note(workspace)
  sharing.seen(true, [])
  sharing.follow()
  // Another client's change to terminal `id` lands on the runner.
  const theirs = (id: string, x: number): number => {
    const state = JSON.parse(server.state ?? "{}") as {
      state: { layout: { canvas: { geometry: Record<string, unknown> } } }
    }
    state.state.layout.canvas.geometry[id] = at(x)
    server.state = JSON.stringify(state)
    return ++server.revision
  }
  // Another client, looking elsewhere, saves its view.
  const theirView = (view: string, selected: string): number => {
    const state = JSON.parse(server.state ?? "{}") as { state: Record<string, unknown> }
    Object.assign(state.state, { view, windowedView: view, selected })
    server.state = JSON.stringify(state)
    return ++server.revision
  }
  // What lands, fed as the runner feeds it.
  const feeds = async (writer: string): Promise<void> => {
    feed.push({ type: "changed", session: held(), writer, base: null })
    await new Promise((done) => setTimeout(done, 0))
  }
  const moves = (id: string, x: number): void =>
    commit([
      {
        type: "canvas/layout",
        target,
        layout: (layout) => ({ geometry: { ...layout.geometry, [id]: at(x) } }),
      },
    ])
  // Sends what changed, and waits for the call to be made.
  const sends = async (): Promise<Call> => {
    const before = calls.length
    saves.flush()
    await vi.waitFor(() => expect(calls.length).toBe(before + 1))
    return calls.at(-1)!
  }
  const geometry = () => workspace.projects[0]!.history[0]!.state.layout.canvas.geometry
  const runnerGeometry = () =>
    (JSON.parse(server.state ?? "{}") as { state: { layout: { canvas: { geometry: unknown } } } })
      .state.layout.canvas.geometry
  // The first commit's lay-in runs once the commit is done, before the person can do anything.
  await new Promise((done) => setTimeout(done, 0))
  const session = () => workspace.projects[0]!.history[0]!
  const opens = (number: number): void =>
    commit([{ type: "terminal/add", target, terminal: terminalFixture(number, "~/project") }])
  return {
    server,
    dispatched,
    opens,
    // Another client's session as the runner feeds it.
    feedsSession: async (made: { id: string; projectId: string; name: string }) => {
      feed.push({
        type: "changed",
        session: { ...made, state: null, visitedAt: null, revision: 0 },
        writer: null,
        base: null,
      })
      await new Promise((done) => setTimeout(done, 0))
    },
    workspace: () => workspace,
    // The runner's feed ends with `error`, as once the runner closed.
    feedEnds: (error: unknown) => feed.fail(error),
    // The feed opens again with the runner's revisions, as after the link came back.
    reopens: async (revisions: Record<string, number>) => {
      feed.push({ type: "revisions", revisions })
      await new Promise((done) => setTimeout(done, 0))
    },
    moves,
    sends,
    theirs,
    theirView,
    feeds,
    commit,
    session,
    geometry,
    runnerGeometry,
    calls,
    saves,
    stop: sharing.stop,
  }
}

// `state` (a saved state) with these canvas places too.
const withPlaces = (state: string, places: Record<string, object>): string => {
  const value = JSON.parse(state) as {
    state: { layout: { canvas: { geometry: Record<string, unknown> } } }
  }
  Object.assign(value.state.layout.canvas.geometry, places)
  return JSON.stringify(value)
}

const records = (patch: SessionPatch) => patch.set.map(({ path }) => path.join("."))

describe("a session shared while changes cross", () => {
  context("when another client's change lands while this one's is on its way", () => {
    it("shows the other's, keeps its own, and sends the other's back never", async () => {
      const window = await sharedWindow()
      window.moves("01", 10)
      const mine = await window.sends()
      window.theirs("02", 900)
      await window.feeds("other")
      // Its own change on the way stays; the other's shows.
      expect(window.geometry()).toEqual({ "01": at(10), "02": at(900) })
      mine.land()
      await mine.answer()
      // Its next change, before its own comes back on the feed, is its own alone: what the
      // other wrote isn't sent as its.
      window.moves("01", 20)
      const next = await window.sends()
      expect(records(next.patch)).toEqual(["state.layout.canvas.geometry.01"])
      next.land()
      await next.answer()
      await window.feeds("this")
      expect(window.geometry()).toEqual({ "01": at(20), "02": at(900) })
      expect(window.runnerGeometry()).toEqual({ "01": at(20), "02": at(900) })
      window.stop()
    })

    it("holds the other's even when its own answer comes before the feed", async () => {
      const window = await sharedWindow()
      window.moves("01", 10)
      const mine = await window.sends()
      window.theirs("02", 900)
      mine.land()
      await mine.answer()
      await window.feeds("this")
      expect(window.geometry()).toEqual({ "01": at(10), "02": at(900) })
      window.moves("01", 20)
      expect(records((await window.sends()).patch)).toEqual(["state.layout.canvas.geometry.01"])
      window.stop()
    })
  })

  // Its change landed, then another's on the same terminal, and the feed gives only the later
  // before the answer comes: the other's is the later, and shows.
  it("shows the later change to one terminal when the feed overtakes its own answer", async () => {
    const window = await sharedWindow()
    window.moves("01", 10)
    const mine = await window.sends()
    mine.land()
    window.theirs("01", 99)
    await window.feeds("other")
    await mine.answer()
    expect(window.geometry()).toEqual({ "01": at(99), "02": at(500) })
    window.saves.flush()
    expect(window.calls).toHaveLength(1)
    window.stop()
  })

  context("where each client looks", () => {
    it("leaves another client's view theirs, and sends none back", async () => {
      const window = await sharedWindow()
      window.theirView("grid", "02")
      await window.feeds("other")
      window.saves.flush()
      await new Promise((done) => setTimeout(done, 0))
      expect([window.session().state.view, window.calls]).toEqual(["canvas", []])
      // A change of its own goes alone, without its view over theirs.
      window.moves("01", 10)
      expect(records((await window.sends()).patch)).toEqual(["state.layout.canvas.geometry.01"])
      window.stop()
    })

    it("sends its view once the person changes it here", async () => {
      const window = await sharedWindow()
      window.commit([
        { type: "view/change", target, view: "grid", enabledViews: ["focus", "grid", "canvas"] },
      ])
      expect(records((await window.sends()).patch)).toContain("state.view")
      window.stop()
    })
  })

  it("shows another client's rename, and never sends it back", async () => {
    const window = await sharedWindow()
    window.server.name = "Renamed"
    window.server.revision += 1
    await window.feeds("other")
    expect(window.session().name).toBe("Renamed")
    expect(window.dispatched.map(({ type }) => type)).not.toContain("session/rename")
    window.saves.flush()
    await new Promise((done) => setTimeout(done, 0))
    expect(window.calls).toEqual([])
    window.stop()
  })

  // Another client opened terminal 03 and placed it; this one doesn't know 03 yet.
  context("when what arrives names a terminal not known here yet", () => {
    it("leaves it out here, sends no removal of it, and lays it in once it's known", async () => {
      const window = await sharedWindow()
      window.theirs("03", 900)
      await window.feeds("other")
      expect(Object.keys(window.geometry())).toEqual(["01", "02"])
      window.moves("01", 10)
      const mine = await window.sends()
      expect(mine.patch).toEqual({
        set: [{ path: ["state", "layout", "canvas", "geometry", "01"], value: at(10) }],
        unset: [],
      })
      window.opens(3)
      await new Promise((done) => setTimeout(done, 0))
      expect(window.geometry()["03"]).toEqual(at(900))
      window.stop()
    })
  })

  it("takes another client's first save of a session none had saved, and sends nothing back", async () => {
    const window = await sharedWindow({ stored: false })
    const theirs = await sharedWindow()
    theirs.moves("01", 700)
    window.server.state = encodeSession(theirs.session())
    window.server.revision = 1
    await window.feeds("other")
    expect(window.geometry()).toEqual({ "01": at(700), "02": at(500) })
    window.saves.flush()
    await new Promise((done) => setTimeout(done, 0))
    expect(window.calls).toEqual([])
    window.stop()
    theirs.stop()
  })

  it("diffs its next change against the later of two saves on their way", async () => {
    const window = await sharedWindow()
    window.moves("01", 10)
    const first = await window.sends()
    window.moves("02", 600)
    const second = await window.sends()
    first.land()
    second.land()
    await first.answer()
    await second.answer()
    window.moves("01", 20)
    expect(records((await window.sends()).patch)).toEqual(["state.layout.canvas.geometry.01"])
    window.stop()
  })

  // It loads while terminal 03's shell starts: the state names 03, which this window doesn't
  // list yet.
  it("sends no removal of a terminal it loaded before knowing, and places it once known", async () => {
    const window = await sharedWindow({ named: { "03": at(900) } })
    expect(Object.keys(window.geometry())).toEqual(["01", "02"])
    window.moves("01", 10)
    expect(records((await window.sends()).patch)).toEqual(["state.layout.canvas.geometry.01"])
    window.opens(3)
    await new Promise((done) => setTimeout(done, 0))
    expect(window.geometry()["03"]).toEqual(at(900))
    window.stop()
  })

  it("ends quietly when the runner closes, as the other streams do", async () => {
    const reported = vi.fn<(error: unknown) => void>()
    vi.stubGlobal("reportError", reported)
    try {
      const window = await sharedWindow()
      window.feedEnds(new WireError("DISCONNECTED", "The connection is closed."))
      await new Promise((done) => setTimeout(done, 0))
      expect(reported).not.toHaveBeenCalled()
      window.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("catches up past a project another client removed while the link was down", async () => {
    const reported = vi.fn<(error: unknown) => void>()
    vi.stubGlobal("reportError", reported)
    try {
      const window = await sharedWindow()
      window.server.gone = true
      // Its session is no longer among the runner's: every project is read again.
      await window.reopens({})
      expect(reported).not.toHaveBeenCalled()
      window.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // A project read is taken; another client makes a session in it; the read is put in place,
  // without that session, after its feed was heard.
  context("when a project read taken just before a session was made is put in place", () => {
    const ids = (window: Awaited<ReturnType<typeof sharedWindow>>, projectId = "project") =>
      window
        .workspace()
        .projects.find(({ id }) => id === projectId)
        ?.history.map(({ id }) => id)

    it("lists that session again", async () => {
      const window = await sharedWindow()
      const read = window.workspace().projects[0]!
      await window.feedsSession({ id: "made", projectId: "project", name: "Made there" })
      expect(ids(window)).toEqual(["made", "initial"])
      window.commit([{ type: "project/sync", project: read }])
      await new Promise((done) => setTimeout(done, 0))
      expect(ids(window)).toEqual(["made", "initial"])
      window.stop()
    })

    it("lists one made in a project this client didn't know yet", async () => {
      const window = await sharedWindow()
      await window.feedsSession({ id: "made", projectId: "elsewhere", name: "Made there" })
      const read = { ...window.workspace().projects[0]!, id: "elsewhere" }
      window.commit([{ type: "project/sync", project: read }])
      await new Promise((done) => setTimeout(done, 0))
      expect(ids(window, "elsewhere")).toEqual(["made", "initial"])
      window.stop()
    })
  })
})
