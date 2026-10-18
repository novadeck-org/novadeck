import { describe, expect, it, vi } from "vitest"

import { Watched, type Session, type Wire, type WireStatus } from "./connection.js"
import { WireError } from "./errors.js"
import { follow, type FollowOptions } from "./follow.js"

// The streams' contract is the test's own: follow passes the client to `open` and `ack` only.
type Contract = Record<never, never>
type Client = Session<Contract>["client"]

// A connection the test drives: it connects sessions in epochs, and drops them.
const connection = () => {
  const status = new Watched<WireStatus>(
    { state: "reconnecting", error: new WireError("DISCONNECTED") },
    (value) => value.state === "closed",
  )
  let current: (Session<Contract> & { drop(): void }) | undefined
  const wire: Wire<Contract> = {
    status,
    session() {
      if (!current?.channel.open) throw new WireError("DISCONNECTED", "Reconnecting.")
      return current
    },
    async ready() {
      while (true) {
        if (status.value.state === "closed") return undefined
        if (current?.channel.open) return current
        // eslint-disable-next-line no-await-in-loop -- Wait for the next session.
        await status.next()
      }
    },
    close() {
      current?.drop()
      status.set({ state: "closed" })
    },
  }
  return {
    wire,
    /** Connects a new session in `epoch`. */
    connect(epoch = "e1") {
      let close = () => {}
      const channel = {
        open: true,
        closed: new Promise<void>((resolve) => {
          close = resolve
        }),
      }
      current = {
        client: {} as Client,
        epoch,
        channel,
        drop() {
          channel.open = false
          close()
        },
      }
      status.set({ state: "connected", epoch })
      return current
    },
    /** Drops the live session, as a lost connection does. */
    drop() {
      current?.drop()
      status.set({ state: "reconnecting", error: new WireError("DISCONNECTED") })
    },
  }
}

// A stream the test feeds, item by item.
const feed = <T>() => {
  const queue: ({ readonly value: T } | { readonly end: true } | { readonly error: unknown })[] = []
  let wake = () => {}
  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]: () => iterator,
    async next() {
      while (queue.length === 0) {
        // eslint-disable-next-line no-await-in-loop -- Wait for the test to feed it.
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      const item = queue.shift()!
      if ("error" in item) throw item.error
      if ("end" in item) return { value: undefined, done: true }
      return { value: item.value, done: false }
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  }
  const push = (item: (typeof queue)[number]) => {
    queue.push(item)
    wake()
  }
  return {
    iterator,
    push: (...values: T[]) => {
      for (const value of values) push({ value })
    },
    end: () => push({ end: true }),
    fail: (error: unknown) => push({ error }),
  }
}

// Every stream `open` was asked for, in turn, with what it was asked.
const streams = <T>() => {
  const opened: {
    feed: ReturnType<typeof feed<T>>
    after: number | undefined
    signal: AbortSignal
  }[] = []
  const refusals: unknown[] = []
  const open: FollowOptions<Contract, T>["open"] = (_client, { after, signal }) => {
    const refusal = refusals.shift()
    if (refusal !== undefined) return Promise.reject(refusal)
    const stream = feed<T>()
    opened.push({ feed: stream, after, signal })
    return Promise.resolve(stream.iterator)
  }
  return { opened, refusals, open, last: () => opened.at(-1)! }
}

type Item = { readonly type: "reset" } | { readonly type: "item"; readonly n: number }
const item = (n: number): Item => ({ type: "item", n })
const reset: Item = { type: "reset" }

