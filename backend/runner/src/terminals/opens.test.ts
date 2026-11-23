import { randomUUID } from "node:crypto"

import { describe, expect, it } from "../test.js"
import {
  allowOpen,
  OpenRequests,
  openLimit,
  prune,
  readOpenRequest,
  sessionCommandRefusal,
} from "./opens.js"

describe("reading a request for a new terminal", () => {
  it("takes a command, a folder, a name and focus, each optional", () => {
    expect(readOpenRequest({})).toEqual({ ok: true, request: {} })
    expect(
      readOpenRequest({ command: "npm run dev", cwd: "../app", title: " Server ", focus: true }),
    ).toEqual({
      ok: true,
      request: { command: "npm run dev", cwd: "../app", title: "Server", focus: true },
    })
  })

  it("refuses a command of more than one line, or with control characters", () => {
    const refused = {
      ok: false,
      reason: "The command must be one line, without control characters.",
    }
    expect(readOpenRequest({ command: "claude\nrm -rf ~" })).toEqual(refused)
    expect(readOpenRequest({ command: "claude\r" })).toEqual(refused)
    expect(readOpenRequest({ command: "echo \u001b[31m" })).toEqual(refused)
  })

  it("names what else is wrong, and refuses what it doesn't take", () => {
    expect(readOpenRequest({ command: "" })).toEqual({
      ok: false,
      reason: 'The request\'s "command" is not valid.',
    })
    expect(readOpenRequest({ command: "a".repeat(4097) })).toMatchObject({ ok: false })
    expect(readOpenRequest({ command: "a".repeat(4096) })).toMatchObject({ ok: true })
    expect(readOpenRequest({ focus: "yes" })).toEqual({
      ok: false,
      reason: 'The request\'s "focus" is not valid.',
    })
    expect(readOpenRequest({ title: "   " })).toMatchObject({ ok: false })
    // As the terminal will be titled: one line, without control characters.
    expect(readOpenRequest({ title: "API\tserver" })).toMatchObject({ ok: false })
    expect(readOpenRequest({ shell: "zsh" })).toEqual({
      ok: false,
      reason: "The request is not valid.",
    })
  })
})

describe("an agent in a request", () => {
  it("starts with no message, a model and effort, a lead and a session to resume", () => {
    expect(readOpenRequest({ agent: "codex" })).toEqual({ ok: true, request: { agent: "codex" } })
    const all = {
      agent: "claude",
      message: "Review a.ts.",
      model: "opus",
      effort: "high",
      lead: false,
      resume: "0c9d-4f.s_1",
    }
    expect(readOpenRequest(all)).toEqual({ ok: true, request: all })
    expect(readOpenRequest({ agent: "agy", lead: true })).toMatchObject({ ok: true })
    expect(readOpenRequest({ agent: "agy", resume: "abc" })).toMatchObject({ ok: true })
  })

  it("is needed by a message, model, effort, lead and resume, and refuses a command with it", () => {
    for (const lone of [
      { message: "Hi." },
      { model: "opus" },
      { effort: "low" },
      { lead: true },
      { resume: "abc" },
    ])
      expect(readOpenRequest({ command: "ls", ...lone })).toEqual({
        ok: false,
        reason: "A message, model, effort, lead or resume goes with an agent.",
      })
    expect(readOpenRequest({ lead: false })).toMatchObject({ ok: false })
    expect(readOpenRequest({ agent: "codex", command: "ls" })).toEqual({
      ok: false,
      reason: "A command can't be combined with an agent.",
    })
  })

  it("resumes a session id a shell can run as it is", () => {
    const reason =
      "resume is the id of a past session: letters, digits, dots, dashes and underscores, " +
      "up to 128 characters."
    for (const resume of ["", "a b", "x; rm -rf ~", "-flag", "a".repeat(129)])
      expect(readOpenRequest({ agent: "claude", resume })).toEqual({ ok: false, reason })
  })

  it("names the agent a refused session command would have started", () => {
    expect(sessionCommandRefusal("agy")).toContain("would run a Antigravity session")
    expect(sessionCommandRefusal("agy")).toContain("agy -p")
    expect(sessionCommandRefusal("agy")).toContain("open_agent")
  })
})

