import { workspaceFromSeed } from "@novadeck/core/seed"
import { workspaceReducer } from "@novadeck/core/state"
import type { TerminalStatus } from "@novadeck/core/types"
import { afterEach, vi } from "vitest"

import { demoTurns } from "./agents/turns"
import {
  createDemoFiles,
  endTurnIn,
  isDemoFiles,
  nextFile,
  demoPaths,
  filesThird,
  storefrontFiles,
  withFiles,
  workingInSeed,
  writeTo,
  type FilesClock,
} from "./files"
import { demoHandle } from "./handles"
import { plainDemo } from "./index"
import { demoSeed } from "./samples"
import { context, describe, expect, it } from "./test"
import { visitorSeed } from "./visitor/seed"

const now = 1_000_000

// A clock whose timers run when a test advances it, and whose rolls are fixed.
const manual = (roll = 0.5) => {
  let time = now
  let hidden = false
  const timers = new Map<number, { at: number; run: () => void }>()
  let next = 0
  const clock: FilesClock = {
    now: () => time,
    random: () => roll,
    after: (ms, run) => {
      const id = next++
      timers.set(id, { at: time + ms, run })
      return () => void timers.delete(id)
    },
    hidden: () => hidden,
  }
  const advance = (ms: number): void => {
    const until = time + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
      const first = due.toSorted((a, b) => a[1].at - b[1].at)[0]
      if (!first) break
      timers.delete(first[0])
      time = first[1].at
      first[1].run()
    }
    time = until
  }
  return {
    clock,
    advance,
    pending: () => timers.size,
    hide: (value: boolean) => void (hidden = value),
  }
}

const project = (files: ReturnType<typeof createDemoFiles>) =>
  files.state.getSnapshot().projects.storefront!

describe("the storefront's files at boot", () => {
  it("has Moth's work behind it and Crow writing its test", () => {
    const { changes, writing } = storefrontFiles(now)
    expect(changes["src/cart/useCart.ts"]).toEqual({
      kind: "modified",
      touched: { moth: now - 7 * 60_000 },
    })
    expect(changes["src/checkout/OrderSummary.tsx"]?.kind).toBe("added")
    expect(changes["src/checkout/LegacyCheckout.tsx"]?.kind).toBe("deleted")
    expect(Object.keys(changes[demoPaths.checkout]!.touched)).toEqual(["moth", "crow"])
    expect(writing).toEqual({ crow: demoPaths.checkoutTest })
  })

  it("has nobody writing where no agent works", () => {
    expect(storefrontFiles(now, []).writing).toEqual({})
  })
})

describe("who works as the demo opens", () => {
  it("is nobody in the agents demo, where Moth waits on its plan and Codex on a permission", () => {
    const { seed, files } = plainDemo("agents")
    expect(workingInSeed(seed)).toEqual([])
    expect(isDemoFiles(files) && files.state.getSnapshot().projects.storefront!.writing).toEqual({})
  })

  it("is Crow in the try demo, and Moth too while Claude Code still reads its plan", () => {
    expect(workingInSeed(visitorSeed(now, false))).toEqual(["crow"])
    expect(workingInSeed(visitorSeed(now, true))).toEqual(["moth", "crow"])
  })

  it("marks every variant as the demo, which shows the Files panel", () => {
    for (const variant of ["plain", "welcome", "agents", "messages", "inbox"] as const)
      expect(plainDemo(variant).demo).toBe(true)
  })

  it("has no files in the demos whose storefront runs no agents", () => {
    expect(isDemoFiles(plainDemo("plain").files)).toBe(false)
    expect(isDemoFiles(plainDemo("welcome").files)).toBe(false)
    for (const variant of ["agents", "messages", "inbox"] as const)
      expect(isDemoFiles(plainDemo(variant).files)).toBe(true)
  })
})

