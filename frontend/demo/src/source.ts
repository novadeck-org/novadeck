import type { Backend } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import type { Source, SourceFile, SourceProject, SourceState } from "@novadeck/core/source"
import { createStore } from "@novadeck/core/store"

import { demoHandle } from "./handles"
import { lessMotion, stillRequested } from "./motion"
import { demoTerminalId } from "./samples"
import type { DemoTurns } from "./turns"

// The demo's Source panel: the storefront project's files as its agents change them, from
// fixtures. Each agent notionally works in its own worktree, so every write is its handle's.
// Moth's changes are history, from the plan it waits on. An agent writes only while it
// works: its terminal's agent status says it works and asks nothing of the person. Then it
// writes while the page is in view, a file every few seconds, now and then resting between
// turns; waiting on the person or at rest, it writes nothing and shows no cursor.

const projectId = "storefront"
const session = { projectId, workspaceSessionId: "initial" }

// The agents in the storefront project that change files, by the handle of their slot.
const moth = demoHandle(1)
const crow = demoHandle(4)
// The agents that write by themselves, by the terminal of their slot.
const slots = [
  { handle: moth, terminalId: demoTerminalId(session, 1) },
  { handle: crow, terminalId: demoTerminalId(session, 4) },
]

// The handles of the storefront agents that work, asking nothing of the person, as the seed
// opens them: the ones that write by themselves (Moth and Crow).
export const workingInSeed = (seed: WorkspaceSeed): readonly string[] =>
  seed.projects
    .filter((project) => project.id === projectId)
    .flatMap((project) => project.sessions.flatMap((each) => each.terminals))
    .flatMap((terminal) =>
      terminal.state === "running" &&
      terminal.agent?.working &&
      !terminal.agent.attention &&
      (terminal.handle === moth || terminal.handle === crow)
        ? [terminal.handle]
        : [],
    )

// The handle of a third storefront agent, which the debug panel has change a file Moth and
// Crow did, so a row has three: the third terminal, Claude Code in the agents demos.
export const sourceThird = demoHandle(3)

const minute = 60_000

// Paths the debug panel and the specs name.
export const sourcePaths = {
  checkout: "src/checkout/Checkout.tsx",
  checkoutTest: "src/checkout/Checkout.test.tsx",
  payments: "src/api/payments.ts",
} as const

// The storefront's tree before any agent's work.
const entries: readonly string[] = [
  ".env.local",
  ".github/workflows/ci.yml",
  ".gitignore",
  "README.md",
  "index.html",
  "node_modules/",
  "package.json",
  "pnpm-lock.yaml",
  "public/favicon.svg",
  "src/App.tsx",
  "src/api/client.ts",
  "src/api/orders.ts",
  "src/cart/CartItem.tsx",
  "src/cart/CartSummary.tsx",
  "src/cart/useCart.ts",
  sourcePaths.checkoutTest,
  "src/checkout/AddressForm.tsx",
  sourcePaths.checkout,
  "src/checkout/PaymentStep.tsx",
  "src/components/Button.tsx",
  "src/components/Price.tsx",
  "src/main.tsx",
  "vite.config.ts",
  "vitest.config.ts",
]

const ignored: readonly string[] = ["node_modules/", ".env.local"]

const file = (kind: SourceFile["kind"], touched: SourceFile["touched"]): SourceFile => ({
  kind,
  touched,
})

// What the agents changed before the page opened, `now` being when it did.
const history = (now: number): SourceProject["changes"] => ({
  "src/cart/CartSummary.tsx": file("modified", { [moth]: now - 6 * minute }),
  "src/cart/useCart.ts": file("modified", { [moth]: now - 7 * minute }),
  "src/checkout/OrderSummary.tsx": file("added", { [moth]: now - 9 * minute }),
  "src/checkout/OrderSummary.test.tsx": file("added", { [moth]: now - 10 * minute }),
  "package.json": file("modified", { [moth]: now - 14 * minute }),
  "pnpm-lock.yaml": file("modified", { [moth]: now - 14 * minute }),
  [sourcePaths.checkout]: file("modified", { [moth]: now - 10 * minute, [crow]: now - minute }),
  [sourcePaths.checkoutTest]: file("modified", { [crow]: now - 20_000 }),
  "src/checkout/LegacyCheckout.tsx": file("deleted", { [crow]: now - 3 * minute }),
})

