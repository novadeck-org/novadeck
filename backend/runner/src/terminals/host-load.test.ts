import { describe, expect, it } from "../test.js"
import {
  calmMs,
  hostPollMs,
  HostLoad,
  renderHost,
  Strain,
  strainMs,
  type Agent,
  type HostReading,
  type Load,
  type TerminalCpu,
} from "./host-load.js"

const cores = 8

/** Readings of a host `busy` percent busy, one every poll, with each terminal's CPU so far. */
const feed = (load: HostLoad) => {
  let at = 0
  let busyMs = 0
  let totalMs = 0
  const total = new Map<string, number>()
  const names = new Map<string, string>()
  return (
    busy: number,
    use: Record<string, number> = {},
    options: { memory?: number; every?: number } = {},
  ): Load | undefined => {
    const every = options.every ?? hostPollMs
    at += every
    totalMs += every * cores
    busyMs += (every * cores * busy) / 100
    const terminals = new Map<string, TerminalCpu>()
    for (const [id, percent] of Object.entries(use)) {
      total.set(id, (total.get(id) ?? 0) + (every * cores * percent) / 100)
      names.set(id, names.get(id) ?? `prog-${id}`)
      terminals.set(id, {
        ms: total.get(id)!,
        programs: [{ pid: Number(id.length), name: `${id}.exe`, ms: total.get(id)! }],
      })
    }
    const host: HostReading = { at, busyMs, totalMs, memoryPercent: options.memory }
    return load.ingest(host, terminals)
  }
}

describe("host load", () => {
  it("is known from the second reading, against the first", () => {
    const next = feed(new HostLoad())
    expect(next(50)).toBeUndefined()
    expect(next(50)?.cpu).toBe(50)
  })

  it("attributes the machine's CPU to the terminals whose processes used it, and names a program", () => {
    const next = feed(new HostLoad())
    next(0, { fox: 0, owl: 0 })
    const load = next(95, { fox: 50, owl: 30 })!
    expect(load.cpu).toBe(95)
    expect(load.shares.get("fox")).toEqual({ percent: 50, program: "fox" })
    expect(load.shares.get("owl")?.percent).toBe(30)
  })

  it("gives a terminal first read now no share, as what it used before is no use of this interval", () => {
    const next = feed(new HostLoad())
    next(10)
    expect(next(10, { fox: 80 })!.shares.size).toBe(0)
  })

  it("counts a stretch of high CPU through dips shorter than calm, and ends it once calm", () => {
    const next = feed(new HostLoad())
    next(95)
    next(95)
    const high = next(95)!
    expect(high.cpuHighFor).toBe(hostPollMs)
    // A short dip leaves the stretch running.
    expect(next(50)!.cpuHighFor).toBe(2 * hostPollMs)
    let last = next(95)!
    expect(last.cpuHighFor).toBe(3 * hostPollMs)
    for (let waited = 0; waited < calmMs; waited += hostPollMs) last = next(20)!
    expect(last.cpuHighFor).toBe(0)
  })

  it("forgets what was read when reset", () => {
    const load = new HostLoad()
    const next = feed(load)
    next(95)
    next(95)
    load.reset()
    expect(load.current).toBeUndefined()
  })
})