describe("the storefront's folders", () => {
  const names = (listing: { entries: readonly { name: string }[] }): string[] =>
    listing.entries.map((entry) => entry.name)

  it("list the root's files and the folders holding the rest", async () => {
    const listing = await createDemoFiles(now).list("storefront", "")
    expect(listing.truncated).toBe(false)
    expect(names(listing)).toEqual(
      expect.arrayContaining([".github", "node_modules", "src", "package.json", ".env.local"]),
    )
    expect(listing.entries.find((entry) => entry.name === "src")).toEqual({
      name: "src",
      folder: true,
      ignored: false,
    })
  })

  it("list a folder's own entries only, without the files an agent changed", async () => {
    const listing = await createDemoFiles(now).list("storefront", "src/checkout")
    expect(names(listing)).toEqual(
      expect.arrayContaining(["AddressForm.tsx", "Checkout.tsx", "PaymentStep.tsx"]),
    )
    expect(names(listing)).not.toContain("OrderSummary.tsx")
    expect(names(listing)).not.toContain("src")
  })

  it("mark what the project ignores", async () => {
    const root = await createDemoFiles(now).list("storefront", "")
    const ignored = root.entries.filter((entry) => entry.ignored).map((entry) => entry.name)
    expect(ignored.toSorted()).toEqual([".env.local", "node_modules"])
  })

  it("list an empty folder as nothing", async () => {
    expect(await createDemoFiles(now).list("storefront", "node_modules")).toEqual({
      entries: [],
      truncated: false,
    })
  })

  it("give every sample project, and one the visitor adds, a tree of its own", async () => {
    const files = createDemoFiles(now)
    const ids = ["api-service", "docs-site", "mobile-app", "design-system", "infra", "dotfiles"]
    const roots = await Promise.all(ids.map((id) => files.list(id, "")))
    expect(roots.every((root) => root.entries.length > 0)).toBe(true)
    expect(names(await files.list("api-service", "src"))).toContain("server.ts")
    expect(names(await files.list("somewhere-new", ""))).toContain("README.md")
  })

  it("hold nothing, or list only some, at the root when the debug panel says so", async () => {
    const files = createDemoFiles(now)
    files.degrade("", "empty")
    expect(await files.list("infra", "")).toEqual({ entries: [], truncated: false })
    files.degrade("", "truncate")
    expect((await files.list("infra", "")).truncated).toBe(true)
  })

  it("refuse a folder a project doesn't have", async () => {
    const files = createDemoFiles(now)
    await expect(files.list("storefront", "src/gone")).rejects.toThrow()
  })

  it("fail, or list only some, when the debug panel says so, until it says otherwise", async () => {
    const files = createDemoFiles(now)
    files.degrade("src/cart", "fail")
    files.degrade("src/components", "truncate")
    files.degrade("", "fail")
    await expect(files.list("storefront", "src/cart")).rejects.toThrow()
    await expect(files.list("storefront", "")).rejects.toThrow()
    const partial = await files.list("storefront", "src/components")
    expect(partial.truncated).toBe(true)
    expect(partial.entries).toHaveLength(2)
    files.degrade("src/cart", undefined)
    files.degrade("", undefined)
    expect((await files.list("storefront", "src/cart")).entries).not.toHaveLength(0)
    expect((await files.list("storefront", "")).truncated).toBe(false)
  })
})

describe("a write to the project", () => {
  it("moves the agent's time on and makes the file the one it writes", () => {
    const after = writeTo(storefrontFiles(now), "crow", demoPaths.checkoutTest, now + 5)
    expect(after.changes[demoPaths.checkoutTest]).toEqual({
      kind: "modified",
      touched: { crow: now + 5 },
    })
    expect(after.writing.crow).toBe(demoPaths.checkoutTest)
  })

  it("keeps what other agents did to the file", () => {
    const after = writeTo(storefrontFiles(now), filesThird, demoPaths.checkout, now + 5)
    expect(Object.keys(after.changes[demoPaths.checkout]!.touched).toSorted()).toEqual([
      "crow",
      "moth",
      "owl",
    ])
  })

  it("adds a file the tree doesn't have", () => {
    const after = writeTo(storefrontFiles(now), "crow", demoPaths.payments, now)
    expect(after.changes[demoPaths.payments]?.kind).toBe("added")
  })

  it("leaves the project it was given as it was", () => {
    const before = storefrontFiles(now)
    writeTo(before, "crow", demoPaths.payments, now)
    expect(before.changes[demoPaths.payments]).toBeUndefined()
  })
})

describe("the end of a turn", () => {
  it("takes the agent's file away and keeps its changes", () => {
    const after = endTurnIn(storefrontFiles(now), "crow")
    expect(after.writing).toEqual({})
    expect(after.changes[demoPaths.checkoutTest]).toBeDefined()
  })
})