// `working` is who works as the page opens: Crow, with its test in hand, where it does.
export const storefrontSource = (
  now: number,
  working: readonly string[] = [crow],
): SourceProject => ({
  entries,
  ignored,
  changes: history(now),
  writing: working.includes(crow) ? { [crow]: sourcePaths.checkoutTest } : {},
})

// The project with `handle`'s write to `path` at `at`: the file is changed by it, a
// new one added, an existing one modified, and it is the file the agent is writing now.
export const writeTo = (
  project: SourceProject,
  handle: string,
  path: string,
  at: number,
): SourceProject => {
  const was = project.changes[path]
  const kind =
    was && was.kind !== "deleted"
      ? was.kind
      : project.entries.includes(path) || was
        ? "modified"
        : "added"
  return {
    ...project,
    changes: { ...project.changes, [path]: file(kind, { ...was?.touched, [handle]: at }) },
    writing: { ...project.writing, [handle]: path },
  }
}

// The project with `handle`'s turn over: it is writing nothing.
export const endTurnIn = (project: SourceProject, handle: string): SourceProject => {
  const { [handle]: _, ...writing } = project.writing
  return { ...project, writing }
}

// What an agent writes: the files it keeps coming back to, and ones it creates, each the
// first time only.
type Pool = { readonly files: readonly string[]; readonly fresh: readonly string[] }

const pools: Readonly<Record<string, Pool>> = {
  [moth]: {
    files: [
      "src/cart/CartSummary.tsx",
      "src/cart/useCart.ts",
      "src/checkout/OrderSummary.tsx",
      "src/checkout/OrderSummary.test.tsx",
    ],
    fresh: [],
  },
  [crow]: {
    files: [
      sourcePaths.checkoutTest,
      sourcePaths.checkout,
      "src/checkout/PaymentStep.tsx",
      "src/checkout/AddressForm.tsx",
    ],
    fresh: ["src/checkout/PaymentForm.tsx", sourcePaths.payments],
  },
}

// Any other agent writes as Crow's pool.
const poolOf = (handle: string): Pool => pools[handle] ?? pools[crow]!

// The file an agent writes next, by a roll of `random`: mostly the one it is on, sometimes
// another of its pool, and now and then one it creates, if it has not yet.
export const nextFile = (
  project: SourceProject,
  handle: string,
  random: number,
  pick: number,
): string => {
  const { files, fresh } = poolOf(handle)
  const current = project.writing[handle] ?? files[0]!
  const created = fresh.find((path) => !project.changes[path])
  if (created && random < 0.12) return created
  const others = files.filter((path) => path !== current)
  if (random < 0.35 && others.length > 0) return others[Math.floor(pick * others.length)]!
  return current
}

// When the demo's time and scheduling come from, which a test replaces.
export type SourceClock = {
  readonly now: () => number
  readonly random: () => number
  // Runs `run` after `ms`, until the returned function is called.
  readonly after: (ms: number, run: () => void) => () => void
  readonly hidden: () => boolean
}

const realClock: SourceClock = {
  now: Date.now,
  random: Math.random,
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
  hidden: () => typeof document !== "undefined" && document.hidden,
}

// The time between an agent's writes, how many it makes in a turn, and how long it rests
// between turns, in milliseconds.
const writeMs = { min: 3000, max: 7000 }
const turnWrites = { min: 4, max: 8 }
const restMs = { min: 10_000, max: 20_000 }

const between = (range: { min: number; max: number }, roll: number): number =>
  range.min + Math.floor(roll * (range.max - range.min + 1))

export type DemoSource = Source & {
  // Has `handle` write a file now, `path` or else the one it would next, as its turn goes on.
  readonly write: (handle: string, path?: string) => void
  // Drops `handle`'s cursor: it is writing nothing until it writes again. Its agent's turn
  // is not touched.
  readonly endTurn: (handle: string) => void
  // Has Moth and Crow write on their own while their agents work, as `turns` reports them,
  // until stopped; stopping drops every cursor. Where the visitor asked for less motion, or
  // held the page still, nothing moves, though an agent that stops working still loses its
  // cursor.
  readonly start: (turns?: DemoTurns) => () => void
  // Stops the agent in a terminal writing for good: its terminal closed, or its project went.
  readonly close: (terminalId: string) => void
}

