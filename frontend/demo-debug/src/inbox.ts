import { noAutoRun } from "@novadeck/core/autorun"
import type { InboxRow } from "@novadeck/core/inbox"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import type { DemoInbox } from "@novadeck/demo/inbox"
import {
  demoAutoRunManual,
  demoAutoRunOffer,
  demoAutoRunSilenced,
  demoEndingGrant,
  demoHiddenCommand,
  demoInboxIds,
  demoInboxRowsAll,
  demoLiveGrant,
  demoLongCommand,
  demoPlanStates,
} from "@novadeck/demo/inbox/fixtures"

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
    hint: "Unblock row with Codex's four options, one taking words",
  },
  {
    label: "Unreadable dialog",
    name: "rawDialog",
    hint: "Unblock row showing Claude's edit diff, to answer in the terminal",
  },
  {
    label: "Held message",
    name: "held",
    hint: "Unblock row with Release and Stop for a message between two agents",
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
    hint: "Unblock row with the vercel login command and an I've logged in button",
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
    hint: "Unblock row with Claude's plan, its long Markdown in the sheet: the plain yes leads, bypass permissions is a quiet link",
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
    hint: "Unblock row whose Deny answers at once, with no note to write",
  },
  {
    label: "Usage limit, no auto-resume",
    name: "limitManual",
    hint: "Trouble row for a usage limit of unknown length, with no switch: it stays stopped until reset and Continue",
  },
  {
    label: "Request with no dialog",
    name: "noDialog",
    hint: "Unblock row for a permission whose dialog never read: it can't be answered here, only in the terminal",
  },
  {
    label: "Failed turn, no error",
    name: "failedNoError",
    hint: "Trouble row for a turn that ended on an error its harness gave no words for",
  },
  {
    label: "Held message, sender gone",
    name: "heldSenderGone",
    hint: "Unblock row for a held message whose sender's terminal closed: it shows on the recipient, the sender by its handle",
  },
  {
    label: "Messages held long",
    name: "waits",
    hint: "Trouble row saying two messages for the agent have waited long behind a dialog open in its idle terminal",
  },
  {
    label: "Grant card",
    name: "grant",
    hint: "Unblock row for mobile-app's lead: the Grant card with push and pull requests, three repos (one flagged an added remote, one recent), two commands (one followed by anything), its team now and later (@fox on Codex noted), 8 h, and the lead's reason quoted; Grant makes the live grant, Decline dismisses it",
  },
  {
    label: "Approval card",
    name: "approval",
    hint: 'Unblock row for design-system\'s first terminal: "Lets @moth run, without asking again, for 1 hour:" with three commands as code (one followed by anything); Approve makes a grant for that terminal, or reply in words',
  },
  {
    label: "Done report",
    name: "done",
    hint: "Update row with an agent's done report: its subject and a Markdown body",
  },
]

// A fixture as a fresh row, waiting from now.
const fresh = (id: string): InboxRow | undefined => {
  const now = Date.now()
  const found = demoInboxRowsAll(now).find((each) => each.id === id)
  return found && { ...found, at: now }
}

// The asks "Several asks at once" adds together: four needs-you rows from four terminals
// in four projects, enough for a toast stack to fill and spill into its "+N more" pill.
const together: readonly Named[] = ["webhook", "codexPermission", "login", "questions"]

// Whether the demo's workspace has the sample projects the Inbox's rows are about: the
// content showcase has its own.
const samplesIn = (seed: WorkspaceSeed): boolean =>
  demoInboxRowsAll(0).every((row) =>
    seed.projects.some((project) => project.id === row.source.projectId),
  )

