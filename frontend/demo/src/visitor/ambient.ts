import type { Backend, TerminalKey } from "@novadeck/core/port"
import { createStore, type Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import { lessMotion } from "../motion"
import { demoTerminalId, sampleOutput } from "../samples"
import { sampleBlocks } from "../screen/samples"
import type { Block } from "../screen/screen"
import type { DemoIntro } from "../screen/terminal"
import { terminalOf } from "../terminals"
import type { DemoTurns } from "../turns"
import { reviewing } from "./story"

// What goes on at the visitor's desk by itself, slowly, so it reads as a place where work
// happens: the dev server hot-updates a file now and then, the tests rerun and pass, and
// Codex, reviewing, has a few subagents look into something and finish. None of it asks
// anything of the visitor or marks any tab as needing them, and none of it comes while
// the page is hidden or where the visitor asked for less motion. Next to it the story
// moves on only as the visitor answers (see `visitorStory`).

// How many times the dev server and the tests moved on since the desk opened.
export type Beats = { readonly server: number; readonly tests: number }

// The time between the dev server's updates and between the tests' reruns, in milliseconds.
export const serverEveryMs = 14_000
export const testsEveryMs = 23_000
// How long Codex reviews on its own before subagents first look into something, how long
// they take, and how long it is on its own again before the next, in milliseconds.
export const reviewRestMs = 12_000
export const reviewBusyMs = 8_000
export const reviewLullMs = 26_000

const session = { projectId: "storefront", workspaceSessionId: "initial" }
const codex: TerminalKey = { ...session, terminalId: demoTerminalId(session, 4) }

// A block as it draws, to tell two apart.
const drawn = (block: Block | undefined): string => JSON.stringify(block?.(80))

// The screen a count of beats draws, made once per count: a later count whose blocks start
// with an earlier one's keeps them, so its screen appends what the beat adds.
const ambientIntro = (beats: Store<Beats>, draw: (beats: Beats) => Block[]): DemoIntro => {
  let made: { beats: Beats; blocks: Block[] } | undefined
  return {
    getSnapshot: () => {
      const counted = beats.getSnapshot()
      if (made?.beats === counted) return made.blocks
      const fresh = draw(counted)
      // The blocks of the count before that draw the same keep their identity.
      const kept = made?.blocks ?? []
      const same = (at: number): boolean => drawn(kept[at]) === drawn(fresh[at])
      const blocks = fresh.map((block, at) => (same(at) ? kept[at]! : block))
      made = { beats: counted, blocks }
      return blocks
    },
    subscribe: beats.subscribe,
  }
}

export const visitorAmbient = (turns: DemoTurns) => {
  const beats = createStore<Beats>({ server: 0, tests: 0 })

  // The dev server's and the tests' screens, which count the beats: the server logs one
  // more hot update, and the tests clear the screen to rerun. Any other terminal opens with
  // its own.
  const introOf = (terminal: TerminalMetadata, key: TerminalKey): DemoIntro | undefined => {
    const output = sampleOutput(terminal)
    if (key.projectId !== session.projectId || (output !== "server" && output !== "tests"))
      return undefined
    return ambientIntro(beats, (counted) =>
      sampleBlocks(output, {
        directory: terminal.directory,
        projectName: key.projectId,
        beats: output === "server" ? counted.server : counted.tests,
      }),
    )
  }

  const wrap = (backend: Backend): Backend => {
    let latest: Workspace | undefined
    return {
      ...backend,
      commit: (workspace, actions) => {
        backend.commit(workspace, actions)
        latest = workspace
      },
      start: (sink) => {
        const stop = backend.start?.(sink)
        if (lessMotion()) return () => stop?.()
        const timers = new Set<ReturnType<typeof setTimeout>>()
        // Beats come only while the page is in view, so what happened in a hidden tab
        // isn't there to catch up on.
        const every = (ms: number, beat: () => void): void => {
          timers.add(setInterval(() => !document.hidden && beat(), ms))
        }
        every(serverEveryMs, () => beats.update((was) => ({ ...was, server: was.server + 1 })))
        every(testsEveryMs, () => beats.update((was) => ({ ...was, tests: was.tests + 1 })))
        // Codex's subagents come and go while it is still reviewing, and stay as they are
        // once it asks or ends.
        const review = (subagents: boolean, wait: number): void => {
          const timer = setTimeout(() => {
            timers.delete(timer)
            if (document.hidden) return review(subagents, wait)
            const terminal = terminalOf(latest, codex)
            if (!reviewing(terminal)) return
            turns.work(codex, terminal, subagents ? { subagents: true } : undefined)
            review(!subagents, subagents ? reviewBusyMs : reviewLullMs)
          }, wait)
          timers.add(timer)
        }
        review(true, reviewRestMs)
        return () => {
          stop?.()
          timers.forEach((timer) => {
            clearTimeout(timer)
            clearInterval(timer)
          })
        }
      },
    }
  }
  return { introOf, wrap }
}
