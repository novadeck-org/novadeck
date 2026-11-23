import { randomUUID } from "node:crypto"

import type { TerminalControl } from "@novadeck/protocol"
import { command } from "@novadeck/terminal/testing"

import { describe, expect, it } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import type { Resources } from "../testing/resources.js"
import { plainSealer } from "../testing/sealing.js"
import { ClientWindows } from "./client-windows.js"
import { Terminals } from "./manager.js"

const cwd = process.cwd()

const fixture = async (
  resources: Resources,
  options: ConstructorParameters<typeof Terminals>[0] = {},
  /** Whether the creator still holds control, as it does until it attaches or lets go. */
  creator = false,
) => {
  const clients = new ClientWindows(() => "project")
  const redactor = { redact: async ({ text }: { text: string }) => text, close: async () => {} }
  const manager = new Terminals({
    ...ptyOptions,
    redactor,
    sealer: plainSealer(),
    clients,
    ...options,
  })
  resources.defer(() => manager.shutdown())
  const terminal = await manager.create(
    { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
    "creator",
  )
  const { id } = terminal
  if (!creator) manager.release("creator")
  const stop = (stream: AsyncGenerator<unknown>, controller: AbortController) =>
    resources.defer(async () => {
      controller.abort()
      await stream.return(undefined)
    })
  /** An attachment, its marker read; ended by `detach`. */
  const attach = async (owner: string, mode: "control" | "observe" = "observe") => {
    const controller = new AbortController()
    const stream = manager.attach({ terminalId: id, mode }, owner, controller.signal)
    stop(stream, controller)
    expect((await stream.next()).value).toMatchObject({ type: "attached", mode })
    return { stream, detach: () => stream.return(undefined) }
  }
  /** A client following `controls`: what it is told, one item at a time. */
  const follow = (owner: string) => {
    const controller = new AbortController()
    const stream = manager.controls.follow(owner, controller.signal)
    stop(stream, controller)
    const next = async (): Promise<TerminalControl> => {
      const result = await stream.next()
      if (result.done) throw new Error("The controls ended")
      return result.value
    }
    return { next, ended: async () => (await stream.next()).done }
  }
  const write = (owner: string) => manager.write({ terminalId: id, data: "x" }, owner)
  const holder = (value: TerminalControl["holder"]) => ({
    type: "control",
    terminalId: id,
    holder: value,
  })
  return { manager, clients, id, attach, follow, write, holder }
}

describe("a client's control of a terminal", () => {
  it("moves to an observer that takes it, the controller observing on", async ({ resources }) => {
    const app = await fixture(resources)
    await app.attach("first", "control")
    const first = app.follow("first")
    await app.attach("second")
    const second = app.follow("second")
    expect(await first.next()).toEqual(app.holder("you"))
    expect(await second.next()).toEqual(app.holder("other"))
    app.manager.controls.take({ terminalId: app.id }, "second")
    expect(await first.next()).toEqual(app.holder("other"))
    expect(await second.next()).toEqual(app.holder("you"))
    expect(() => app.write("first")).toThrow(expect.objectContaining({ code: "CONTROL_REQUIRED" }))
    expect(() => app.write("second")).not.toThrow()
    expect(() => app.manager.resize({ terminalId: app.id, cols: 90, rows: 20 }, "first")).toThrow(
      expect.objectContaining({ code: "CONTROL_REQUIRED" }),
    )
  })

  it("is refused to one that isn't attached, and for a terminal that isn't there", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    await app.attach("first", "control")
    expect(() => app.manager.controls.take({ terminalId: app.id }, "stranger")).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    )
    expect(() => app.manager.controls.take({ terminalId: randomUUID() }, "first")).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
    expect(() => app.write("first")).not.toThrow()
  })

  it("is refused where the controller doesn't follow controls: it couldn't learn it lost it", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    await app.attach("old", "control")
    await app.attach("new")
    app.follow("new")
    expect(() => app.manager.controls.take({ terminalId: app.id }, "new")).toThrow(
      expect.objectContaining({ code: "CONTROL_IN_USE" }),
    )
    expect(() => app.write("old")).not.toThrow()
  })

  it("is refused while the controller wrote within the idle time asked, and not after", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    await app.attach("first", "control")
    app.follow("first")
    await app.attach("second")
    app.follow("second")
    app.write("first")
    expect(() =>
      app.manager.controls.take({ terminalId: app.id, ifIdleMs: 60_000 }, "second"),
    ).toThrow(expect.objectContaining({ code: "CONTROL_BUSY" }))
    expect(() => app.write("first")).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 40))
    app.manager.controls.take({ terminalId: app.id, ifIdleMs: 20 }, "second")
    expect(() => app.write("second")).not.toThrow()
  })

  it("is taken at once from a controller that never wrote, or that is no one", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    await app.attach("first", "control")
    app.follow("first")
    await app.attach("second")
    app.manager.controls.take({ terminalId: app.id, ifIdleMs: 60_000 }, "second")
    expect(() => app.write("second")).not.toThrow()
    // The same again changes nothing.
    app.manager.controls.take({ terminalId: app.id, ifIdleMs: 60_000 }, "second")
    const empty = await fixture(resources)
    await empty.attach("viewer")
    const viewer = empty.follow("viewer")
    expect(await viewer.next()).toEqual(empty.holder("none"))
    empty.manager.controls.take({ terminalId: empty.id, ifIdleMs: 60_000 }, "viewer")
    expect(await viewer.next()).toEqual(empty.holder("you"))
  })
})

