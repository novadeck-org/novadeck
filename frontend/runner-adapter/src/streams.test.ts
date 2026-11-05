import type { TerminalRequest as AppRequest } from "@novadeck/core/port"
import type { TerminalRequest } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { consume } from "./streams"
import { context, describe, expect, it } from "./test"
import { channel } from "./testing/channel"
import { catchReports } from "./testing/reported"
import { id, scripted } from "./testing/scripted"

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

describe("following a runner stream", () => {
  context("when a handler throws", () => {
    it("reports it and hands it the next item as usual", async () => {
      const { reported, restore } = catchReports()
      const broken = new Error("The handler broke.")
      const items = channel<number>()
      const handled: number[] = []
      try {
        const following = consume(items.iterator, (item) => {
          handled.push(item)
          if (item === 1) throw broken
        })
        items.push(1)
        items.push(2)
        items.end()
        await following
      } finally {
        restore()
      }
      expect(handled).toEqual([1, 2])
      expect(reported).toEqual([broken])
    })
  })

  context("when the stream itself fails", () => {
    it("ends quietly: the connection says why", async () => {
      const { reported, restore } = catchReports()
      const items = channel<number>()
      const handled: number[] = []
      try {
        const following = consume(items.iterator, (item) => handled.push(item))
        items.push(1)
        items.fail(new WireError("CLOSED"))
        items.push(2)
        await following
      } finally {
        restore()
      }
      expect(handled).toEqual([1])
      expect(reported).toEqual([])
    })
  })
})

describe("an agent's request for a terminal", () => {
  context("when the app throws as it opens one", () => {
    it("answers that agent at once, and the next request still reaches the app", async () => {
      const { reported, restore } = catchReports()
      const broken = new Error("A transaction cannot start inside a commit.")
      const requests = channel<TerminalRequest>()
      const handed: AppRequest[] = []
      const runner = scripted({
        shown: [],
        requests: requests.iterator,
        open: (request) => {
          handed.push(request)
          if (handed.length === 1) throw broken
        },
      })
      const request = (n: number, command?: string): TerminalRequest => ({
        requestId: id(100 + n),
        from: id(200 + n),
        sessionId: id(8),
        cwd: "/tmp",
        focus: false,
        ...(command !== undefined && { command }),
      })
      try {
        requests.push(request(1, "pnpm test"))
        await pause()
        requests.push(request(2))
        await pause()
        await runner.idle()
      } finally {
        runner.stop()
        restore()
      }
      expect(handed.map((each) => each.directory)).toEqual(["/tmp", "/tmp"])
      expect(runner.of("answer request")).toEqual([
        {
          requestId: id(101),
          reason: "Novadeck couldn't start the command in a new terminal.",
        },
      ])
      expect(reported).toEqual([broken])
    })

    it("follows the terminal the app added before it threw, rather than say it didn't open", async () => {
      const { reported, restore } = catchReports()
      const broken = new Error("A reader of the commit broke.")
      const requests = channel<TerminalRequest>()
      const target = { projectId: "p", workspaceSessionId: id(8) }
      const runner = scripted({
        shown: [],
        requests: requests.iterator,
        open: (request) => {
          const terminal = runner.backend.newTerminal({
            target,
            directory: request.directory,
            launch: { command: "pnpm test" },
          })
          runner.commit({ type: "terminal/add", target, terminal })
          throw broken
        },
      })
      try {
        requests.push({
          requestId: id(101),
          from: id(201),
          sessionId: id(8),
          cwd: "/tmp",
          focus: false,
          command: "pnpm test",
        })
        // The runner never answers the create here, so the request waits on its terminal.
        await vi.waitFor(() =>
          expect(runner.of("create")).toEqual([
            expect.objectContaining({ command: "pnpm test", requestId: id(101) }),
          ]),
        )
        await pause()
      } finally {
        runner.stop()
        restore()
      }
      expect(runner.of("answer request")).toEqual([])
      expect(reported).toEqual([broken])
    })
  })
})
