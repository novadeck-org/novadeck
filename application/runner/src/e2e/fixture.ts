import { rmSync } from "node:fs"
import { join } from "node:path"

import { agentName } from "@novadeck/protocol"
import { beforeAll } from "vitest"

import { it as base } from "../test.js"
import type { AgentSetup } from "./agents/agent.js"
import { setups as every } from "./agents/index.js"
import { createDeck, type Deck } from "./deck.js"
import { installHarness } from "./install.js"
import { startFakeModel, type FakeModel } from "./model/server.js"
import { reap } from "./reap.js"
import { createSandbox, type Sandbox } from "./sandbox.js"
import { tripwire } from "./tripwire.js"

export { describe, expect } from "../test.js"

/**
 * Whether the suite can run here: Linux only. Elsewhere the sandbox's dead D-Bus address
 * doesn't keep a harness from the developer's keyring, as the macOS Keychain needs no
 * bus, and the leftover-process check reads /proc. A scenario file can skip on it
 * (`describe.skipIf(!supported)`); a test that runs anyway fails, saying why.
 */
export const supported = process.platform === "linux"

/**
 * The harnesses this run tests, from `NOVADECK_E2E_AGENTS`: their names, comma-separated
 * (`claude,codex`), or every harness when it is unset or empty. A name that isn't one
 * fails the run rather than leaving a harness untested.
 */
const chosen = ((): ReadonlySet<string> | undefined => {
  const names = (process.env.NOVADECK_E2E_AGENTS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0) return undefined
  const unknown = names.filter((name) => !agentName.safeParse(name).success)
  if (unknown.length > 0)
    throw new Error(
      `NOVADECK_E2E_AGENTS names no harness ${unknown.join(", ")}: use ${agentName.options.join(", ")}`,
    )
  return new Set(names)
})()

/** Whether this run tests the setup's harness (`NOVADECK_E2E_AGENTS`). */
export const selected = (setup: Pick<AgentSetup, "agent">): boolean =>
  chosen === undefined || chosen.has(setup.agent)

export type E2E = {
  readonly model: FakeModel
  readonly sandbox: Sandbox
  readonly deck: Deck
}

/**
 * A test of real harnesses in NovaDeck's terminals, against the fake model: each setup's
 * pinned harness installed, seeded in a fresh sandbox and connected to NovaDeck. The
 * harnesses are installed once, before the file's tests, so a download counts against
 * the hook timeout rather than a test's. Once the test ends and its deck has closed, with
 * the fake model still listening for whatever a harness sends on its way out, the test
 * fails should any request have carried a real credential, tried a harness's real host or
 * tripped a dialect, should the developer's own harness homes have changed, or should any
 * process have outlived the deck in the sandbox. Unless the run tests every one of the
 * setups' harnesses (`selected`), the tests are skipped and nothing is installed.
 */
export const e2e = (...setups: AgentSetup[]) => {
  const runs = setups.every(selected)
  beforeAll(async () => {
    if (supported && runs) await Promise.all(setups.map((setup) => installHarness(setup.agent)))
  })
  const test = base.extend<{ e2e: E2E }>({
    e2e: async ({ resources }, use) => {
      if (!supported)
        throw new Error(
          `The end-to-end suite runs on Linux only, not ${process.platform}: elsewhere nothing keeps a harness from the developer's keyring`,
        )
      const model = await startFakeModel({ dialects: setups.map((setup) => setup.dialect) })
      resources.defer(() => model.close())
      // Installed before the file's tests: these are the same installs, already done.
      const installs = await Promise.all(setups.map((setup) => installHarness(setup.agent)))
      const sandbox = createSandbox({ proxy: model.proxy, bins: installs.map((one) => one.bin) })
      resources.defer(() =>
        rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      )
      // Whatever happens, nothing the test started outlives it. When the test ends early,
      // what this has to end is a leak too, and fails the test.
      resources.defer(async () => {
        const leftovers = await reap(sandbox)
        if (leftovers.length > 0)
          throw new Error(
            `process(es) outlived the deck in the sandbox, ended at teardown: ${leftovers.join(", ")}`,
          )
      })
      // The tripwire watches every harness's home, whichever a test runs.
      const changed = tripwire(sandbox, every)
      let env = sandbox.env
      for (const [index, setup] of setups.entries())
        env = {
          ...env,
          // eslint-disable-next-line no-await-in-loop -- Each setup sees what the ones before added.
          ...(await setup.prepare({ ...sandbox, env }, model, installs[index]!)),
        }
      const deck = await createDeck({
        data: join(sandbox.root, "data"),
        project: sandbox.project,
        env,
        // A restart fails on any process the closed runner left in the sandbox.
        leftovers: () => reap(sandbox),
      })
      let open = true
      const close = async () => {
        if (!open) return
        open = false
        await deck.close()
      }
      resources.defer(close)
      for (const setup of setups)
        // eslint-disable-next-line no-await-in-loop -- One plugin command at a time, as the runner runs them.
        await deck.connect(setup.agent)
      for (const setup of setups)
        // eslint-disable-next-line no-await-in-loop -- As above.
        await setup.connected?.({ ...sandbox, env }, model)

      await use({ model, sandbox: { ...sandbox, env }, deck })

      // Checked once the deck has closed, so what a harness sends as it exits counts too,
      // while the fake model still listens.
      await close()
      const leftovers = await reap(sandbox)
      const hosts = new Set(setups.flatMap((setup) => setup.hosts ?? []))
      const problems = [
        ...(model.foreign > 0
          ? [`${model.foreign} request(s) carried a credential other than the fake one`]
          : []),
        ...model.strays
          .filter((stray) => hosts.has(stray.split(" ")[1] ?? ""))
          .map((stray) => `a request tried the real API: ${stray}`),
        ...model.errors.map((error) => `the fake model failed on a request: ${error}`),
        ...changed().map((path) => `the developer's harness home changed: ${path}`),
        ...leftovers.map((one) => `a process outlived the deck in the sandbox: ${one}`),
      ]
      await model.close()
      if (problems.length > 0) throw new Error(problems.join("\n"))
    },
  })
  return test.skipIf(!runs)
}
