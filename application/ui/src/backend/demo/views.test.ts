import type { AttachStream, TerminalEvent } from "@novadeck/terminal"

import { terminalKeyId } from "#core/registry"
import { workspaceFromSeed } from "#core/seed"
import { createStore } from "#core/store"
import type { TerminalMetadata, Workspace } from "#core/types"

import { context, describe, expect, it } from "../../test"
import type { BackendConnectionState, TerminalKey } from "../port"
import { createDemoEngine } from "./engine"
import { demoSeed, demoTerminalId } from "./samples"
import type { DemoScreen } from "./surface"
import { demoViewOptions } from "./views"

const session = { projectId: "storefront", workspaceSessionId: "initial" }
const shell: TerminalKey = { ...session, terminalId: demoTerminalId(session, 1) }

// The plain demo's workspace, its first terminal changed as `change` says.
const workspaceWith = (change: Partial<TerminalMetadata> = {}): Workspace => {
  const workspace = workspaceFromSeed(demoSeed(0), { view: "focus", windowedView: "grid", now: 0 })
  return {
    ...workspace,
    projects: workspace.projects.map((project) => ({
      ...project,
      history: project.history.map((each) => ({
        ...each,
        state: {
          ...each.state,
          roster: {
            ...each.state.roster,
            terminals: each.state.roster.terminals.map((terminal) =>
              terminal.id === shell.terminalId
                ? ({ ...terminal, ...change } as TerminalMetadata)
                : terminal,
            ),
          },
        },
      })),
    })),
  }
}

// The demo's view options over its engine, with the debug layer's runtime.
const open = (change?: Partial<TerminalMetadata>) => {
  const engine = createDemoEngine()
  engine.reconcile(workspaceWith(change), [])
  const screens = createStore<ReadonlyMap<string, DemoScreen>>(new Map())
  const fails = new Set<string>()
  const restarted: TerminalKey[] = []
  const { options } = demoViewOptions(engine, {
    runtime: {
      connection: createStore<BackendConnectionState>("connected"),
      screens,
      restart: (key) => restarted.push(key),
      failPaste: (key) => fails.delete(terminalKeyId(key)),
    },
  })
  const attaching = (on: boolean): void =>
    void screens.update(() =>
      on ? new Map([[terminalKeyId(shell), { attaching: true as const }]]) : new Map(),
    )
  return { engine, options, attaching, fails, restarted }
}

// The stream's events, one at a time.
const reader = (stream: AttachStream) => {
  const events = stream[Symbol.asyncIterator]()
  return (): Promise<IteratorResult<TerminalEvent, unknown>> => events.next()
}

// Whether the stream ends after what it still had to say.
const ends = async (next: ReturnType<typeof reader>): Promise<boolean> => {
  for (let read = 0; read < 10; read += 1) {
    // eslint-disable-next-line no-await-in-loop -- In order, until it ends.
    if ((await next()).done) return true
  }
  return false
}

describe("the demo's terminal views", () => {
  context("attaching to a terminal", () => {
    it("opens with its whole screen, bracketed paste on, then what changes", async () => {
      const { options, engine } = open()
      const stream = await options.attach(shell)
      const next = reader(stream)
      const first = (await next()).value as Extract<TerminalEvent, { type: "snapshot" }>
      expect(first.type).toBe("snapshot")
      expect(first.data.startsWith("\x1b[?2004h")).toBe(true)
      expect(first.data).toContain("On branch")
      await stream.write("pwd\r")
      const output = (await next()).value as Extract<TerminalEvent, { type: "output" }>
      expect(output.type).toBe("output")
      expect(engine.getSnapshot(shell).entries.map((entry) => entry.command)).toEqual(["pwd"])
    })

    it("ends when closed, and a new stream takes over from an old one", async () => {
      const { options } = open()
      const old = await options.attach(shell)
      const next = reader(old)
      await next()
      await options.attach(shell)
      expect((await next()).done).toBe(true)
    })

    it("draws a typed key in the tail alone, never the whole screen again", async () => {
      const { options } = open()
      const stream = await options.attach(shell)
      const next = reader(stream)
      await next()
      await stream.write("l")
      const { value } = (await next()) as { value: Extract<TerminalEvent, { type: "output" }> }
      expect(value.data).not.toContain("\x1b[3J")
      expect(value.data).not.toContain("On branch")
    })
  })

  context("while the debug layer has its output on the way", () => {
    it("ends the stream, and attaches again once it has come", async () => {
      const { options, attaching } = open()
      const next = reader(await options.attach(shell))
      await next()
      attaching(true)
      expect(await ends(next)).toBe(true)
      const lifecycle = options.lifecycle(shell)!
      let back = false
      void lifecycle.revived.then(() => (back = true))
      const waiting = options.attach(shell)
      await Promise.resolve()
      expect(back).toBe(false)
      attaching(false)
      await lifecycle.revived
      expect((await reader(await waiting)()).value).toMatchObject({ type: "snapshot" })
    })
  })

  context("while its shell is starting", () => {
    it("is not ready, so the views lock, and ends a stream a restart catches", async () => {
      const { options, engine } = open()
      const next = reader(await options.attach(shell))
      await next()
      engine.reconcile(workspaceWith({ state: "starting" } as Partial<TerminalMetadata>), [])
      expect(await ends(next)).toBe(true)
      let ready: boolean | undefined
      void options.lifecycle(shell)!.ready.then((value) => (ready = value))
      await Promise.resolve()
      expect(ready).toBeUndefined()
      engine.reconcile(workspaceWith(), [])
      await expect(options.lifecycle(shell)!.ready).resolves.toBe(true)
    })

    it("refuses to attach to a terminal that closed meanwhile", async () => {
      const { options, engine } = open({ state: "starting" } as Partial<TerminalMetadata>)
      const waiting = options.attach(shell)
      const empty = workspaceWith()
      engine.reconcile(
        {
          ...empty,
          projects: empty.projects.map((project) => ({
            ...project,
            history: project.history.map((each) => ({
              ...each,
              state: {
                ...each.state,
                roster: {
                  ...each.state.roster,
                  terminals: each.state.roster.terminals.filter(
                    (terminal) => terminal.id !== shell.terminalId,
                  ),
                },
              },
            })),
          })),
        },
        [],
      )
      await expect(waiting).rejects.toThrow("The terminal closed")
    })
  })

  context("pasting a file", () => {
    it("says where it would be, and fails once where the debug panel asks", async () => {
      const { options, fails } = open()
      const file = { name: "shot.png", data: new Uint8Array() }
      await expect(options.paste.upload(shell, file)).resolves.toBe("/tmp/novadeck-paste/shot.png")
      fails.add(terminalKeyId(shell))
      await expect(options.paste.upload(shell, file)).rejects.toThrow()
      await expect(options.paste.upload(shell, file)).resolves.toBeTruthy()
    })

    it("words a failure as the runner does", () => {
      const { options } = open()
      expect(options.paste.notice({ kind: "clipboard" })).toBe("Novadeck can't read the clipboard")
      expect(
        options.paste.notice({ kind: "file", type: "image/png", tooLarge: true, error: undefined }),
      ).toBe("Couldn't paste the image: it's over 32 MB")
    })
  })

  it("restarts through the debug layer", () => {
    const { options, restarted } = open()
    options.restart(shell)
    expect(restarted).toEqual([shell])
  })
})