describe("follow, restarting", () => {
  it("says reset before each subscription's items, following each new session", async () => {
    const link = connection()
    link.connect()
    const { opened, open, last } = streams<Item>()
    const items = follow(link.wire, { open, resume: { restart: true, reset } })
    expect(await items.next()).toEqual({ value: reset, done: false })
    last().feed.push(item(1))
    expect(await items.next()).toEqual({ value: item(1), done: false })
    link.drop()
    last().feed.fail(new WireError("DISCONNECTED"))
    const after = items.next()
    await vi.waitFor(() => expect(link.wire.status.value.state).toBe("reconnecting"))
    link.connect()
    expect(await after).toEqual({ value: reset, done: false })
    last().feed.push(item(2))
    expect(await items.next()).toEqual({ value: item(2), done: false })
    expect(opened).toHaveLength(2)
    expect(opened[0]!.signal.aborted).toBe(true)
  })

  it("waits for the next session when its server ends a stream that can't lose its subject", async () => {
    const link = connection()
    link.connect()
    const { opened, open, last } = streams<Item>()
    const items = follow(link.wire, { open, resume: { restart: true } })
    const first = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    last().feed.end()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(opened).toHaveLength(1)
    link.drop()
    link.connect()
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    last().feed.push(item(1))
    expect(await first).toEqual({ value: item(1), done: false })
  })

  it("opens again at once when a stream that can lose its subject ends, and ends once it's gone", async () => {
    const link = connection()
    link.connect()
    const { opened, refusals, open, last } = streams<Item>()
    const items = follow(link.wire, {
      open,
      resume: { restart: true },
      gone: (error) => error.code === "NOT_FOUND",
    })
    const first = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    refusals.push(new WireError("NOT_FOUND"))
    last().feed.end()
    expect(await first).toEqual({ value: undefined, done: true })
    expect(items.finished).toBe("ended")
  })

  it("holds reset back until a new subscription yields, and says none for the first", async () => {
    const link = connection()
    link.connect()
    const { opened, open, last } = streams<Item>()
    const items = follow(link.wire, {
      open,
      resume: { restart: true, reset, holdReset: true },
      gone: () => false,
    })
    const first = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    last().feed.push(item(1))
    expect(await first).toEqual({ value: item(1), done: false })
    // A subscription that ends finding nothing says nothing.
    last().feed.end()
    const next = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    last().feed.end()
    await vi.waitFor(() => expect(opened).toHaveLength(3))
    last().feed.push(item(2))
    expect(await next).toEqual({ value: reset, done: false })
    expect(await items.next()).toEqual({ value: item(2), done: false })
  })

  it("retries a refusal on a live session after a growing delay, and never throws", async () => {
    const link = connection()
    link.connect()
    const { opened, refusals, open, last } = streams<Item>()
    refusals.push(new WireError("RESOURCE_LIMIT"), new WireError("RESOURCE_LIMIT"))
    const items = follow(link.wire, { open, resume: { restart: true } })
    const started = Date.now()
    const first = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1), { timeout: 2_000 })
    // 200 ms, then 400 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(550)
    last().feed.push(item(1))
    expect(await first).toEqual({ value: item(1), done: false })
  })

  it("follows a server that's closing to its next session", async () => {
    const link = connection()
    const session = link.connect()
    const { opened, refusals, open, last } = streams<Item>()
    refusals.push(new WireError("CLOSING"))
    const items = follow(link.wire, { open, resume: { restart: true } })
    const first = items.next()
    // Past a refusal's first retry: a closing server isn't asked again.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(opened).toHaveLength(0)
    session.drop()
    link.connect()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    last().feed.push(item(1))
    expect(await first).toEqual({ value: item(1), done: false })
  })

  it("ends when its reader returns it, even mid-read, cancelling its stream", async () => {
    const link = connection()
    link.connect()
    const { opened, open } = streams<Item>()
    const items = follow(link.wire, { open, resume: { restart: true } })
    const pending = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    await items.return()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(opened[0]!.signal.aborted).toBe(true)
    expect(items.finished).toBe("stopped")
    expect(await items.next()).toEqual({ value: undefined, done: true })
  })

  it("ends when its connection closes", async () => {
    const link = connection()
    const { open } = streams<Item>()
    const items = follow(link.wire, { open, resume: { restart: true } })
    const pending = items.next()
    link.wire.close()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(items.finished).toBe("stopped")
  })
})

type Event = { readonly type: "marker" } | { readonly type: "event"; readonly sequence: number }
const event = (sequence: number): Event => ({ type: "event", sequence })
const marker: Event = { type: "marker" }

const cursor = (acks: number[], refuse: { count: number } = { count: 0 }) => ({
  cursor: (value: Event) => (value.type === "event" ? value.sequence : undefined),
  ack: (_client: Client, position: number) => {
    if (refuse.count > 0) {
      refuse.count -= 1
      return Promise.reject(new WireError("RESOURCE_LIMIT"))
    }
    acks.push(position)
    return Promise.resolve()
  },
})

