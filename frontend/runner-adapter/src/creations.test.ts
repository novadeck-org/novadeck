import type { BackendAction } from "@novadeck/core/port"
import { createTerminalState, createWorkspaceSession } from "@novadeck/core/state"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { startingTerminal } from "./sessions/seed"
import { context, describe, expect, it } from "./test"
import { id, scripted } from "./testing/scripted"

vi.setConfig({ testTimeout: 10_000 })

const emptySession = (sessionId: string, name: string) =>
  createWorkspaceSession(
    { name, state: createTerminalState([], "grid", "grid") },
    { id: sessionId, now: 1 },
  )

// Answers each call with the next of `answers`, then with the last of them.
const answering = (...answers: (() => Promise<unknown>)[]) => {
  let calls = 0
  return () => answers[Math.min(calls++, answers.length - 1)]!()
}
const takes = async () => {}

describe("the projects and sessions a window creates on the runner", () => {
  context("when the runner refuses a session for a while", () => {
    it("asks for it again with its next terminal, which then starts", async () => {
      const fresh = id(20)
      let refusing = true
      const app = scripted({
        shown: [],
        createSession: async () => {
          if (refusing) throw new WireError("INTERNAL_ERROR", "The runner broke.")
        },
      })
      app.commit({
        type: "session/add",
        projectId: "p",
        activate: false,
        session: emptySession(fresh, "Fresh"),
      })
      await vi.waitFor(() => expect(app.of("create session")).not.toEqual([]))
      await app.idle()
      const refused = app.of("create session").length

      refusing = false
      const terminal = startingTerminal(id(21), "/tmp")
      app.commit({
        type: "terminal/add",
        target: { projectId: "p", workspaceSessionId: fresh },
        terminal,
      })
      await vi.waitFor(() =>
        expect(app.of("create")).toEqual([expect.objectContaining({ id: terminal.id })]),
      )
      expect(app.of("create session")).toHaveLength(refused + 1)
      expect(app.received).not.toContainEqual(
        expect.objectContaining({ type: "terminal/status", terminalId: terminal.id }),
      )
      app.stop()
    })
  })

  context("when a stop cuts off a project added while the runner was away", () => {
    it("creates the project, its session and its terminal once the backend starts again", async () => {
      const project = "q"
      const session = id(30)
      const app = scripted({
        shown: [],
        createProject: answering(async () => {
          throw new WireError("DISCONNECTED")
        }, takes),
        createSession: takes,
      })
      app.commit({
        type: "project/add",
        project: { id: project, name: "Q", directory: "/tmp" },
        activate: true,
        initialSession: emptySession(session, "Q"),
      })
      const terminal = startingTerminal(id(31), "/tmp")
      app.commit({
        type: "terminal/add",
        target: { projectId: project, workspaceSessionId: session },
        terminal,
      })
      await vi.waitFor(() => expect(app.of("create project")).toHaveLength(1))
      // Waiting for the runner as the window stops, as before a reload, or in development as
      // React runs the effects twice.
      app.stop()
      await new Promise((resolve) => setTimeout(resolve, 800))
      expect(app.of("create session")).toEqual([])
      expect(app.of("create")).toEqual([])
      // The wait for the runner let go of its status watch, as the stop did of its own.
      expect(app.statuses.returned()).toBe(2)

      const received: BackendAction[] = []
      const again = app.backend.start!({
        dispatch: (actions) => received.push(...actions),
        open: () => {},
      })
      await vi.waitFor(() =>
        expect(app.of("create")).toEqual([expect.objectContaining({ id: terminal.id })]),
      )
      expect(app.of("create project")).toHaveLength(2)
      expect(app.of("create session")).toEqual([
        expect.objectContaining({ id: session, projectId: project }),
      ])
      expect(received).not.toContainEqual(
        expect.objectContaining({ type: "terminal/status", terminalId: terminal.id }),
      )
      again()
    })
  })
})
