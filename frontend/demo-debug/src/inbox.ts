import type { InboxEntry } from "@novadeck/core/inbox"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import type { DemoInbox } from "@novadeck/demo/inbox"
import {
  demoHiddenCommand,
  demoInboxIds,
  demoInboxEntriesAll,
  demoLongCommand,
  demoPlanStates,
} from "@novadeck/demo/inbox/fixtures"
import { demoResolved, demoResolvedEntries } from "@novadeck/demo/inbox/resolved"

import type { DemoActionGroup } from "./types"

type Named = keyof typeof demoInboxIds

// The one-of-each actions: label, the fixture it adds, and what appears.
const kinds: readonly { readonly label: string; readonly name: Named; readonly hint: string }[] = [
  {
    label: "Stuck agent",
    name: "stuck",
    hint: "Trouble entry for api-service Claude Code, with its evidence and a Nudge",
  },
  {
    label: "Codex command permission",
    name: "codexPermission",
    hint: "Unblock entry with Codex's four options, one taking words",
  },
  {
    label: "Unreadable dialog",
    name: "rawDialog",
    hint: "Unblock entry showing Claude's edit diff, to answer in the terminal",
  },
  {
    label: "Held message",
    name: "held",
    hint: "Unblock entry with Release and Stop for a message between two agents",
  },
  {
    label: "Decision with options",
    name: "webhook",
    hint: "Ask entry with three options, a pick marked, and a hard-to-undo note",
  },
  {
    label: "Detected question",
    name: "question",
    hint: "Ask entry with Claude's question and its (Recommended) option",
  },
  {
    label: "Several questions",
    name: "questions",
    hint: "Ask entry with three of Claude's questions in one card, one taking several picks: Send waits for all",
  },
  {
    label: "Ask while working",
    name: "preview",
    hint: "Ask entry with a free-text answer while the agent keeps working",
  },
  {
    label: "Login request",
    name: "login",
    hint: "Unblock entry with the vercel login command and an I've logged in button",
  },
  {
    label: "Usage limit",
    name: "limit",
    hint: "Trouble entry for the 5-hour limit, resuming by itself",
  },
  {
    label: "Heads-up",
    name: "told",
    hint: "Update entry for something an agent told you",
  },
  {
    label: "Plan approval",
    name: "plan",
    hint: "Unblock entry with Claude's plan, its long Markdown in the sheet: the plain yes leads, bypass permissions is a quiet link",
  },
  {
    label: "Failed turn",
    name: "failed",
    hint: "Trouble entry with the error an agent's turn ended on and Ask it to fix",
  },
  {
    label: "Free-text ask",
    name: "text",
    hint: "Ask entry with no options, answered in words from the reply box",
  },
  {
    label: "Permission with a plain Deny",
    name: "plainDeny",
    hint: "Unblock entry whose Deny answers at once, with no note to write",
  },
  {
    label: "Usage limit, no auto-resume",
    name: "limitManual",
    hint: "Trouble entry for a usage limit of unknown length, with no switch: it stays stopped until reset and Continue",
  },
  {
    label: "Request with no dialog",
    name: "noDialog",
    hint: "Unblock entry for a permission whose dialog never read: it can't be answered here, only in the terminal",
  },
  {
    label: "Failed turn, no error",
    name: "failedNoError",
    hint: "Trouble entry for a turn that ended on an error its harness gave no words for",
  },
  {
    label: "Held message, sender gone",
    name: "heldSenderGone",
    hint: "Unblock entry for a held message whose sender's terminal closed: it shows on the recipient, the sender by its handle",
  },
  {
    label: "Messages held long",
    name: "waits",
    hint: "Trouble entry saying two messages for the agent have waited long behind a dialog open in its idle terminal",
  },
  {
    label: "Ask in a shape from a newer Novadeck",
    name: "newerAsk",
    hint: "Ask entry from an agent of a newer Novadeck: its question and words, but no answer rows",
  },
  {
    label: "Dialog from a newer Novadeck",
    name: "newerDialog",
    hint: "Unblock entry whose dialog only a newer Novadeck reads: it says to update Novadeck to answer it here, or answer it in the terminal",
  },
  {
    label: "Update from a newer Novadeck",
    name: "newerUpdate",
    hint: "Update entry of a kind this build doesn't know: said as such with its words, and never marked read from here: its agent may wait on it",
  },
  {
    label: "Done report",
    name: "done",
    hint: "Update entry with an agent's done report: its subject and a Markdown body",
  },
]

// The resolved entries the Inbox keeps as history: one action for each group, adding an entry for
// each way an entry of it ends. Each opens as a read-only card, in gray, saying how it ended.
const resolvedGroups: readonly {
  readonly label: string
  readonly hint: string
  readonly group: keyof typeof demoResolved
}[] = [
  {
    label: "Resolved dialogs",
    group: "dialogs",
    hint: "Four resolved entries for what a harness asked: a permission and a plan answered here, with the answer on the card, a question answered in the terminal, and a dialog that ended unanswered",
  },
  {
    label: "Resolved asks",
    group: "asks",
    hint: "Five resolved entries for what agents asked: answered with an option, dismissed, replied to in the terminal, a login done, and an ask whose session ended",
  },
  {
    label: "Resolved updates",
    group: "updates",
    hint: "Two resolved entries for what an agent told you and a done report, both read",
  },
  {
    label: "Resolved Novadeck entries",
    group: "novadeck",
    hint: "Six resolved entries for what Novadeck noticed: a held message released and another stopped, a usage limit and a failed turn once the agent worked again, messages delivered, and a stuck agent that moved on",
  },
]

