import { describe, expect, it } from "../test.js"
import type { AgentDigest } from "./describer.js"
import { Preparer } from "./prepare.js"

const script = new URL("../testing/slow-worker.mjs", import.meta.url)
const digest = (project: string): AgentDigest => ({
  kind: "agent",
  harness: "Claude Code",
  project,
  folder: null,
  branch: null,
  plan: null,
  folders: [],
  prompts: ["fix it"],
  reply: null,
  summary: null,
  previous: null,
})

describe("preparing a digest in a thread", () => {
  it("answers with the chat", async ({ resources }) => {
    const preparer = new Preparer({ script })
    resources.defer(() => preparer.close())

    expect(await preparer.prepare(digest("app"))).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "about app" },
    ])
  })

  it("redacts with the real thread, from source", { timeout: 20_000 }, async ({ resources }) => {
    const preparer = new Preparer()
    resources.defer(() => preparer.close())

    const chat = await preparer.prepare({
      ...digest("app"),
      prompts: ["use API_KEY=hunter2abc please"],
    })

    expect(chat).toHaveLength(2)
    expect(JSON.stringify(chat)).not.toContain("hunter2abc")
    expect(JSON.stringify(chat)).toContain("[redacted]")
  })

  it(
    "ends a thread that takes too long, leaves the event loop running, and starts another",
    {
      timeout: 10_000,
    },
    async ({ resources }) => {
      const preparer = new Preparer({ script, deadlineMs: 300 })
      resources.defer(() => preparer.close())
      await preparer.prepare(digest("app"))
      let ticks = 0
      const timer = setInterval(() => (ticks += 1), 20)

      const late = await preparer.prepare(digest("hang"))
      clearInterval(timer)

      expect(late).toBe("late")
      // The loop kept going the whole while the thread was stuck.
      expect(ticks).toBeGreaterThan(8)
      expect(preparer.running).toBe(false)
      expect(await preparer.prepare(digest("again"))).toEqual([
        { role: "system", content: "system" },
        { role: "user", content: "about again" },
      ])
    },
  )

  it("is dropped by its signal", async ({ resources }) => {
    const preparer = new Preparer({ script, deadlineMs: 5000 })
    resources.defer(() => preparer.close())
    await preparer.prepare(digest("app"))
    const controller = new AbortController()

    const job = preparer.prepare(digest("hang"), controller.signal)
    setTimeout(() => controller.abort(), 50)

    expect(await job).toBeUndefined()
    await preparer.stop()
  })

  it("ends the thread at close, and starts no other", async () => {
    const preparer = new Preparer({ script })
    await preparer.prepare(digest("app"))
    expect(preparer.running).toBe(true)

    await preparer.close()

    expect(preparer.running).toBe(false)
    expect(await preparer.prepare(digest("app"))).toBeUndefined()
  })

  it("ends an idle thread", async () => {
    const preparer = new Preparer({ script, idleMs: 50 })
    await preparer.prepare(digest("app"))

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(preparer.running).toBe(false)
    await preparer.close()
  })

  it("ends the thread of a job that is dropped, so it does not spin on", async ({ resources }) => {
    const preparer = new Preparer({ script, deadlineMs: 5000 })
    resources.defer(() => preparer.close())
    await preparer.prepare(digest("app"))
    const controller = new AbortController()

    const job = preparer.prepare(digest("hang"), controller.signal)
    setTimeout(() => controller.abort(), 50)
    expect(await job).toBeUndefined()

    // The thread was ended with the job, not left to run until a deadline.
    expect(preparer.running).toBe(false)
    const cpu = process.cpuUsage()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const used = process.cpuUsage(cpu)
    expect((used.user + used.system) / 1000).toBeLessThan(400)
    // The next job gets a thread of its own, and its full time.
    expect(await preparer.prepare(digest("next"))).toHaveLength(2)
  })

  it("survives an error in the thread between digests", async ({ resources }) => {
    const preparer = new Preparer({
      script: new URL("../testing/throw-worker.mjs", import.meta.url),
    })
    resources.defer(() => preparer.close())
    const uncaught: unknown[] = []
    const listener = (error: unknown): number => uncaught.push(error)
    process.on("uncaughtException", listener)
    try {
      expect(await preparer.prepare(digest("a"))).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(uncaught).toEqual([])
      expect(preparer.running).toBe(false)
      expect(await preparer.prepare(digest("b"))).toHaveLength(1)
    } finally {
      process.off("uncaughtException", listener)
    }
  })

  it("ends a thread that comes up after a stop", async () => {
    const preparer = new Preparer({ script })

    const job = preparer.prepare(digest("app"))
    await preparer.stop()

    expect(await job).toBeUndefined()
    expect(preparer.running).toBe(false)
    await preparer.close()
  })
})

describe("a pattern that backtracks without end", () => {
  it("is ended by the deadline: late, and the thread exits within a second", async ({
    resources,
  }) => {
    const preparer = new Preparer({
      script: new URL("../testing/regex-worker.mjs", import.meta.url),
      deadlineMs: 300,
    })
    resources.defer(() => preparer.close())
    await preparer.prepare(digest("app"))
    // The thread, to watch it end: a stuck regex cannot be interrupted from inside.
    const worker = preparer["worker"]
    expect(worker).toBeDefined()
    const exited = new Promise<number>((resolve) => {
      worker?.once("exit", () => resolve(performance.now()))
    })

    const result = await preparer.prepare(digest("regex"))
    const late = performance.now()

    expect(result).toBe("late")
    expect((await exited) - late).toBeLessThan(1000)
  })
})