// The Inbox's actions, for the demo's Inbox over the sample projects. Each adds a fresh row,
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
            const row = fresh(demoInboxIds[name])
            if (row) inbox.add(row)
          },
        })),
        {
          label: "Live grant",
          hint: "The Grants section tops the Inbox with a team grant of mobile-app's lead: holder, push and pull requests, two repos, 8 h less 25 min left, its last allowed command, and Revoke",
          run: () => inbox.grants.add(demoLiveGrant(Date.now())),
        },
        {
          label: "Grant ends",
          hint: "A terminal grant for design-system's first terminal joins the Grants section and ends by its time after 4 seconds: it leaves the list with no Revoke",
          run: () => inbox.grants.add(demoEndingGrant(Date.now(), 4000)),
        },
        {
          label: "Revoke a grant",
          hint: "Revokes the newest live grant as its Revoke does: it leaves the Grants section, and the section with it when it was the last",
          run: ({ note }) => {
            const newest = inbox.grants.state.getSnapshot().at(-1)
            if (!newest) return note("No grant is live. Add one with Live grant or the cards.")
            inbox.grants.revoke(newest.id)
          },
        },
        {
          label: "AutoRun offer",
          hint: "The Inbox shows cmd's AutoRun card: why cmd printing matters, the current value and the exact new one, that it applies to every cmd window, Silence cmd's AutoRun output and Not now",
          run: () => inbox.autorun.show(demoAutoRunOffer),
        },
        {
          label: "AutoRun manual step",
          hint: "The AutoRun card gives the step in words, as the printing value is the machine's (HKLM): regedit as an administrator, from the value to a silenced one, with no buttons but Not now",
          run: () => inbox.autorun.show(demoAutoRunManual),
        },
        {
          label: "AutoRun silenced",
          hint: "The AutoRun card says it was silenced and cmd prints nothing now, with Undo showing the exact value it restores, and Preferences lists the same row under Agents",
          run: () => inbox.autorun.show(demoAutoRunSilenced),
        },
        {
          label: "AutoRun gone",
          hint: "cmd prints nothing here: the AutoRun card leaves the Inbox",
          run: () => inbox.autorun.show(noAutoRun),
        },
        {
          label: "Clear grants",
          hint: "Every grant leaves the Grants section",
          run: () => inbox.grants.empty(),
        },
        {
          label: "Command hiding lines",
          hint: "Unblock row whose command buries a line under blank lines and spaces: the card counts its lines and marks them",
          run: () => {
            const row = fresh(demoInboxIds.plainDeny)
            if (row?.kind !== "request" || row.request.dialog?.type !== "choices") return
            inbox.add({
              ...row,
              request: {
                ...row.request,
                subject: "gh auth status",
                dialog: {
                  ...row.request.dialog,
                  detail: demoHiddenCommand,
                },
              },
            })
          },
        },
        {
          label: "Long command",
          hint: "Unblock row whose command is a 12-line script: the sheet shows every line, scrolling in its box, and counts them",
          run: () => {
            const row = fresh(demoInboxIds.plainDeny)
            if (row?.kind !== "request" || row.request.dialog?.type !== "choices") return
            inbox.add({
              ...row,
              request: {
                ...row.request,
                subject: "for pkg in core ui toolkit …",
                dialog: { ...row.request.dialog, detail: demoLongCommand },
              },
            })
          },
        },
        {
          label: "Pick several, with your own words",
          hint: "Ask row with Claude's question that takes several picks and the person's words: numbers and Space tick, the last row opens a box, Enter sends the picks and the words together",
          run: () => {
            const row = fresh(demoInboxIds.questions)
            if (row?.kind !== "request" || row.request.dialog?.type !== "questions") return
            const several = row.request.dialog.questions.find((each) => each.multiSelect)
            if (!several) return
            inbox.add({
              ...row,
              request: {
                ...row.request,
                subject: several.question,
                dialog: { ...row.request.dialog, questions: [{ ...several, text: true }] },
              },
            })
          },
        },
        {
          label: "Plan with a change field",
          hint: "Unblock row with Claude Code 2.1.287's plan: no plain way back, so Send it back, with your words needs words that say what to change",
          run: () => {
            const row = fresh(demoInboxIds.plan)
            if (row?.kind !== "request" || row.request.dialog?.type !== "choices") return
            inbox.add({
              ...row,
              request: {
                ...row.request,
                dialog: {
                  ...row.request.dialog,
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
        ...(["loading", "missing"] as const).map((state) => ({
          label: state === "loading" ? "Plan still loading" : "Plan not found",
          hint:
            state === "loading"
              ? "Unblock row with Claude's plan whose box stays on Loading: the plan's content never comes"
              : "Unblock row with Claude's plan that was never shown: its box loads for five seconds, then the dialog's own words stand in",
          run: () => {
            const row = fresh(demoInboxIds.plan)
            if (row) inbox.add({ ...row, id: demoPlanStates[state] })
          },
        })),
        {
          label: "Usage limit, reset passed",
          hint: "Trouble row for a 5-hour limit that has reset and Novadeck can't resume, offering Continue now",
          run: () => {
            const row = fresh(demoInboxIds.limit)
            if (row?.kind !== "trouble" || row.trouble.type !== "limit") return
            inbox.add({
              ...row,
              stopped: true,
              trouble: { ...row.trouble, autoResume: null, resetsAt: Date.now() - 60_000 },
            })
          },
        },
        {
          label: "Fail the next answer",
          hint: "The next answer to any row fails and the sheet says so, leaving the row to answer again",
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
              ? "Leaves the sample preview ask as a settled row, withdrawn; its Messages record says Withdrawn. With its sheet open, the sheet stays and says it was withdrawn"
              : "Removes the sample preview ask; its Messages record says Agent session ended",
          run: () => {
            const row = fresh(demoInboxIds.preview)
            if (!row) return
            inbox.add(row)
            inbox.resolve(row.id, outcome)
          },
        })),
        {
          label: "Ask replied in terminal",
          hint: "Leaves the sample preview ask as a settled row, replied: the person wrote to its agent",
          run: () => {
            const row = fresh(demoInboxIds.preview)
            if (!row) return
            inbox.add(row)
            inbox.withdrawAsks(row.source, row.at + 1)
          },
        },
        {
          label: "Next reply not delivered",
          hint: "The next ask reply queues, then fails delivery; its Inbox confirmation and Messages history say it did not arrive",
          run: () => inbox.dropReplyNext(),
        },
        {
          label: "Several asks at once",
          hint: "Four asks join together, from four projects: after a moment three toasts stack over the header's right end with a +1 more pill behind (it needs the page focused and the Inbox panel closed, and the selected terminal's row doesn't toast: with storefront's terminal 4 selected, three toasts and no pill)",
          run: () => {
            for (const name of together) {
              const row = fresh(demoInboxIds[name])
              if (row) inbox.add(row)
            }
          },
        },
        {
          label: "A new row arrives",
          hint: "The next of the kinds above not in the Inbox joins it, waiting from now",
          run: ({ note }) => {
            const there = present()
            const next = kinds.find(({ name }) => !there.has(demoInboxIds[name]))
            const row = next && fresh(demoInboxIds[next.name])
            if (!row) return note("Every kind is in the Inbox already.")
            inbox.add(row)
          },
        },
        {
          label: "Clear the added rows",
          hint: "The hardcoded rows and those added here go; what the agents wait on stays",
          run: () => inbox.empty(),
        },
      ],
    },
  ]
}
