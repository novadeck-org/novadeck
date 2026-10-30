import { openLogsChannel, rendererPoolChannel, uiErrorChannel } from "../../bridge"
import { context, describe, expect, it } from "../../test"
import { appLog } from "./logs.test-support"
import { registerLogIpc, uiErrorOf } from "./ui"

describe("the page's logs and errors", () => {
  // A page's web contents: an id, and the events it can be told of.
  const contents = (id: number) => {
    const handlers: [string, (...args: never[]) => void][] = []
    const known = {
      id,
      on: (name: string, handler: (...args: never[]) => void) =>
        void handlers.push([name, handler]),
      once: (name: string, handler: (...args: never[]) => void) =>
        void handlers.push([name, handler]),
      // Every listener of the event hears it.
      emit: (name: string, ...args: unknown[]) =>
        handlers
          .filter(([event]) => event === name)
          .forEach(([, handler]) => (handler as (...args: unknown[]) => void)(...args)),
      listeners: () => handlers.length,
    }
    return known
  }
  const first = contents(1)
  const page = () => first

  // An ipcMain that keeps its listeners, to call as the page would.
  const ipc = () => {
    const listeners = new Map<string, (event: unknown, value?: unknown) => void>()
    return {
      on: (channel: string, listener: (event: unknown, value?: unknown) => void) => {
        listeners.set(channel, listener)
      },
      send: (channel: string, own: boolean, value?: unknown, sender: unknown = page()) =>
        listeners.get(channel)?.({ own, sender }, value),
    }
  }

  const setup = () => {
    const { logger, lines } = appLog()
    const opened: string[] = []
    const fake = ipc()
    registerLogIpc(fake as never, {
      window: (event) => (event as unknown as { own: boolean }).own,
      openLogs: () => void opened.push("logs"),
      log: logger.for("page", "ui"),
    })
    return { logger, lines, opened, send: fake.send }
  }

  it("opens the logs folder for the app's own page alone", () => {
    const { logger, opened, send } = setup()
    send(openLogsChannel, false)
    send(openLogsChannel, true)
    logger.close()
    expect(opened).toEqual(["logs"])
  })

  it("logs an error the page didn't catch as the page's, redacted", () => {
    const { logger, lines, send } = setup()
    send(uiErrorChannel, true, {
      kind: "error",
      name: "TypeError",
      message: "x is undefined in /home/ana/acme/a.ts",
      stack: "TypeError: x is undefined\n    at f (index.js:1:2)",
    })
    send(uiErrorChannel, false, { kind: "error", name: "Error", message: "not ours" })
    logger.close()
    const written = lines()
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(
      expect.objectContaining({ proc: "ui", src: "page", evt: "ui.error", level: "error" }),
    )
    expect(written[0]?.err?.message).toMatch(
      /^x is undefined in ~\/#[0-9a-f]{8}\/#[0-9a-f]{8}\.ts$/,
    )
  })

  it("logs the counts of the page's WebGL pool, from the app's own page, as numbers only", () => {
    const { logger, lines, send } = setup()
    const counts = { waits: 2, steals: 1, swaps: 9, lost: 0, failed: 0, resizes: 3, onDom: 1 }
    send(rendererPoolChannel, true, counts)
    send(rendererPoolChannel, false, counts)
    send(rendererPoolChannel, true, { ...counts, swaps: "9" })
    send(rendererPoolChannel, true, { ...counts, waits: -1 })
    send(rendererPoolChannel, true, { waits: 1 })
    logger.close()
    const written = lines()
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(
      expect.objectContaining({ proc: "ui", evt: "ui.renderer-pool", level: "info", data: counts }),
    )
  })

  context("for a pool report the same as the last one", () => {
    const counts = { waits: 2, steals: 1, swaps: 9, lost: 0, failed: 0, resizes: 3, onDom: 1 }

    it("logs it once for a page, and again from another window", () => {
      const { logger, lines, send } = setup()
      send(rendererPoolChannel, true, counts)
      send(rendererPoolChannel, true, counts)
      send(rendererPoolChannel, true, counts, contents(2))
      logger.close()
      expect(lines()).toHaveLength(2)
    })

    it("logs it again once the page navigated, or closed", () => {
      const { logger, lines, send } = setup()
      const other = contents(2)
      send(rendererPoolChannel, true, counts)
      send(rendererPoolChannel, true, counts, other)
      first.emit("did-navigate")
      send(rendererPoolChannel, true, counts)
      other.emit("destroyed")
      send(rendererPoolChannel, true, counts, other)
      logger.close()
      expect(lines()).toHaveLength(4)
    })

    it("listens to a window once, however often it navigates", () => {
      const { logger, lines, send } = setup()
      const window = contents(3)
      for (let n = 1; n <= 12; n++) {
        send(rendererPoolChannel, true, { ...counts, swaps: n }, window)
        window.emit("did-navigate")
        send(rendererPoolChannel, true, { ...counts, swaps: n }, window)
      }
      logger.close()
      expect(window.listeners()).toBe(2)
      expect(lines()).toHaveLength(24)
    })
  })

  context("for a rejected promise whose reason quotes what it parsed", () => {
    it("keeps none of it", () => {
      const { logger, lines, send } = setup()
      send(uiErrorChannel, true, {
        kind: "rejection",
        name: "SyntaxError",
        message: "Unexpected token 'd', \"dear team, the merger\" is not valid JSON",
        stack: "SyntaxError: Unexpected token 'd', \"dear team, the merger\" is not valid JSON",
      })
      logger.close()
      const [line] = lines()
      expect(line?.evt).toBe("ui.rejection")
      expect(JSON.stringify(line)).not.toContain("merger")
    })
  })

  it("drops a report that is not one", () => {
    expect(uiErrorOf({ kind: "other", name: "x", message: "y" })).toBeUndefined()
    expect(uiErrorOf({ kind: "error", name: 1, message: "y" })).toBeUndefined()
    expect(uiErrorOf("boom")).toBeUndefined()
    expect(
      uiErrorOf({ kind: "error", name: "E", message: "m".repeat(5_000) })?.message,
    ).toHaveLength(2_000)
  })
})
