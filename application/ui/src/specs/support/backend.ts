import type { Backend } from "#core/port"
import type { PortableInstall } from "#core/portable"
import type { SandboxState } from "#core/sandbox"

import { createDemoBackend } from "../../backend/demo"
import { createContentDemo } from "../../backend/demo/content"
import {
  createDemoPortable,
  type DemoPortable,
  type PortableSchedule,
} from "../../backend/demo/debug/portable"
import { createDemoSandbox, sampleFix } from "../../backend/demo/debug/sandbox"
import {
  portableScenarios,
  updateScenarios,
  type PortableScenarioKey,
  type UpdateScenario,
  type UpdateScenarioKey,
} from "../../backend/demo/debug/scenarios"
import { createDemoUninstall, uninstallScenarios } from "../../backend/demo/debug/uninstall"
import { createDemoUpdates } from "../../backend/demo/debug/updates"
import { visitorDemo } from "../../backend/demo/visitor"
import { pageTheme } from "../../theme/source"

// The demo's variants a spec asks for in its address, and the backend that offers them:
// the one place specs and tests reach the demo, kept out of the file that chooses
// the backend so the demo stays one folder.

// Specs open the content demo, with its agents' plans and artifacts, by adding
// `?demo=showcase` to the address's hash. The address is read when the workspace
// mounts, since each spec sets its own.
const showcaseRequested = (): boolean =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("demo") === "showcase"

// Specs open the demo on a host that has an update with `?update=` one of the debug
// panel's update scenarios (see backend/demo/debug/scenarios.ts), beside any other variant.
const requestedUpdate = (): UpdateScenario | undefined => {
  const key = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("update")
  return key && Object.hasOwn(updateScenarios, key)
    ? updateScenarios[key as UpdateScenarioKey]
    : undefined
}

// The updates a spec asks for: an explicit `?update=` wins, else the release a portable
// scenario has waiting (as the debug panel offers it).
const demoWithUpdate = (
  scenario: UpdateScenario | undefined,
  portable: DemoPortable | undefined,
  demo: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  if (!scenario && !portable?.offer) return demo
  const controls = createDemoUpdates()
  if (scenario) scenario.play(controls, "0.0.80")
  else if (portable?.offer) controls.offer(portable.offer)
  return { ...demo, updates: controls.updates }
}

// Specs open the demo on a host running without its security sandbox with `?sandbox=off`,
// or `?sandbox=off-unfixed` for one with no command to offer.
const requestedSandbox = (): SandboxState | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const sandbox = query.get("sandbox")
  if (sandbox === "off") return { sandboxed: false, fix: sampleFix }
  if (sandbox === "off-unfixed") return { sandboxed: false, fix: "" }
  return undefined
}

// Specs open the demo on a portable copy with `?portable=` one of the debug panel's
// portable scenarios (see backend/demo/debug/scenarios.ts). Installing takes no time there,
// unless `&installMs=` says how long, or `&installMs=stepped` holds each step for the spec
// to take with `portableInstall.advanceTo`, as a slow machine would otherwise pass a step
// before the spec reads it.
const requestedPortable = (): DemoPortable | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const key = query.get("portable")
  if (!key || !Object.hasOwn(portableScenarios, key)) return undefined
  const portable = portableScenarios[key as PortableScenarioKey].setup("0.0.80")
  if (!portable) return undefined
  const installMs = query.get("installMs") === "stepped" ? 3000 : Number(query.get("installMs"))
  return { ...portable, installAfterMs: installMs > 0 ? installMs : 0 }
}

// The steps of a stepped install, in the order their waits would have run them.
const held: { readonly at: number; readonly next: PortableInstall; readonly apply: () => void }[] =
  []
const stepped = (): boolean => {
  const on =
    new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("installMs") === "stepped"
  // Each workspace a spec opens is a new backend, whose install starts with nothing held.
  if (on) held.length = 0
  return on
}
const hold: PortableSchedule = (apply, next, at) => void held.push({ at, next, apply })

/** A stepped install (`&installMs=stepped`), which moves only when the spec says. */
export const portableInstall = {
  /** Takes the held steps in order until one leaves the install in `phase`. */
  advanceTo: (phase: PortableInstall["phase"]): void => {
    held.sort((a, b) => a.at - b.at)
    for (let step = held.shift(); step; step = held.shift()) {
      step.apply()
      if (step.next.phase === phase) return
    }
    throw new Error(`No step of the install left that reaches ${phase}`)
  },
}

// Specs open the demo on a host that offers uninstalling with `?uninstall=` one of the
// debug panel's scenarios (see backend/demo/debug/uninstall.ts).
const requestedUninstall = (): Backend["uninstall"] => {
  const name = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("uninstall")
  return name && name in uninstallScenarios
    ? createDemoUninstall(uninstallScenarios[name as keyof typeof uninstallScenarios]).uninstall
    : undefined
}

// `&version=dev` makes the host a development build, which carries 0.0.0, and
// `&version=none` one that gives no version.
const requestedVersion = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  const version = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("version")
  if (version === "dev") return { ...backend, version: () => Promise.resolve("0.0.0") }
  if (version !== "none") return backend
  const { version: _given, ...rest } = backend
  return rest
}

// Specs open the demo as a visitor's, with `?visitor=on`: what the app shows for one.
// `&turnMs=` and `&nudgeMs=` shorten its agents' turns and the wait before Codex asks;
// `&readingMs=` has Claude Code read that long before its plan comes, and none without. What
// goes on at the desk by itself stays out of specs.
const visitorRequested = (): boolean =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("visitor") === "on"

const visitorTimings = (): {
  turnMs?: number
  nudgeMs?: number
  readingMs: number
  ambient: false
} => {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const turnMs = Number(params.get("turnMs"))
  const nudgeMs = Number(params.get("nudgeMs"))
  const readingMs = Number(params.get("readingMs"))
  return {
    ...(turnMs > 0 && { turnMs }),
    ...(nudgeMs > 0 && { nudgeMs }),
    readingMs: readingMs > 0 ? readingMs : 0,
    ambient: false,
  }
}

// The demo a spec opens, as its address's hash asks.
export const createSpecBackend = (): ReturnType<typeof createDemoBackend> => {
  if (visitorRequested()) return visitorDemo({ ...visitorTimings(), theme: pageTheme })
  if (showcaseRequested()) return createContentDemo({ theme: pageTheme })
  const update = requestedUpdate()
  const sandbox = requestedSandbox()
  const portable = requestedPortable()
  const demo = requestedVersion(
    demoWithUpdate(update, portable, createDemoBackend({ theme: pageTheme })),
  )
  const uninstall = requestedUninstall()
  const withSandbox = sandbox ? { ...demo, sandbox: createDemoSandbox(sandbox) } : demo
  const withUninstall = uninstall ? { ...withSandbox, uninstall } : withSandbox
  return portable
    ? {
        ...withUninstall,
        portable: createDemoPortable(portable, stepped() ? { schedule: hold } : {}).portable,
      }
    : withUninstall
}
