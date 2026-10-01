import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TerminalRequest as RunnerRequest, TerminalRequestAnswer } from "@novadeck/protocol"
import { afterAll, vi } from "vitest"

import { workspaceFromSeed } from "../../model/seed"
import { activeProject, activeSession, workspaceReducer } from "../../model/state"
import type { Workspace } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import type { BackendAction, TerminalRequest } from "../port"
import { runnerBackend, type RunnerApi } from "./backend"
import { startTestRunner } from "./testing"

vi.setConfig({ testTimeout: 20_000 })

// A real runner, whose shells start with configured arguments, so they run no command.
const runner = await startTestRunner()
// Native, as the runner resolves folders: on Windows it also expands short names.
const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-requests-")))
afterAll(async () => {
  await runner.close()
  rmSync(folder, { recursive: true, force: true })
})

// Requests pushed by the test, as the runner would send them.
const requests = () => {
  const queued: RunnerRequest[] = []
  let wake: (() => void) | undefined
  const iterator: AsyncIterableIterator<RunnerRequest, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed request.
      while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
      return { value: queued.shift()!, done: false }
    },
    return: async () => ({ value: undefined, done: true }),
  }
  return {
    iterator,
    push: (request: RunnerRequest) => {
      queued.push(request)
      wake?.()
    },
  }
}

// A backend over the runner, whose requests the test sends and whose answers it reads.
// `app` stands in for the app: it is handed each request, with the workspace to add to.
const open = (app: (request: TerminalRequest, add: (command?: string) => string) => void) => {
  const asked = requests()
  const answers: TerminalRequestAnswer[] = []
  const api: RunnerApi = {
    ...runner.client,
    terminals: {
      ...runner.client.terminals,
      requests: () => asked.iterator,
      answerRequest: async (answer) => void answers.push(answer),
    },
  }
  const { backend, idle } = runnerBackend(api, runner.listing, { saveDelay: 10 })
  let workspace: Workspace = workspaceFromSeed(backend.seed, {
    view: "grid",
    windowedView: "grid",
    now: 1,
  })
  backend.commit(workspace, [])
  const received: BackendAction[] = []
  const target = () => ({
    projectId: activeProject(workspace)!.id,
    workspaceSessionId: activeSession(workspace)!.id,
  })
  const stop = backend.start!({
    dispatch: (actions) => {
      received.push(...actions)
      workspace = actions.reduce(workspaceReducer, workspace)
      backend.commit(workspace, actions)
    },
    open: (request) =>
      app(request, (command) => {
        const terminal = backend.newTerminal({
          target: target(),
          directory: request.directory,
          launch: command === undefined ? {} : { command },
        })
        const actions = [{ type: "terminal/add" as const, target: target(), terminal }]
        workspace = actions.reduce(workspaceReducer, workspace)
        backend.commit(workspace, actions)
        return terminal.id
      }),
  })
  const request = (fields: Partial<RunnerRequest> = {}): RunnerRequest => ({
    requestId: crypto.randomUUID(),
    from: crypto.randomUUID(),
    sessionId: target().workspaceSessionId,
    cwd: folder,
    focus: false,
    ...fields,
  })
  // Waits for every answer the backend owes so far.
  const answered = async (count: number) => {
    await vi.waitFor(() => expect(answers.length).toBeGreaterThanOrEqual(count))
    await idle()
    return answers
  }
  return { asked, answers, answered, received, request, stop, workspace: () => workspace }
}

describe("requests for a terminal through the runner backend", () => {
  context("when the app adds a terminal for a request", () => {
    it("starts it in the asked folder and answers with its id once the runner has it", async () => {
      const handed: TerminalRequest[] = []
      const app = open((request, add) => {
        handed.push(request)
        request.answer({ terminalId: add(request.command) })
      })
      const sent = app.request({ title: "Server", focus: true })
      app.asked.push(sent)
      const [answer] = await app.answered(1)
      expect(handed).toEqual([
        {
          from: sent.from,
          directory: folder,
          title: "Server",
          focus: true,
          answer: expect.any(Function),
        },
      ])
      const terminalId = (answer as { terminalId: string }).terminalId
      expect(answer).toEqual({ requestId: sent.requestId, terminalId })
      const listed = await runner.client.terminals.list({ sessionId: sent.sessionId })
      expect(listed.find((terminal) => terminal.id === terminalId)?.cwd).toBe(folder)
      app.stop()
    })
  })

  context("when the runner can't start the request's command", () => {
    it("closes the terminal again and tells the agent why", async () => {
      const app = open((request, add) => request.answer({ terminalId: add(request.command) }))
      const sent = app.request({ command: "claude" })
      app.asked.push(sent)
      const [answer] = await app.answered(1)
      expect(answer).toEqual({
        requestId: sent.requestId,
        reason: expect.stringMatching(
          /^NovaDeck couldn't start the command in a new terminal\. .*can't start a command/,
        ),
      })
      const closed = app.received.find((action) => action.type === "terminal/close")
      expect(closed).toBeDefined()
      const { terminals } = activeSession(app.workspace())!.state.roster
      expect(terminals.some((terminal) => terminal.id === closed?.terminalId)).toBe(false)
      app.stop()
    })
  })

  context("when the app answers why it can't", () => {
    it("passes its reason on, once, however often the app answers", async () => {
      const app = open((request) => {
        request.answer({ reason: "Not here." })
        request.answer({ reason: "Again." })
      })
      const sent = app.request()
      app.asked.push(sent)
      await app.answered(1)
      expect(app.answers).toEqual([{ requestId: sent.requestId, reason: "Not here." }])
      app.stop()
    })
  })
})