describe("the file an agent writes next", () => {
  const before = storefrontFiles(now)

  it("is mostly the one it is on", () => {
    expect(nextFile(before, "crow", 0.9, 0)).toBe(demoPaths.checkoutTest)
  })

  it("is sometimes another of its pool", () => {
    expect(nextFile(before, "crow", 0.2, 0)).toBe(demoPaths.checkout)
  })

  it("is a new file the first time it rolls low, and not after", () => {
    const created = nextFile(before, "crow", 0.05, 0)
    expect(created).toBe("src/checkout/PaymentForm.tsx")
    const later = writeTo(before, "crow", created, now)
    expect(nextFile(later, "crow", 0.05, 0)).toBe(demoPaths.payments)
  })

  it("is never a new file for an agent that creates none", () => {
    expect(nextFile(before, "moth", 0.05, 0)).toBe("src/cart/useCart.ts")
  })
})

describe("the demo files", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("is the demo's, which the debug panel writes to", () => {
    expect(isDemoFiles(createDemoFiles(now))).toBe(true)
    expect(
      isDemoFiles({ state: createDemoFiles(now).state, list: createDemoFiles(now).list }),
    ).toBe(false)
  })

  it("has the storefront and no other project", () => {
    expect(Object.keys(createDemoFiles(now).state.getSnapshot().projects)).toEqual(["storefront"])
  })

  it("writes at the clock's time", () => {
    const { clock, advance } = manual()
    const files = createDemoFiles(now, clock)
    advance(2000)
    files.write("crow", demoPaths.payments)
    expect(project(files).changes[demoPaths.payments]?.touched.crow).toBe(now + 2000)
  })

  context("running", () => {
    it("has Crow write every few seconds", () => {
      const { clock, advance } = manual()
      const files = createDemoFiles(now, clock)
      const stop = files.start()
      advance(4999)
      expect(project(files).changes[demoPaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      advance(1)
      expect(project(files).changes[demoPaths.checkoutTest]!.touched.crow).toBe(now + 5000)
      stop()
    })

    it("has Crow end its turn for a rest, then write again", () => {
      const { clock, advance } = manual()
      const files = createDemoFiles(now, clock)
      const stop = files.start()
      // Six writes a turn at a roll of one half, 5 s apart.
      advance(5000 * 6)
      expect(project(files).writing.crow).toBeUndefined()
      advance(15_000 + 5000)
      expect(project(files).writing.crow).toBe(demoPaths.checkoutTest)
      stop()
    })

    it("writes nothing while the page is hidden", () => {
      const { clock, advance, hide } = manual()
      const files = createDemoFiles(now, clock)
      const stop = files.start()
      hide(true)
      advance(60_000)
      expect(project(files).changes[demoPaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      stop()
    })

    it("stops with its stop", () => {
      const { clock, pending } = manual()
      const stop = createDemoFiles(now, clock).start()
      stop()
      expect(pending()).toBe(0)
    })

    it("leaves Moth still while it waits", () => {
      const { clock, advance } = manual()
      const files = createDemoFiles(now, clock)
      const stop = files.start(demoTurns())
      advance(120_000)
      expect(project(files).changes["src/cart/useCart.ts"]!.touched.moth).toBe(now - 7 * 60_000)
      expect(project(files).writing.moth).toBeUndefined()
      stop()
    })

    it("has Moth write while its turn works and stop when it ends", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      const stop = files.start(turns)
      const key = {
        projectId: "storefront",
        workspaceSessionId: "initial",
        terminalId: "storefront-initial-01",
      }
      turns.work(key, undefined)
      advance(5000)
      expect(project(files).writing.moth).toBe("src/cart/CartSummary.tsx")
      turns.rest(key, undefined)
      expect(project(files).writing.moth).toBeUndefined()
      stop()
    })

    const crowKey = {
      projectId: "storefront",
      workspaceSessionId: "initial",
      terminalId: "storefront-initial-04",
    }
    const mothKey = { ...crowKey, terminalId: "storefront-initial-01" }

    it("leaves Crow still while its agent waits on the person, and has it write again after", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      const stop = files.start(turns)
      turns.ask(crowKey, undefined, "permission", 1)
      expect(project(files).writing.crow).toBeUndefined()
      advance(60_000)
      expect(project(files).changes[demoPaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      turns.work(crowKey, undefined)
      advance(5000)
      expect(project(files).writing.crow).toBe(demoPaths.checkoutTest)
      expect(project(files).changes[demoPaths.checkoutTest]!.touched.crow).toBe(now + 65_000)
      stop()
    })

    it("has Crow write through no permission prompt that is open", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      const stop = files.start(turns)
      advance(5000)
      turns.ask(crowKey, undefined, "question", 1)
      const touched = project(files).changes[demoPaths.checkoutTest]!.touched.crow
      advance(60_000)
      expect(project(files).changes[demoPaths.checkoutTest]!.touched.crow).toBe(touched)
      stop()
    })

    it("does not start Moth writing on a request", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      const stop = files.start(turns)
      turns.ask(mothKey, undefined, "permission", 1)
      advance(60_000)
      expect(project(files).writing.moth).toBeUndefined()
      expect(project(files).changes["src/cart/useCart.ts"]!.touched.moth).toBe(now - 7 * 60_000)
      stop()
    })

    it("has nothing write when the agent rests, and Crow's cursor go", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      const stop = files.start(turns)
      turns.rest(crowKey, undefined)
      expect(project(files).writing.crow).toBeUndefined()
      advance(60_000)
      expect(project(files).writing.crow).toBeUndefined()
      stop()
    })

    it("leaves no cursor when it stops", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      const stop = files.start(turns)
      turns.work(mothKey, undefined)
      advance(5000)
      expect(Object.keys(project(files).writing).toSorted()).toEqual(["crow", "moth"])
      stop()
      expect(project(files).writing).toEqual({})
    })

    it("moves nothing where the visitor asked for less motion", () => {
      vi.stubGlobal("matchMedia", () => ({ matches: true }))
      const { clock, pending } = manual()
      const stop = createDemoFiles(now, clock).start()
      expect(pending()).toBe(0)
      stop()
    })

    it("moves nothing on a page held still", () => {
      vi.stubGlobal("location", { search: "?still" })
      const { clock, pending } = manual()
      createDemoFiles(now, clock).start()
      expect(pending()).toBe(0)
    })

    it("shows nobody writing on a page held still", () => {
      vi.stubGlobal("location", { search: "?still" })
      const { clock } = manual()
      const files = createDemoFiles(now, clock)
      files.start(demoTurns())
      expect(project(files).writing).toEqual({})
    })

    it("leaves the store as it was when an idle agent is stopped again", () => {
      const { clock } = manual()
      const files = createDemoFiles(now, clock, [])
      const before = files.state.getSnapshot()
      files.endTurn("moth")
      expect(files.state.getSnapshot()).toBe(before)
    })

    it("takes Crow's cursor away under less motion once its agent waits on the person", () => {
      vi.stubGlobal("matchMedia", () => ({ matches: true }))
      const { clock } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      files.start(turns)
      expect(project(files).writing.crow).toBe(demoPaths.checkoutTest)
      turns.ask(crowKey, undefined, "permission", 1)
      expect(project(files).writing.crow).toBeUndefined()
    })

    it("has Crow write no more once its terminal closes, even when its agent works again", () => {
      const { clock, advance, pending } = manual()
      const turns = demoTurns()
      const files = createDemoFiles(now, clock)
      const stop = files.start(turns)
      files.close(crowKey.terminalId)
      expect(project(files).writing.crow).toBeUndefined()
      expect(pending()).toBe(0)
      turns.work(crowKey, undefined)
      advance(60_000)
      expect(project(files).writing.crow).toBeUndefined()
      expect(project(files).changes[demoPaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      stop()
    })
  })
})

describe("a backend with the demo's files", () => {
  const target = { projectId: "storefront", workspaceSessionId: "initial" }
  const workspace = workspaceFromSeed(demoSeed(now), { view: "focus", windowedView: "grid", now })

  it("stops the agent of a terminal that closes", () => {
    const { clock, pending } = manual()
    const files = createDemoFiles(now, clock)
    const stop = files.start()
    withFiles(plainDemo("plain"), undefined, files).commit(workspace, [
      { type: "terminal/close", target, terminalId: "storefront-initial-04" },
    ])
    expect(project(files).writing.crow).toBeUndefined()
    expect(pending()).toBe(0)
    stop()
  })

  // The try demo's workspace, where Moth and Crow work and ask nothing.
  const working = workspaceFromSeed(visitorSeed(now, true), {
    view: "focus",
    windowedView: "grid",
    now,
  })
  const crowId = "storefront-initial-04"
  const started = () => {
    const { clock, advance } = manual()
    const turns = demoTurns()
    const files = createDemoFiles(now, clock, ["moth", "crow"])
    const stop = files.start(turns)
    // Both have written by now.
    advance(5000)
    return { files, turns, advance, stop }
  }

  it("keeps the agents going when the storefront project is refused removal", () => {
    const { files, stop } = started()
    expect(Object.keys(project(files).writing).toSorted()).toEqual(["crow", "moth"])
    withFiles(plainDemo("plain"), undefined, files).commit(working, [
      { type: "project/remove", projectId: "storefront", now },
    ])
    expect(Object.keys(project(files).writing).toSorted()).toEqual(["crow", "moth"])
    stop()
  })

  it("stops every agent when the storefront project is really gone", () => {
    const { files, turns, advance, stop } = started()
    const gone = {
      ...working,
      projects: working.projects.filter((each) => each.id !== "storefront"),
    }
    withFiles(plainDemo("plain"), turns, files).commit(gone, [
      { type: "project/remove", projectId: "storefront", now },
    ])
    expect(project(files).writing).toEqual({})
    advance(60_000)
    expect(project(files).writing).toEqual({})
    stop()
  })

  it("has no agent write after a restart while it waits on the person", () => {
    const { clock, advance } = manual()
    const turns = demoTurns()
    const files = createDemoFiles(now, clock, ["moth", "crow"])
    const backend = withFiles(plainDemo("plain"), turns, files)
    backend.commit(working, [])
    const sink = { dispatch: () => {}, open: () => {} }
    backend.start!(sink)()
    // Crow asks while the backend is stopped, and no commit comes after the restart.
    const asking = workspaceReducer(working, {
      type: "terminal/status",
      target,
      terminalId: crowId,
      status: {
        state: "running",
        agent: { working: true, attention: { kind: "permission", count: 1 } },
      },
    })
    backend.commit(asking, [])
    const stop = backend.start!(sink)
    advance(60_000)
    expect(project(files).writing.crow).toBeUndefined()
    expect(project(files).writing.moth).toBeDefined()
    stop()
  })

  // What the debug panel does to a terminal: it releases the agent and dispatches a status
  // itself, so the turns never report it.
  const dispatched = (status: TerminalStatus) => {
    const action = { type: "terminal/status" as const, target, terminalId: crowId, status }
    return { action, after: workspaceReducer(working, action) }
  }

  it("stops Crow writing once its terminal is at a prompt, however it got there", () => {
    const { files, turns, advance, stop } = started()
    expect(project(files).writing.crow).toBeDefined()
    turns.release({ ...target, terminalId: crowId })
    const { action, after } = dispatched({ state: "running" })
    withFiles(plainDemo("plain"), turns, files).commit(after, [action])
    expect(project(files).writing.crow).toBeUndefined()
    advance(60_000)
    expect(project(files).writing.crow).toBeUndefined()
    expect(project(files).writing.moth).toBeDefined()
    stop()
  })

  it("stops Crow writing once its terminal failed, as in the crash loop", () => {
    const { files, advance, stop } = started()
    const { action, after } = dispatched({ state: "failed", message: "crashed" })
    withFiles(plainDemo("plain"), undefined, files).commit(after, [action])
    expect(project(files).writing.crow).toBeUndefined()
    advance(60_000)
    expect(project(files).writing.crow).toBeUndefined()
    stop()
  })

  it("has Crow write again when its agent is reported working after that", () => {
    const { files, turns, advance, stop } = started()
    const { action, after } = dispatched({ state: "running" })
    withFiles(plainDemo("plain"), turns, files).commit(after, [action])
    expect(project(files).writing.crow).toBeUndefined()
    turns.work({ ...target, terminalId: crowId }, undefined)
    advance(8000)
    expect(project(files).writing.crow).toBeDefined()
    stop()
  })
})

describe("a folder an agent's write created", () => {
  it("lists like any other: it is there, holding what the tree held of it (nothing)", async () => {
    const files = createDemoFiles(now)
    await expect(files.list("storefront", "src/emails")).rejects.toThrow("no such folder")
    files.write(demoHandle(1), "src/emails/shipped.tsx")
    const listing = await files.list("storefront", "src/emails")
    expect(listing).toEqual({ entries: [], truncated: false })
    // The file is the agent's change, which the panel shows in the folder.
    expect(files.state.getSnapshot().projects["storefront"]!.changes).toHaveProperty(
      "src/emails/shipped.tsx",
      expect.objectContaining({ kind: "added" }),
    )
  })
})
