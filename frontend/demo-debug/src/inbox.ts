import type { InboxItem } from "@novadeck/core/inbox"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import type { DemoInbox } from "@novadeck/demo/inbox"
import { demoHiddenCommand, demoInboxIds, demoInboxItemsAll } from "@novadeck/demo/inbox-fixtures"

import type { DemoActionGroup } from "./types"

type Named = keyof typeof demoInboxIds

// The one-of-each actions: label, the fixture it adds, and what appears.
const kinds: readonly { readonly label: string; readonly name: Named; readonly hint: string }[] = [
  {
    label: "Stuck agent",
    name: "stuck",
    hint: "Trouble row for api-service Claude Code, with its evidence and a Nudge",
  },
  {
    label: "Codex command permission",
    name: "codexPermission",
    hint: "Approve row with Codex's four options, one taking words",
  },
  {
    label: "Unreadable dialog",
    name: "rawDialog",
    hint: "Approve row showing Claude's edit diff, to answer in the terminal",
  },
  {
    label: "Held message",
    name: "held",
    hint: "Approve row with Release and Stop for a message between two agents",
  },
  {
    label: "Decision with options",
    name: "webhook",
    hint: "Ask row with three options, a pick marked, and a hard-to-undo note",
  },
  {
    label: "Detected question",
    name: "question",
    hint: "Ask row with Claude's question and its (Recommended) option",
  },
  {
    label: "Several questions",
    name: "questions",
    hint: "Ask row with three of Claude's questions in one card, one taking several picks: Send waits for all",
  },
  {
    label: "Ask while working",
    name: "preview",
    hint: "Ask row with a free-text answer while the agent keeps working",
  },
  {
    label: "Login request",
    name: "login",
    hint: "Ask row with the vercel login command and an I've logged in button",
  },
  {
    label: "Usage limit",
    name: "limit",
    hint: "Trouble row for the 5-hour limit, resuming by itself",
  },
  {
    label: "Heads-up",
    name: "told",
    hint: "Update row for something an agent told you",
  },
  {
    label: "Plan approval",
    name: "plan",
    hint: "Approve row with Claude's plan: the plain yes leads, bypass permissions is a quiet link",
  },
  {
    label: "Failed turn",
    name: "failed",
    hint: "Trouble row with the error an agent's turn ended on and Ask it to fix",
  },
  {
    label: "Free-text ask",
    name: "text",
    hint: "Ask row with no options, answered in words from the reply box",
  },
  {
    label: "Permission with a plain Deny",
    name: "plainDeny",
    hint: "Approve row whose Deny answers at once, with no note to write",
  },
  {
    label: "Usage limit, no auto-resume",
    name: "limitManual",
    hint: "Trouble row for a usage limit of unknown length, with no switch: it stays stopped until reset and Continue",
  },
  {
    label: "Request with no dialog",
    name: "noDialog",
    hint: "Approve row for a permission whose dialog never read: it can't be answered here, only in the terminal",
  },
  {
    label: "Failed turn, no error",
    name: "failedNoError",
    hint: "Trouble row for a turn that ended on an error its harness gave no words for",
  },
  {
    label: "Held message, sender gone",
    name: "heldSenderGone",
    hint: "Approve row for a held message whose sender's terminal closed: it shows on the recipient, the sender by its handle",
  },
  {
    label: "Messages held long",
    name: "waits",
    hint: "Trouble row saying two messages for the agent have waited long behind a dialog open in its idle terminal",
  },
  {
    label: "Finished turn",
    name: "finished",
    hint: "Update row with the reply and the files an agent wrote",
  },
]

// A fixture as a fresh item, waiting from now.
const fresh = (id: string): InboxItem | undefined => {
  const now = Date.now()
  const found = demoInboxItemsAll(now).find((each) => each.id === id)
  return found && { ...found, at: now }
}

// Whether the demo's workspace has the sample projects the Inbox's items are about: the
// content showcase has its own.
const samplesIn = (seed: WorkspaceSeed): boolean =>
  demoInboxItemsAll(0).every((item) =>
    seed.projects.some((project) => project.id === item.source.projectId),
  )

