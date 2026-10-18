import { Interrupts as Interrupter, Prompts as Prompter } from "@novadeck/tui-input"
import type { InterruptHost } from "@novadeck/tui-input"
import { afterEach, vi } from "vitest"

import { Interrupts, Prompts } from "../terminals/prompting.js"
import { describe, expect, it } from "../test.js"
import type { FakeModel } from "./model/server.js"

// Traces are written only where `NOVADECK_E2E_TRACES` says (as CI's e2e run does), but they
// wrap the runner's classes whenever one starts, so a method that moved fails here, not
// only in an e2e run.
vi.stubEnv("NOVADECK_E2E_TRACES", "traces-are-not-written-here")
const { startTrace } = await import("./trace.js")

/** A model nothing asks anything of. */
const idle = new Proxy({}, { get: () => () => undefined }) as unknown as FakeModel

type Wrapped = Record<string, unknown>

describe("the e2e trace", () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    vi.unstubAllEnvs()
  })

  it("wraps the methods of the classes the runner runs, and puts them back", () => {
    const interrupts = Interrupter.prototype as unknown as Wrapped
    const prompts = Prompter.prototype as unknown as Wrapped
    const before = [interrupts.once, interrupts.settled, prompts.emptied, prompts.landed]
    const trace = startTrace("test", idle)
    stop = trace.stop
    const during = [interrupts.once, interrupts.settled, prompts.emptied, prompts.landed]
    during.forEach((wrapper, index) => expect(wrapper).not.toBe(before[index]))
    // What the runner builds runs the wrapped methods: the interrupts are the library's,
    // inside the runner's wrapper.
    const inner = (new Interrupts({} as InterruptHost) as unknown as { interrupts: Wrapped })
      .interrupts
    expect([inner.once, inner.settled]).toEqual(during.slice(0, 2))
    const prompting = new Prompts(
      {} as ConstructorParameters<typeof Prompts>[0],
      {} as ConstructorParameters<typeof Prompts>[1],
    ) as unknown as Wrapped
    expect([prompting.emptied, prompting.landed]).toEqual(during.slice(2))
    trace.stop()
    stop = undefined
    expect([interrupts.once, interrupts.settled, prompts.emptied, prompts.landed]).toEqual(before)
    // The runner's subclass is left as it was, with no copies of its own.
    expect(Object.hasOwn(Prompts.prototype, "emptied")).toBe(false)
    expect(Object.hasOwn(Prompts.prototype, "landed")).toBe(false)
  })
})