describe("a model and effort in a request", () => {
  it("go with an agent and its message", () => {
    const task = { agent: "codex", message: "Review a.ts." }
    expect(readOpenRequest({ ...task, model: "gpt-5.5", effort: "high" })).toEqual({
      ok: true,
      request: { ...task, model: "gpt-5.5", effort: "high" },
    })
    for (const lone of [{ model: "opus" }, { effort: "low" }])
      expect(readOpenRequest({ command: "ls", ...lone })).toEqual({
        ok: false,
        reason: "A message, model, effort, lead or resume goes with an agent.",
      })
  })

  it("must be a model of up to 128 characters, and one of the efforts", () => {
    const task = { agent: "claude", message: "Hi." }
    expect(readOpenRequest({ ...task, effort: "ultra" })).toEqual({
      ok: false,
      reason:
        "effort is one of low, medium, high, xhigh or max; leave it out for the agent's default.",
    })
    expect(readOpenRequest({ ...task, model: "" })).toMatchObject({ ok: false })
    expect(readOpenRequest({ ...task, model: "m".repeat(129) })).toMatchObject({ ok: false })
    expect(readOpenRequest({ ...task, model: "m".repeat(128) })).toMatchObject({ ok: true })
  })
})

describe("how many terminals a terminal's agents may open", () => {
  it("allows five a minute, then one more as each falls out of the minute", () => {
    expect(openLimit).toEqual({ count: 5, windowMs: 60_000 })
    let times: readonly number[] = []
    for (const now of [0, 1_000, 2_000, 3_000, 4_000]) {
      const next = allowOpen(times, now)
      expect(next).toBeDefined()
      times = next!
    }
    expect(allowOpen(times, 5_000)).toBeUndefined()
    expect(allowOpen(times, 59_999)).toBeUndefined()
    expect(allowOpen(times, 60_000)).toEqual([1_000, 2_000, 3_000, 4_000, 60_000])
  })

  it("forgets the times that fell out of the window", () => {
    expect(allowOpen([0, 10, 20], 120_000, { count: 2, windowMs: 1_000 })).toEqual([120_000])
  })
})

describe("letting go of budgets", () => {
  it("drops those whose every time has passed out of the window, and keeps the rest", () => {
    const budgets = new Map<string, readonly number[]>([
      ["gone", [0, 10]],
      ["recent", [0, 60_500]],
    ])
    prune(budgets, 70_000, 60_000)
    expect([...budgets]).toEqual([["recent", [0, 60_500]]])
  })
})