describe("the controls a client follows", () => {
  it("tell, for each terminal it is attached to, who controls it as the attachment starts", async ({
    resources,
  }) => {
    const app = await fixture(resources, {}, true)
    // The creator holds control until it attaches or lets go.
    const early = app.follow("viewer")
    await app.attach("viewer")
    expect(await early.next()).toEqual(app.holder("other"))
    // Following after attaching tells the attachment as it stands.
    const late = app.follow("viewer")
    expect(await late.next()).toEqual(app.holder("other"))
    // The creator lets go; the viewer follows, so it is handed control.
    app.manager.release("creator")
    expect(await early.next()).toEqual(app.holder("you"))
  })

  it("keep the creator in control from create until it attaches", async ({ resources }) => {
    const app = await fixture(resources, {}, true)
    expect(() => app.write("creator")).not.toThrow()
    await app.attach("creator", "control")
    expect(() => app.write("creator")).not.toThrow()
  })

  it("end with their connection", async ({ resources }) => {
    const app = await fixture(resources)
    await app.attach("viewer")
    const viewer = app.follow("viewer")
    await viewer.next()
    expect(app.manager.controls.follows("viewer")).toBe(true)
    app.manager.release("viewer")
    expect(await viewer.ended()).toBe(true)
    expect(app.manager.controls.follows("viewer")).toBe(false)
  })
})

describe("control let go of", () => {
  /** Three clients on a terminal: `first` controls, the others observe and follow. */
  const three = async (resources: Resources) => {
    const app = await fixture(resources)
    const first = await app.attach("first", "control")
    const used = await app.attach("used")
    const last = await app.attach("last")
    const feeds = {
      first: app.follow("first"),
      used: app.follow("used"),
      last: app.follow("last"),
    }
    await Promise.all(Object.values(feeds).map((feed) => feed.next()))
    return { app, first, used, last, feeds }
  }

  it("on detaching goes to the observer its client used last, and every attached one is told", async ({
    resources,
  }) => {
    const { app, first, feeds } = await three(resources)
    // `last` attached last, but the person uses `used`.
    app.clients.report("used", "project")
    app.clients.report("last", "project")
    app.clients.touch("used")
    await first.detach()
    expect(await feeds.used.next()).toEqual(app.holder("you"))
    expect(await feeds.last.next()).toEqual(app.holder("other"))
    expect(() => app.write("used")).not.toThrow()
    expect(() => app.write("last")).toThrow(expect.objectContaining({ code: "CONTROL_REQUIRED" }))
  })

  it("on a connection closing goes the same way", async ({ resources }) => {
    const { app, feeds } = await three(resources)
    app.clients.report("used", "project")
    app.clients.report("last", "project")
    app.clients.touch("used")
    app.manager.release("first")
    expect(await feeds.used.next()).toEqual(app.holder("you"))
    expect(await feeds.last.next()).toEqual(app.holder("other"))
  })

  it("goes to the observer that attached last where no client reports, and skips one not following", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const first = await app.attach("first", "control")
    await app.attach("quiet")
    await app.attach("old")
    await app.attach("new")
    // `new` attached last but never follows: an older client, which would not learn of it.
    const old = app.follow("old")
    await old.next()
    await first.detach()
    expect(await old.next()).toEqual(app.holder("you"))
    expect(() => app.write("new")).toThrow(expect.objectContaining({ code: "CONTROL_REQUIRED" }))
    expect(() => app.write("quiet")).toThrow(expect.objectContaining({ code: "CONTROL_REQUIRED" }))
  })

  it("goes to no one where no observer follows, and the observers told say so", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const first = await app.attach("first", "control")
    app.follow("first")
    await app.attach("older")
    await first.detach()
    expect(() => app.write("older")).toThrow(expect.objectContaining({ code: "CONTROL_REQUIRED" }))
    const late = app.follow("older")
    expect(await late.next()).toEqual(app.holder("none"))
    // An observer taking what no one controls.
    app.manager.controls.take({ terminalId: app.id }, "older")
    expect(await late.next()).toEqual(app.holder("you"))
  })

  it("is not handed over when the controller's attachment fails behind", async ({ resources }) => {
    const app = await fixture(resources, { subscriberBytes: 2048, ackWindowBytes: 1024 })
    const controller = new AbortController()
    const slow = app.manager.attach(
      { terminalId: app.id, mode: "control" },
      "first",
      controller.signal,
    )
    resources.defer(async () => {
      controller.abort()
      await slow.return(undefined)
    })
    await slow.next()
    await app.attach("watcher")
    const watcher = app.follow("watcher")
    expect(await watcher.next()).toEqual(app.holder("other"))
    // Output nobody acknowledges.
    for (let index = 0; index < 10; index += 1)
      app.manager.write(
        { terminalId: app.id, data: command({ type: "write", data: "x".repeat(1000) }) },
        "first",
      )
    await expect(
      (async () => {
        // eslint-disable-next-line no-await-in-loop -- Reads in order, acknowledging nothing.
        while (!(await slow.next()).done) {
          /* Read without acknowledging. */
        }
      })(),
    ).rejects.toMatchObject({ code: "SLOW_CONSUMER" })
    expect(await watcher.next()).toEqual(app.holder("none"))
    expect(() => app.write("watcher")).toThrow(
      expect.objectContaining({ code: "CONTROL_REQUIRED" }),
    )
  })
})
