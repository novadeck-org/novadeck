import type {
  ChatItem,
  ChatRequest,
  Conversation,
  Conversations,
} from "@novadeck/core/conversation"
import type { Backend } from "@novadeck/core/port"
import type { Store } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import { newerSamples } from "@novadeck/demo/showcase/artifacts"
import { isShowcase } from "@novadeck/demo/showcase/simulation"
import { terminalOf } from "@novadeck/demo/workspace"

import type { DemoAction, DemoActionGroup } from "./types"

// What a newer Novadeck's runner sends that this build doesn't know, which no demo agent sends:
// the selected agent's chat gains a dialog of a type it doesn't know, or a part of its record
// that a newer Novadeck tells of, and the dev server's pane shows an item of a kind it doesn't
// know. (Approvals, the Inbox, History and sleepers have their own actions.)

export const newerItem = (at: number): ChatItem => ({
  id: "newer-note",
  at,
  role: "note",
  kind: "text",
  text: "Bundle report: 2 files, 232.5 kB in all.",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
  note: { type: "newer" },
})

export const newerRequest = (at: number): ChatRequest => ({
  id: "newer-dialog",
  kind: "permission",
  tool: "Bash",
  subject: "pnpm lint --fix",
  choices: [],
  subagent: false,
  answered: false,
  askedAt: at,
  dialog: { type: "newer" },
})

type Played = { readonly items: readonly ChatItem[]; readonly requests: readonly ChatRequest[] }

// Wraps the demo's conversations so a chat gains what the panel played, and the panel's actions.
export const createNewerChat = (): {
  readonly wrap: (conversations: Conversations) => Conversations
  readonly actions: readonly DemoAction[]
} => {
  const played = new Map<string, Played>()
  const listeners = new Map<string, Set<() => void>>()
  const views = new Map<string, Store<Conversation>>()
  const tell = (id: string): void => listeners.get(id)?.forEach((listener) => listener())
  const play =
    (make: (at: number) => Played): DemoAction["run"] =>
    ({ selected, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      const id = terminalKeyId(key)
      const before = played.get(id)
      const more = make(Date.now())
      played.set(id, {
        items: [...(before?.items ?? []), ...more.items],
        requests: [...(before?.requests ?? []), ...more.requests],
      })
      tell(id)
    }
  return {
    wrap: (conversations) => ({
      ...conversations,
      conversation: (key) => {
        const id = terminalKeyId(key)
        const known = views.get(id)
        if (known) return known
        const base = conversations.conversation(key)
        let last: { base: Conversation; played: Played; out: Conversation } | undefined
        const view: Store<Conversation> = {
          getSnapshot: () => {
            const snapshot = base.getSnapshot()
            const added = played.get(id)
            if (!added) return snapshot
            if (last?.base === snapshot && last.played === added) return last.out
            const out = {
              ...snapshot,
              items: [...snapshot.items, ...added.items],
              requests: [...snapshot.requests, ...added.requests],
            }
            last = { base: snapshot, played: added, out }
            return out
          },
          subscribe: (listener) => {
            const set = listeners.get(id) ?? new Set()
            set.add(listener)
            listeners.set(id, set)
            const stop = base.subscribe(listener)
            return () => {
              set.delete(listener)
              stop()
            }
          },
        }
        views.set(id, view)
        return view
      },
    }),
    actions: [
      {
        label: "Dialog from a newer Novadeck",
        hint: "Selected agent's chat: a request card saying to update Novadeck to answer it here, or answer it in the terminal, with no answer buttons",
        run: play((at) => ({ items: [], requests: [newerRequest(at)] })),
      },
      {
        label: "Part of the record from a newer Novadeck",
        hint: "Selected agent's chat: a quiet row saying part of the conversation needs a newer Novadeck, its text unfolding under it",
        run: play((at) => ({ items: [newerItem(at)], requests: [] })),
      },
      {
        label: "Back to normal",
        hint: "What the actions above added goes from the selected agent's chat",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          played.delete(terminalKeyId(key))
          tell(terminalKeyId(key))
        },
      },
    ],
  }
}

// The dev server's pane items of what a newer Novadeck shows, on the selected terminal's bar as
// an agent's `show` would put them: only in the showcase.
export const newerItemGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] => {
  if (!companions || !isShowcase(companions)) return []
  const show =
    (sample: typeof newerSamples.kind): DemoAction["run"] =>
    ({ selected, workspace, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      companions.present(key, terminalOf(workspace(), key)?.handle ?? "", sample)
    }
  return [
    {
      section: "Agents",
      title: "Items from a newer Novadeck",
      actions: [
        {
          label: "Show an item of a newer kind",
          hint: "A Timeline tab joins the bar and its pane says Timeline needs a newer Novadeck to show",
          run: show(newerSamples.kind),
        },
        {
          label: "Show a file of a newer kind of content",
          hint: "The pane says scene.usdz needs a newer Novadeck to show",
          run: show(newerSamples.content),
        },
      ],
    },
  ]
}