// A fixture as a fresh entry, waiting from now.
const fresh = (id: string): InboxEntry | undefined => {
  const now = Date.now()
  const found = demoInboxEntriesAll(now).find((each) => each.id === id)
  return found && { ...found, at: now }
}

// The asks "Several asks at once" adds together: four needs-you entries from four terminals
// in four projects, enough for a toast stack to fill and spill into its "+N more" pill.
const together: readonly Named[] = ["webhook", "codexPermission", "login", "questions"]

// Whether the demo's workspace has the sample projects the Inbox's entries are about: the
// content showcase has its own.
const samplesIn = (seed: WorkspaceSeed): boolean =>
  demoInboxEntriesAll(0).every((entry) =>
    seed.projects.some((project) => project.id === entry.source.projectId),
  )

// The Inbox's actions, for the demo's Inbox over the sample projects. Each adds a fresh entry,
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
            const entry = fresh(demoInboxIds[name])
            if (entry) inbox.add(entry)
          },
        })),
        {
          label: "Command hiding lines",
          hint: "Unblock entry whose command buries a line under blank lines and spaces: the card counts its lines and marks them",
          run: () => {
            const entry = fresh(demoInboxIds.plainDeny)
            if (entry?.kind !== "request" || entry.request.dialog?.type !== "choices") return
            inbox.add({
              ...entry,
              request: {
                ...entry.request,
                subject: "gh auth status",
                dialog: {
                  ...entry.request.dialog,
                  detail: demoHiddenCommand,
                },
              },
            })
          },
        },
        {
          label: "Long command",
          hint: "Unblock entry whose command is a 12-line script: the sheet shows every line, scrolling in its box, and counts them",
          run: () => {
            const entry = fresh(demoInboxIds.plainDeny)
            if (entry?.kind !== "request" || entry.request.dialog?.type !== "choices") return
            inbox.add({
              ...entry,
              request: {
                ...entry.request,
                subject: "for pkg in core ui toolkit …",
                dialog: { ...entry.request.dialog, detail: demoLongCommand },
              },
            })
          },
        },
        {
          label: "Pick several, with your own words",
          hint: "Unblock entry with Claude's question that takes several picks and the person's words, as the chat's card asks it: numbers tick, Something else… takes words in place, Enter goes on to Submit",
          run: () => {
            const entry = fresh(demoInboxIds.questions)
            if (entry?.kind !== "request" || entry.request.dialog?.type !== "questions") return
            const several = entry.request.dialog.questions.find((each) => each.multiSelect)
            if (!several) return
            inbox.add({
              ...entry,
              request: {
                ...entry.request,
                subject: several.question,
                dialog: { ...entry.request.dialog, questions: [{ ...several, text: true }] },
              },
            })
          },
        },
        {
          label: "Plan with a change field",
          hint: "Unblock entry with Claude Code 2.1.287's plan: no plain way back, so Tell Claude what to change is a field that needs words",
          run: () => {
            const entry = fresh(demoInboxIds.plan)
            if (entry?.kind !== "request" || entry.request.dialog?.type !== "choices") return
            inbox.add({
              ...entry,
              request: {
                ...entry.request,
                dialog: {
                  ...entry.request.dialog,
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
          label: "Form from an MCP server",
          hint: "Unblock entry with the form an MCP server asks Claude Code to fill in, answered in its card as the chat's: a text, a choice, a number and a yes/no, Submit or Decline",
          run: () => {
            const entry = fresh(demoInboxIds.rawDialog)
            if (entry?.kind !== "request") return
            inbox.add({
              ...entry,
              // Claude Code is the harness whose adapter reads an MCP server's form.
              source: { ...entry.source, agent: "claude" },
              request: {
                ...entry.request,
                id: "demo-claude-form",
                kind: "question",
                tool: "mcp_deploy_configure_target",
                subject: null,
                dialog: {
                  type: "form",
                  id: "demo-claude-form:f",
                  message: "Configure the deploy target",
                  fields: [
                    {
                      id: "target",
                      label: "Target name",
                      description: "As it is named in the deploy config",
                      kind: "text",
                      choices: [],
                      required: true,
                    },
                    {
                      id: "environment",
                      label: "Environment",
                      description: null,
                      kind: "choice",
                      choices: ["staging", "production"],
                      required: true,
                    },
                    {
                      id: "replicas",
                      label: "Replicas",
                      description: null,
                      kind: "number",
                      choices: [],
                      required: false,
                    },
                    {
                      id: "dryRun",
                      label: "Dry run first",
                      description: "Shows what would change without deploying",
                      kind: "boolean",
                      choices: [],
                      required: false,
                    },
                  ],
                },
              },
            })
          },
        },
        {
          label: "Form from an MCP server, in Codex",
          hint: "Unblock entry with the form an MCP server asks Codex to fill in, which only its screen tells: its text as Codex draws it, to answer in the terminal",
          run: () => {
            const entry = fresh(demoInboxIds.rawDialog)
            if (entry?.kind !== "request") return
            inbox.add({
              ...entry,
              source: { ...entry.source, agent: "codex" },
              request: {
                ...entry.request,
                id: "demo-codex-form",
                kind: "question",
                tool: "mcp__deploy__elicitation",
                subject: "Which environment should the deploy target?",
                dialog: {
                  type: "raw",
                  reason: "unrecognized",
                  text: [
                    "• Calling deploy.configure_target",
                    "    + Show details",
                    "",
                    "  Field 1/2 (2 required unanswered)",
                    "  Which environment should the deploy target?",
                    "",
                    "  Environment",
                    "  › 1. staging",
                    "    2. production",
                    "",
                    "  enter to submit answer | ^p / ^n change field | esc to cancel",
                  ].join("\n"),
                },
              },
            })
          },
        },
        ...(["loading", "missing"] as const).map((state) => ({
          label: state === "loading" ? "Plan still loading" : "Plan not found",
          hint:
            state === "loading"
              ? "Unblock entry with Claude's plan whose box stays on Loading: the plan's content never comes"
              : "Unblock entry with Claude's plan that was never shown: its box loads for five seconds, then the dialog's own words stand in",
          run: () => {
            const entry = fresh(demoInboxIds.plan)
            if (entry) inbox.add({ ...entry, id: demoPlanStates[state] })
          },
        })),
        {
          label: "Usage limit, reset passed",
          hint: "Trouble entry for a 5-hour limit that has reset and Novadeck can't resume, offering Continue now",
          run: () => {
            const entry = fresh(demoInboxIds.limit)
            if (entry?.kind !== "trouble" || entry.trouble.type !== "limit") return
            inbox.add({
              ...entry,
              stopped: true,
              trouble: { ...entry.trouble, autoResume: null, resetsAt: Date.now() - 60_000 },
            })
          },
        },
        {
          label: "Fail the next answer",
          hint: "The next answer to any entry fails and the sheet says so, leaving the entry to answer again (an update's read on leaving the list doesn't count)",
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
              ? "Takes the sample preview ask out of the Inbox, as its agent withdrawing it does; its Messages record says Withdrawn"
              : "Leaves the sample preview ask as a resolved entry, ended: its agent session is over; its Messages record says Agent session ended. With its sheet open, the sheet stays and says so",
          run: () => {
            const entry = fresh(demoInboxIds.preview)
            if (!entry) return
            inbox.add(entry)
            inbox.resolve(entry.id, outcome)
          },
        })),
        {
          label: "Ask replied in terminal",
          hint: "Leaves the sample preview ask as a resolved entry, replied: the person wrote to its agent",
          run: () => {
            const entry = fresh(demoInboxIds.preview)
            if (!entry) return
            inbox.add(entry)
            inbox.withdrawAsks(entry.source, entry.at + 1)
          },
        },
        {
          label: "Next reply not delivered",
          hint: "The next ask reply queues, then fails delivery; its Inbox confirmation and Messages history say it did not arrive",
          run: () => inbox.dropReplyNext(),
        },
        {
          label: "Several asks at once",
          hint: "Four asks join together, from four projects: after a moment three toasts stack over the header's right end with a +1 more pill behind (it needs the page focused and the Inbox panel closed, and the selected terminal's entry doesn't toast: with storefront's terminal 4 selected, three toasts and no pill)",
          run: () => {
            for (const name of together) {
              const entry = fresh(demoInboxIds[name])
              if (entry) inbox.add(entry)
            }
          },
        },
        {
          label: "A new entry arrives",
          hint: "The next of the kinds above not in the Inbox joins it, waiting from now",
          run: ({ note }) => {
            const there = present()
            const next = kinds.find(({ name }) => !there.has(demoInboxIds[name]))
            const entry = next && fresh(demoInboxIds[next.name])
            if (!entry) return note("Every kind is in the Inbox already.")
            inbox.add(entry)
          },
        },
        ...resolvedGroups.map(({ label, hint, group }) => ({
          label,
          hint,
          run: () => {
            for (const entry of demoResolvedEntries(Date.now(), demoResolved[group]))
              inbox.add(entry)
          },
        })),
        {
          label: "Seventeen resolved entries",
          hint: "A resolved entry of every kind at once: the list holds only the ten that resolved last, open entries apart, newest first with no lines between",
          run: () => {
            const now = Date.now()
            for (const group of Object.values(demoResolved))
              for (const entry of demoResolvedEntries(now, group)) inbox.add(entry)
          },
        },
        {
          label: "Clear the added entries",
          hint: "The hardcoded entries and those added here go; what the agents wait on stays",
          run: () => inbox.empty(),
        },
      ],
    },
  ]
}