describe("the listing's host section", () => {
  const names = new Map([
    ["me", "fox"],
    ["owl", "owl"],
    ["elk", "elk"],
  ])
  const load = (fields: Partial<Load>): Load => ({
    at: 0,
    cpu: 10,
    memory: undefined,
    cpuHighFor: 0,
    memoryHighFor: 0,
    shares: new Map(),
    ...fields,
  })

  it("is left out where the host is idle-ish", () => {
    expect(renderHost(load({ cpu: 40, memory: 60 }), names, "me")).toBeUndefined()
    expect(renderHost(undefined, names, "me")).toBeUndefined()
  })

  it("says who uses the CPU by handle, the caller as you, and everything else as one figure", () => {
    const text = renderHost(
      load({
        cpu: 94,
        cpuHighFor: 4 * 60_000,
        memory: 70,
        shares: new Map([
          ["owl", { percent: 41, program: "cargo" }],
          ["me", { percent: 12, program: null }],
          ["elk", { percent: 2, program: "node" }],
          ["gone", { percent: 9, program: "node" }],
        ]),
      }),
      names,
      "me",
    )
    expect(text).toBe(
      [
        "Host load now: CPU 94% (90% or more for 4 min).",
        "Most CPU, of the machine's: @owl 41% (cargo), you 12%, everything else (other projects, other programs) 41%.",
      ].join("\n"),
    )
  })

  it("leaves a spike's length out and says memory when it is high", () => {
    expect(
      renderHost(
        load({ cpu: 65, cpuHighFor: 10_000, memory: 93, memoryHighFor: 120_000 }),
        names,
        "me",
      ),
    ).toBe(
      [
        "Host load now: CPU 65%, memory 93% in use (90% or more for 2 min).",
        "Most CPU, of the machine's: everything else (other projects, other programs) 65%.",
      ].join("\n"),
    )
  })

  it("says only memory when only memory is high", () => {
    expect(renderHost(load({ cpu: 20, memory: 95 }), names, "me")).toBe(
      "Host load now: memory 95% in use.",
    )
  })
})

describe("the strain notice", () => {
  const agents: Agent[] = [
    { id: "me", handle: "fox", sessionId: "s1", waiting: false },
    { id: "owl", handle: "owl", sessionId: "s1", waiting: false },
    { id: "elk", handle: "elk", sessionId: "s1", waiting: true },
    { id: "far", handle: "far", sessionId: "s2", waiting: false },
  ]
  const strained = (shares: Record<string, number>, cpuHighFor = strainMs): Load => ({
    at: 0,
    cpu: 96,
    memory: undefined,
    cpuHighFor,
    memoryHighFor: 0,
    shares: new Map(
      Object.entries(shares).map(([id, percent]) => [id, { percent, program: null }]),
    ),
  })
  const sink = () => {
    const sent: [string, string][] = []
    return {
      sent,
      send: (id: string, text: string) => {
        sent.push([id, text])
        return true
      },
    }
  }

  it("tells each contributing agent once, with facts only, naming the others by handle", () => {
    const { sent, send } = sink()
    const strain = new Strain()
    strain.run(strained({ me: 40, owl: 30 }, 4 * 60_000), agents, send)
    expect(sent).toEqual([
      [
        "me",
        "Novadeck: automatic notice, not from the user: Host CPU has been at 90% or more for 4 min; heaviest here: you 40%, @owl 30%.",
      ],
      [
        "owl",
        "Novadeck: automatic notice, not from the user: Host CPU has been at 90% or more for 4 min; heaviest here: @fox 40%, you 30%.",
      ],
    ])
    // Not again while the strain lasts.
    strain.run(strained({ me: 40, owl: 30 }, 5 * 60_000), agents, send)
    expect(sent).toHaveLength(2)
  })

  it("tells nothing before the strain has lasted, or with a single contributor", () => {
    const { sent, send } = sink()
    const strain = new Strain()
    strain.run(strained({ me: 40, owl: 30 }, strainMs - 1), agents, send)
    strain.run(strained({ me: 80, owl: 2 }), agents, send)
    expect(sent).toEqual([])
  })

  it("counts contributors of one project and session only", () => {
    const { sent, send } = sink()
    new Strain().run(strained({ me: 40, far: 40 }), agents, send)
    expect(sent).toEqual([])
  })

  it("names a terminal that waits on the person but doesn't tell it", () => {
    const { sent, send } = sink()
    new Strain().run(strained({ me: 40, elk: 30 }), agents, send)
    expect(sent).toEqual([
      [
        "me",
        "Novadeck: automatic notice, not from the user: Host CPU has been at 90% or more for 3 min; heaviest here: you 40%, @elk 30%.",
      ],
    ])
  })

  it("tells again in the next strain, and retries a notice that wasn't taken", () => {
    const { sent, send } = sink()
    const strain = new Strain()
    const refuse = (): boolean => false
    strain.run(strained({ me: 40, owl: 30 }), agents, refuse)
    strain.run(strained({ me: 40, owl: 30 }), agents, send)
    expect(sent).toHaveLength(2)
    strain.run(strained({}, 0), agents, send)
    strain.run(strained({ me: 40, owl: 30 }), agents, send)
    expect(sent).toHaveLength(4)
  })
})