// The Inbox's actions, for the demo's Inbox over the sample projects. Each adds a fresh item,
// waiting from now, in place of the one of its kind that was there.
export const inboxGroups = (
  inbox: DemoInbox | undefined,
  seed: WorkspaceSeed,
): readonly DemoActionGroup[] => {
  if (!inbox || !samplesIn(seed)) return []
  const present = (): ReadonlySet<string> =>
    new Set(inbox.state.getSnapshot().items.map((each) => each.id))
  return [
    {
      section: "App",
      title: "Inbox",
      actions: [
        ...kinds.map(({ label, name, hint }) => ({
          label,
          hint,
          run: () => {
            const item = fresh(demoInboxIds[name])
            if (item) inbox.add(item)
          },
        })),
        {
          label: "Command hiding lines",
          hint: "Approve row whose command buries a line under blank lines and spaces: the card counts its lines and marks them",
          run: () => {
            const item = fresh(demoInboxIds.plainDeny)
            if (item?.kind !== "request" || item.request.dialog?.type !== "choices") return
            inbox.add({
              ...item,
              request: {
                ...item.request,
                subject: "gh auth status",
                dialog: {
                  ...item.request.dialog,
                  detail: demoHiddenCommand,
                },
              },
            })
          },
        },
        {
          label: "Plan with a change field",
          hint: "Approve row with Claude Code 2.1.287's plan: Deny opens a note that must say what to change",
          run: () => {
            const item = fresh(demoInboxIds.plan)
            if (item?.kind !== "request" || item.request.dialog?.type !== "choices") return
            inbox.add({
              ...item,
              request: {
                ...item.request,
                dialog: {
                  ...item.request.dialog,
                  options: [
                    { id: "1", label: "Yes, auto-accept edits", text: null },
                    { id: "2", label: "Yes, manually approve edits", text: null },
                    { id: "3", label: "Tell Claude what to change", text: "field" },
                  ],
                },
              },
            })
          },
        },
        {
          label: "Usage limit, reset passed",
          hint: "Trouble row for a 5-hour limit that has reset and Novadeck can't resume, offering Continue now",
          run: () => {
            const item = fresh(demoInboxIds.limit)
            if (item?.kind !== "trouble" || item.trouble.type !== "limit") return
            inbox.add({
              ...item,
              stopped: true,
              trouble: { ...item.trouble, autoResume: null, resetsAt: Date.now() - 60_000 },
            })
          },
        },
        {
          label: "Fail the next answer",
          hint: "The next answer to any item fails and the sheet says so, leaving the item to answer again",
          run: () => inbox.failNext(),
        },
        {
          label: "Stale next answer",
          hint: "The next answer fails because its ask is no longer available, keeping the reply draft",
          run: () => inbox.failNext("That ask is no longer available."),
        },
        ...(["withdrawn", "gone"] as const).map((outcome) => ({
          label: outcome === "withdrawn" ? "Ask withdrawn" : "Ask session ended",
          hint:
            outcome === "withdrawn"
              ? "Removes the sample preview ask; its Messages record says Withdrawn"
              : "Removes the sample preview ask; its Messages record says Agent session ended",
          run: () => {
            const item = fresh(demoInboxIds.preview)
            if (!item) return
            inbox.add(item)
            inbox.resolve(item.id, outcome)
          },
        })),
        {
          label: "Next reply not delivered",
          hint: "The next ask reply queues, then fails delivery; its Inbox confirmation and Messages history say it did not arrive",
          run: () => inbox.dropReplyNext(),
        },
        {
          label: "A new item arrives",
          hint: "The next of the kinds above not in the Inbox joins it, waiting from now",
          run: ({ note }) => {
            const there = present()
            const next = kinds.find(({ name }) => !there.has(demoInboxIds[name]))
            const item = next && fresh(demoInboxIds[next.name])
            if (!item) return note("Every kind is in the Inbox already.")
            inbox.add(item)
          },
        },
        {
          label: "Clear the added items",
          hint: "The hardcoded items and those added here go; what the agents wait on stays",
          run: () => inbox.clear(),
        },
      ],
    },
  ]
}