describe("requests on their way to the client", () => {
  const request = {
    from: randomUUID(),
    sessionId: randomUUID(),
    cwd: "/work",
    command: "claude",
    focus: false,
  }

  it("go nowhere without a client following them", async () => {
    await expect(
      new OpenRequests().request(request, 1_000, { by: "id-moth", handle: "moth", leads: false }),
    ).resolves.toEqual({
      type: "nobody",
    })
  })

  it("go to the client that followed last, and wait for its answer", async () => {
    const opens = new OpenRequests()
    const controller = new AbortController()
    const older = opens.follow("older", controller.signal)
    const newer = opens.follow("newer", controller.signal)
    // A stream follows from its first read.
    void older.next()
    const first = newer.next()
    const asked = opens.request(request, 1_000, {
      by: "id-moth",
      handle: "moth",
      title: "Server",
      leads: false,
    })
    const { value } = await first
    expect(value).toEqual({ requestId: expect.any(String), ...request })
    // Who asked, with the title it asked for, waits for the terminal its client creates:
    // only that client's, in the request's session, and only the first.
    expect(opens.opener(value!.requestId, "older", request.sessionId)).toBeUndefined()
    expect(opens.opener(value!.requestId, "newer", randomUUID())).toBeUndefined()
    expect(opens.opener(value!.requestId, "newer", request.sessionId)).toEqual({
      by: "id-moth",
      handle: "moth",
      title: "Server",
      leads: false,
    })
    expect(opens.opener(value!.requestId, "newer", request.sessionId)).toBeUndefined()
    const terminalId = randomUUID()
    // Only the client it went to answers it.
    expect(() => opens.answer({ requestId: value!.requestId, terminalId }, "older")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    opens.answer({ requestId: value!.requestId, terminalId }, "newer")
    await expect(asked).resolves.toEqual({
      type: "answered",
      answer: { requestId: value!.requestId, terminalId },
    })
    // Answered once: a second answer finds nothing waiting.
    expect(() => opens.answer({ requestId: value!.requestId, reason: "No." }, "newer")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    controller.abort()
  })

  it("are known by the terminal that asked, until the client's terminal takes its place", async () => {
    const opens = new OpenRequests()
    const stream = opens.follow("client")
    const first = stream.next()
    const asked = opens.request(request, 1_000, { by: "id-moth", handle: "moth", leads: false })
    const { value } = await first
    expect(opens.asked("id-moth")).toBe(true)
    expect(opens.asked("wren")).toBe(false)
    opens.opener(value!.requestId, "client", request.sessionId)
    expect(opens.asked("id-moth")).toBe(false)
    opens.answer({ requestId: value!.requestId, reason: "No." }, "client")
    await asked
    opens.finish()
  })

  it("tell their asker of the terminal made for them before the client confirms it", async () => {
    const opens = new OpenRequests()
    const stream = opens.follow("client")
    const first = stream.next()
    const made: string[] = []
    const asked = opens.request(
      request,
      1_000,
      { by: "id-moth", handle: "moth", leads: false },
      (terminalId) => void made.push(terminalId),
    )
    const { value } = await first
    const { requestId } = value!
    // Only a create that took the opener tells.
    opens.created(requestId, "t-stray")
    expect(made).toEqual([])
    opens.opener(requestId, "client", request.sessionId)
    opens.created(requestId, "t2")
    expect(made).toEqual(["t2"])
    opens.answer({ requestId, terminalId: "t2" }, "client")
    await expect(asked).resolves.toEqual({
      type: "answered",
      answer: { requestId, terminalId: "t2" },
    })
    opens.finish()
  })

  it("answer as made, past their deadline, once their terminal is made, and let its late confirm pass", async () => {
    const opens = new OpenRequests()
    const stream = opens.follow("client")
    let first = stream.next()
    const opener = { by: "id-moth", handle: "moth", leads: false }
    // Made before the deadline: answered as made once it passes.
    const early = opens.request(request, 10, opener)
    let { value } = await first
    opens.opener(value!.requestId, "client", request.sessionId)
    opens.created(value!.requestId, "t2")
    await expect(early).resolves.toEqual({ type: "made", terminalId: "t2" })
    // Its client's confirmation, on its way meanwhile, is no error; another client's is.
    expect(() => opens.answer({ requestId: value!.requestId, terminalId: "t2" }, "other")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    )
    opens.answer({ requestId: value!.requestId, terminalId: "t2" }, "client")
    // Being made as the deadline passes: it waits for the terminal.
    first = stream.next()
    const slow = opens.request(request, 10, opener)
    ;({ value } = await first)
    opens.opener(value!.requestId, "client", request.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 30))
    opens.created(value!.requestId, "t3")
    await expect(slow).resolves.toEqual({ type: "made", terminalId: "t3" })
    // One that couldn't be made is late.
    first = stream.next()
    const failed = opens.request(request, 10, opener)
    ;({ value } = await first)
    opens.opener(value!.requestId, "client", request.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 30))
    opens.created(value!.requestId, null)
    await expect(failed).resolves.toEqual({ type: "late" })
    // A client that goes away after its terminal was made: opened all the same.
    first = stream.next()
    const left = opens.request(request, 1_000, opener)
    ;({ value } = await first)
    opens.opener(value!.requestId, "client", request.sessionId)
    opens.created(value!.requestId, "t4")
    opens.release("client")
    await expect(left).resolves.toEqual({ type: "made", terminalId: "t4" })
    opens.finish()
  })

  it("go unanswered when the client takes too long, or goes away", async () => {
    const opens = new OpenRequests()
    const stream = opens.follow("client")
    const first = stream.next()
    await expect(
      opens.request(request, 10, { by: "id-moth", handle: "moth", leads: false }),
    ).resolves.toEqual({
      type: "late",
    })
    await first
    const asked = opens.request(request, 1_000, { by: "id-moth", handle: "moth", leads: false })
    opens.release("client")
    await expect(asked).resolves.toEqual({ type: "gone" })
    await expect(stream.next()).resolves.toMatchObject({ done: true })
    await expect(
      opens.request(request, 1_000, { by: "id-moth", handle: "moth", leads: false }),
    ).resolves.toEqual({
      type: "nobody",
    })
  })
})