describe("follow, from a cursor", () => {
  it("opens on the live session, or fails when there's none", async () => {
    const link = connection()
    const { open } = streams<Event>()
    const items = follow(link.wire, { open, resume: cursor([]) })
    await expect(items.next()).rejects.toMatchObject({ code: "DISCONNECTED" })
    expect(items.finished).toBe("failed")
  })

  it("acknowledges an item once the next is asked for, and markers never", async () => {
    const link = connection()
    const session = link.connect()
    const acks: number[] = []
    const { open, last } = streams<Event>()
    const items = follow(link.wire, { open, resume: cursor(acks) })
    const first = items.next()
    await vi.waitFor(() => expect(last()).toBeDefined())
    last().feed.push(marker, event(1), event(2))
    expect(await first).toEqual({ value: marker, done: false })
    expect(items.session).toBe(session)
    expect(await items.next()).toEqual({ value: event(1), done: false })
    expect(acks).toEqual([])
    expect(await items.next()).toEqual({ value: event(2), done: false })
    await vi.waitFor(() => expect(acks).toEqual([1]))
    const third = items.next()
    await vi.waitFor(() => expect(acks).toEqual([1, 2]))
    last().feed.push(event(3))
    expect(await third).toEqual({ value: event(3), done: false })
  })

  it("retries a refused acknowledgement, keeping the latest position", async () => {
    const link = connection()
    link.connect()
    const sent: number[] = []
    const answers: ((refused: boolean) => void)[] = []
    const { open, last } = streams<Event>()
    const items = follow(link.wire, {
      open,
      resume: {
        cursor: (value: Event) => (value.type === "event" ? value.sequence : undefined),
        ack: (_client: Client, position: number) => {
          sent.push(position)
          return new Promise<void>((resolve, reject) =>
            answers.push((refused) =>
              refused ? reject(new WireError("RESOURCE_LIMIT")) : resolve(),
            ),
          )
        },
      },
    })
    const first = items.next()
    await vi.waitFor(() => expect(last()).toBeDefined())
    last().feed.push(event(1), event(2), event(3))
    await first
    await items.next()
    await items.next()
    // 1 is refused once 3 has been asked for, so 2 is read too: the retry tells 2.
    answers.shift()!(true)
    await vi.waitFor(() => expect(sent).toEqual([1, 2]), { timeout: 1_000 })
  })

  it("has one acknowledgement in flight at a time", async () => {
    const link = connection()
    link.connect()
    const sent: number[] = []
    const answers: (() => void)[] = []
    const { open, last } = streams<Event>()
    const items = follow(link.wire, {
      open,
      resume: {
        cursor: (value: Event) => (value.type === "event" ? value.sequence : undefined),
        ack: (_client: Client, position: number) => {
          sent.push(position)
          return new Promise<void>((resolve) => answers.push(resolve))
        },
      },
    })
    const first = items.next()
    await vi.waitFor(() => expect(last()).toBeDefined())
    last().feed.push(event(1), event(2), event(3), event(4))
    await first
    await items.next()
    await items.next()
    await items.next()
    expect(sent).toEqual([1])
    answers.shift()!()
    await vi.waitFor(() => expect(sent).toEqual([1, 3]))
  })

  it("has a session only once its stream yields on it", async () => {
    const link = connection()
    link.connect()
    const { opened, open, last } = streams<Event>()
    const items = follow(link.wire, { open, resume: cursor([]) })
    const first = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(items.session).toBeUndefined()
    last().feed.push(event(1))
    await first
    link.drop()
    last().feed.fail(new WireError("DISCONNECTED"))
    const next = items.next()
    const reconnected = link.connect()
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    // Reopening, not yet granted anything: write and the like must wait.
    expect(items.session).toBeUndefined()
    last().feed.push(event(2))
    await next
    expect(items.session).toBe(reconnected)
  })

  it("opens again when a generator's stream fails before its first item, once it has read", async () => {
    const link = connection()
    link.connect()
    let opens = 0
    // Fails the stream that's open, as its lost socket does.
    let lose = (_error: unknown) => {}
    const items = follow<Contract, Event>(link.wire, {
      async *open() {
        opens += 1
        if (opens === 2) throw new WireError("DISCONNECTED", "Ended before granting it.")
        yield marker
        yield event(opens)
        await new Promise<never>((_resolve, reject) => {
          lose = reject
        })
      },
      resume: cursor([]),
    })
    expect(await items.next()).toEqual({ value: marker, done: false })
    expect(await items.next()).toEqual({ value: event(1), done: false })
    // Drop the first: the second fails as it opens, and the third serves.
    link.drop()
    const next = items.next()
    lose(new WireError("DISCONNECTED"))
    link.connect()
    expect(await next).toEqual({ value: marker, done: false })
    expect(await items.next()).toEqual({ value: event(3), done: false })
    await items.return()
  })

  it("ends a read waiting for its stream to open when returned", async () => {
    const link = connection()
    link.connect()
    let signal: AbortSignal | undefined
    const items = follow<Contract, Event>(link.wire, {
      open: (_client, options) => {
        signal = options.signal
        return new Promise<never>(() => {})
      },
      resume: { restart: true },
    })
    const pending = items.next()
    await vi.waitFor(() => expect(signal).toBeDefined())
    await items.return()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(signal?.aborted).toBe(true)
  })

  it("resumes after the last item read on the next session of its epoch", async () => {
    const link = connection()
    link.connect("e1")
    const { opened, open, last } = streams<Event>()
    const items = follow(link.wire, { open, resume: cursor([]) })
    const first = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    last().feed.push(event(4))
    await first
    link.drop()
    last().feed.fail(new Error("socket closed"))
    const next = items.next()
    link.connect("e1")
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    expect(opened.map((each) => each.after)).toEqual([undefined, 4])
    last().feed.push(event(5))
    expect(await next).toEqual({ value: event(5), done: false })
  })

  it("starts afresh in a new epoch, and after a refusal for a slow reader", async () => {
    const link = connection()
    link.connect("e1")
    const { opened, open, last } = streams<Event>()
    const items = follow(link.wire, { open, resume: cursor([]) })
    const first = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    last().feed.push(event(4))
    await first
    link.drop()
    last().feed.fail(new WireError("DISCONNECTED"))
    const next = items.next()
    link.connect("e2")
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    last().feed.push(event(1))
    expect(await next).toEqual({ value: event(1), done: false })
    last().feed.fail(new WireError("SLOW_CONSUMER"))
    const fresh = items.next()
    await vi.waitFor(() => expect(opened).toHaveLength(3))
    expect(opened.map((each) => each.after)).toEqual([undefined, undefined, undefined])
    last().feed.push(event(9))
    expect(await fresh).toEqual({ value: event(9), done: false })
  })

  it("throws what it can't resume from, and ends when its server ends it", async () => {
    const link = connection()
    link.connect()
    const { opened, open, last } = streams<Event>()
    const failing = follow(link.wire, { open, resume: cursor([]) })
    const first = failing.next()
    await vi.waitFor(() => expect(last()).toBeDefined())
    last().feed.push(event(1))
    await first
    last().feed.fail(new WireError("CONTROL_IN_USE"))
    await expect(failing.next()).rejects.toMatchObject({ code: "CONTROL_IN_USE" })
    expect(failing.finished).toBe("failed")

    const ending = follow(link.wire, { open, resume: cursor([]) })
    const count = opened.length
    const pending = ending.next()
    await vi.waitFor(() => expect(opened).toHaveLength(count + 1))
    last().feed.end()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(ending.finished).toBe("ended")
    expect(ending.session).toBeUndefined()
  })

  it("throws a failure before its first item, with nothing to resume", async () => {
    const link = connection()
    link.connect()
    const { refusals, open } = streams<Event>()
    refusals.push(new WireError("TERMINAL_NOT_FOUND"), new WireError("DISCONNECTED"))
    const items = follow(link.wire, { open, resume: cursor([]) })
    await expect(items.next()).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    // Even a lost connection: there's no position to resume from.
    const again = follow(link.wire, { open, resume: cursor([]) })
    await expect(again.next()).rejects.toMatchObject({ code: "DISCONNECTED" })
  })
})
