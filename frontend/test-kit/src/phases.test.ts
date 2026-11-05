import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

import { expect, it, onTestFinished } from "vitest"

import { testPhases } from "./phases"

setFlagsFromString("--expose-gc")
const collect = runInNewContext("gc") as () => void

type Row = { readonly phase: string; readonly gcMs: number }

// The failure is staged: the test marks itself failed, and a hook registered before
// testPhases' (so run after it) checks what was logged and passes the test again.
it("notes a failure while it still watches, with the GC the test caused", ({ task }) => {
  const logged: unknown[][] = []
  const error = console.error
  onTestFinished(() => {
    console.error = error
    task.result!.state = "pass"
    expect(logged).toHaveLength(1)
    const [label, json] = logged[0]!
    expect(label).toBe("UI_TEST_PHASES")
    const { name, phases } = JSON.parse(String(json)) as { name: string; phases: Row[] }
    expect(name).toBe("staged")
    expect(phases.map(({ phase }) => phase)).toEqual(["start", "failure"])
    expect(phases[1]!.gcMs).toBeGreaterThan(0)
  })
  console.error = (...args: unknown[]) => void logged.push(args)
  testPhases("staged")
  // Enough garbage that collecting it takes a measurable while.
  let garbage: unknown[] | undefined = Array.from({ length: 200_000 }, (_, i) => ({ i }))
  garbage = undefined
  void garbage
  collect()
  task.result!.state = "fail"
})

it("logs nothing for a test that passes", () => {
  const logged: unknown[][] = []
  const error = console.error
  onTestFinished(() => {
    console.error = error
    expect(logged).toEqual([])
  })
  console.error = (...args: unknown[]) => void logged.push(args)
  testPhases("passing")("midway")
})