// Whether a backend's Source is the demo's, which the debug panel writes to.
export const isDemoSource = (source: Source | undefined): source is DemoSource =>
  source !== undefined && "write" in source && "endTurn" in source

export const createDemoSource = (
  now: number = Date.now(),
  clock: SourceClock = realClock,
  working: readonly string[] = [crow],
): DemoSource => {
  const state = createStore<SourceState>({
    projects: { [projectId]: storefrontSource(now, working) },
  })
  const change = (apply: (project: SourceProject) => SourceProject): void => {
    state.update((was) => {
      const project = was.projects[projectId]
      return project ? { projects: { ...was.projects, [projectId]: apply(project) } } : was
    })
  }
  const write = (handle: string, path?: string): void =>
    change((project) =>
      writeTo(
        project,
        handle,
        path ?? nextFile(project, handle, clock.random(), clock.random()),
        clock.now(),
      ),
    )
  const endTurn = (handle: string): void => change((project) => endTurnIn(project, handle))

  // One agent's turns, a write every few seconds and a rest between them, until stopped.
  const work = (handle: string): (() => void) => {
    let cancel: (() => void) | undefined
    const turn = (left: number): void => {
      if (left === 0) {
        endTurn(handle)
        cancel = clock.after(between(restMs, clock.random()), () =>
          turn(between(turnWrites, clock.random())),
        )
        return
      }
      cancel = clock.after(between(writeMs, clock.random()), () => {
        // Nothing is written while the page is out of view, so there is no catching up.
        if (clock.hidden()) return turn(left)
        write(handle)
        turn(left - 1)
      })
    }
    turn(between(turnWrites, clock.random()))
    return () => cancel?.()
  }

  // Agents whose terminal closed, which never write again.
  const closed = new Set<string>()
  // How a started simulation stops one agent; before it starts, dropping the cursor is all.
  let stopWriting = (handle: string): void => endTurn(handle)
  const close = (terminalId: string): void => {
    const slot = slots.find((each) => each.terminalId === terminalId)
    if (!slot) return
    closed.add(slot.handle)
    stopWriting(slot.handle)
  }

  const start = (turns?: DemoTurns): (() => void) => {
    // Held still or with less motion, no agent writes; the statuses are still followed, so an
    // agent that stops working loses the cursor it started with.
    const moving = !lessMotion() && !stillRequested()
    // Each writing agent's turns, while its agent works.
    const running = new Map<string, () => void>()
    const setWorking = (handle: string, on: boolean): void => {
      if (on && moving && !closed.has(handle) && !running.has(handle))
        running.set(handle, work(handle))
      if (on) return
      running.get(handle)?.()
      running.delete(handle)
      endTurn(handle)
    }
    stopWriting = (handle) => setWorking(handle, false)
    slots.forEach(({ handle }) => {
      if (working.includes(handle)) setWorking(handle, true)
    })
    const unwatch = turns?.watchStatus((key, agent) => {
      if (key.projectId !== projectId || key.workspaceSessionId !== session.workspaceSessionId)
        return
      const slot = slots.find((each) => each.terminalId === key.terminalId)
      if (slot) setWorking(slot.handle, agent.working && !agent.attention)
    })
    return () => {
      unwatch?.()
      running.forEach((stop) => stop())
      stopWriting = (handle) => endTurn(handle)
      // No cursor is left blinking.
      change((project) => ({ ...project, writing: {} }))
    }
  }

  return { state, write, endTurn, start, close }
}

// A backend with the demo's Source for the storefront project.
export const withSource = (
  backend: Backend,
  turns?: DemoTurns,
  source = createDemoSource(Date.now(), undefined, workingInSeed(backend.seed)),
): Backend => ({
  ...backend,
  source,
  commit: (workspace, actions) => {
    backend.commit(workspace, actions)
    // A closed terminal's agent writes no more, nor those of a removed storefront.
    for (const action of actions) {
      if (action.type === "terminal/close" && action.target.projectId === projectId)
        source.close(action.terminalId)
      if (action.type === "project/remove" && action.projectId === projectId)
        slots.forEach((slot) => source.close(slot.terminalId))
    }
  },
  start: (sink) => {
    const stop = backend.start?.(sink)
    const stopSource = source.start(turns)
    return () => {
      stop?.()
      stopSource()
    }
  },
})
