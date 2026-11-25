import type { Backend, TerminalKey } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"
import { isDemoWorks, worktreeRoot, type DemoWorks, type Placed } from "@novadeck/demo/works"
import { sessionOf, terminalOf } from "@novadeck/demo/workspace"

import { othersOf } from "./terminals"
import type { DemoActionGroup } from "./types"

// Where a terminal's worktree is made if it has none: its project, its id, and a worktree of
// the project named after the terminal.
export const placed = (workspace: Workspace | undefined, key: TerminalKey): Placed => ({
  projectId: key.projectId,
  terminalId: key.terminalId,
  root: worktreeRoot(key.projectId, terminalOf(workspace, key)?.name ?? key.terminalId),
})

// The terminals of the key's session other than it, those with a work in this project first,
// so a conflict between works lands on a row already in the list.
const partners = (
  works: DemoWorks,
  workspace: Workspace | undefined,
  key: TerminalKey,
): Placed[] => {
  const have = new Set(works.worksOf(key.projectId).map((work) => work.terminalId))
  const others = othersOf(workspace, key).map((terminal) =>
    placed(workspace, { ...key, terminalId: terminal.id }),
  )
  return [
    ...others.filter((each) => have.has(each.terminalId)),
    ...others.filter((each) => !have.has(each.terminalId)),
  ]
}

// The panel's group for the Worktrees panel's states, on the selected terminal's first worktree: a
// terminal without one gets a worktree at its first change, so each action works on a
// terminal without one too.
// The Worktrees panel shows only with agent worktrees on: "On, with Worktrees" in the App section's
// Agent worktrees group boots with it.
export const worksGroups = (works: Backend["works"]): readonly DemoActionGroup[] =>
  isDemoWorks(works)
    ? [
        {
          section: "Terminals",
          title: "Worktrees",
          actions: [
            {
              label: "New lines on its work",
              hint: "Open Worktrees: the selected terminal's row (made now if it had no worktree) has unread lines, so its branch brightens after main ‹",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.gain(placed(workspace(), key))
              },
            },
            {
              label: "Many files changed",
              hint: "Open Worktrees: the selected terminal's row (made now if it had no worktree) changes 9 more files; click it: its changes open on its owner's bar, listing them",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.spread(placed(workspace(), key), 9)
              },
            },
            {
              label: "Conflict with main",
              hint: "Open Worktrees: the selected terminal's row gets a bold amber ! after its branch; hover the ! for Conflicts with main",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.conflictWithMain(placed(workspace(), key))
              },
            },
            {
              label: "Conflict with another work",
              hint: "Open Worktrees: the selected row and another terminal of the session (one with a worktree first) both get a !, whose tooltip names the other's title",
              run: ({ selected, workspace, note }) => {
                const key = selected()
                if (!key) return note("Select a terminal first.")
                const [other] = partners(works, workspace(), key)
                if (!other) return note("The session needs a second terminal.")
                works.conflictBetween(placed(workspace(), key), other)
              },
            },
            {
              label: "No conflicts",
              hint: "Open Worktrees: the selected row's ! is gone",
              run: ({ selected }) => {
                const key = selected()
                const own = key && works.ownedBy(key.terminalId)
                if (own) works.settle(own.root)
              },
            },
            {
              label: "Work merged",
              hint: "Open Worktrees: the selected terminal's row stays with a bold green ✓ (landed in main); nothing in it lives only here, so its trash is full strength and the header's Trash N counts it",
              run: ({ selected }) => {
                const key = selected()
                const own = key && works.ownedBy(key.terminalId)
                if (own) works.merge(own.root)
              },
            },
            {
              label: "Worktree just made",
              hint: "Open Worktrees: the selected terminal's row has a muted · (nothing in it yet); hover it and click its trash: it closes with no question",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.openClean(placed(workspace(), key))
              },
            },
            {
              label: "New worktree",
              hint: "Close Worktrees if it is open: the Worktrees toggle in the rail flares a dot with a ring for a moment (again for each click), and Worktrees lists another clean worktree of the selected terminal",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.makeAnother(placed(workspace(), key))
              },
            },
            {
              label: "Worktree with changes",
              hint: "Open Worktrees: the selected terminal's row has files; hover its trash for what it holds, and click it: a dialog says it holds changed files, committed work stays on the branch, uncommitted work (and commits only a detached HEAD reaches) is kept on a ref, and ignored files are not",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                const own = works.ownedBy(key.terminalId)
                if (!own || own.files.length === 0) works.gain(placed(workspace(), key), 30)
              },
            },
            {
              label: "Commits main lacks",
              hint: "Open Worktrees: the selected terminal's worktree has no changed files but two commits main lacks (as a squash-merged one has, or a commit and its revert), and does not read as merged; click its trash button: the dialog says it holds 2 commits the main branch doesn't have, and closing needs your Close worktree",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.commitsMainLacks(placed(workspace(), key), 2)
              },
            },
            {
              label: "Commits not pushed",
              hint: "Open Worktrees: the selected terminal's row (made now if it had no worktree) holds 2 commits no remote holds; its trash tooltip says so, and if its pull request is closed it gets a ! (left here)",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.setUnpushed(placed(workspace(), key), 2)
              },
            },
            {
              label: "Uncommitted files",
              hint: "Open Worktrees: the selected terminal's row (made now if it had no worktree) holds 3 uncommitted files, so its trash is dim and asks first; merged, it gets a ! saying they're left here",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.setUncommitted(placed(workspace(), key), 3)
              },
            },
            {
              label: "Work with a home",
              hint: 'Open Worktrees: the selected terminal\'s row (made now if it had no worktree) reads "JIRA-123 ‹ its branch": its work goes to JIRA-123. Run again to take it away',
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                const at = placed(workspace(), key)
                works.setHome(at, works.ownedBy(key.terminalId)?.home ? undefined : "JIRA-123")
              },
            },
            {
              label: "Heads to another worktree",
              hint: "Open Worktrees: the selected terminal's worktree (made now if it had none) heads to another worktree's branch, so it hangs under that one on the team wire at the rail's border, lit while either is selected; point beside the lead, or use the lead's menu (right-click), to fold its team into its row. Run again to send it back to main",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                const at = placed(workspace(), key)
                const own = works.ownedBy(key.terminalId)
                const project = works.worksOf(key.projectId)
                // Back to main where it heads to another worktree already; else to one that
                // doesn't head to it, so the two don't go round.
                if (own?.home !== undefined && project.some((work) => work.branch === own.home)) {
                  works.setHome(at, undefined)
                  return
                }
                const other = project.find(
                  (work) =>
                    work.root !== own?.root &&
                    work.branch !== null &&
                    (own?.branch == null || work.home !== own.branch),
                )
                if (other) works.setHome(at, other.branch!)
              },
            },
            {
              label: "Untitled worktree",
              hint: 'Open Worktrees: the selected terminal\'s row (made now if it had no worktree) is named by its branch, in mono, as one made by hand or before titles. Run again to title it "Checkout rounding fix"',
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                const own = works.ownedBy(key.terminalId)
                works.setTitle(
                  placed(workspace(), key),
                  own && own.title === undefined ? "Checkout rounding fix" : undefined,
                )
              },
            },
            {
              label: "Untouched a day",
              hint: "Open Worktrees: the selected terminal's row (made now if it had no worktree) last changed 26 h ago: its glyph is a muted z and its name dims",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.changedAgo(placed(workspace(), key), 26 * 60)
              },
            },
            {
              label: "Origin fetch failing",
              hint: "The footer: the selected terminal's project has failed to fetch its origin for 2 h, so within 20 s its middle shows Can't fetch, git's reason in its tooltip; a click fetches and clears it",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                // Named as the runner names it: by its folder.
                const folder = workspace()?.projects.find((each) => each.id === key.projectId)
                const repository = folder?.directory.split(/[\\/]/).findLast(Boolean) ?? "project"
                works.failOrigin(
                  key.projectId,
                  repository,
                  120,
                  "Could not resolve host: github.com",
                )
              },
            },
            {
              label: "Owner in History",
              hint: "Open Worktrees: the selected terminal's row keeps its owner's handle (its terminal is in History); click it: its changes open on the selected terminal's bar instead",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                works.gain(placed(workspace(), key))
                const own = works.ownedBy(key.terminalId)
                if (own) works.ownerClosed(own.root)
              },
            },
            {
              label: "No owner",
              hint: "Open Worktrees: the selected terminal's row ends in no agent, with a ! where work lives only in it; click it to show it on the selected terminal's bar",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                works.gain(placed(workspace(), key))
                const own = works.ownedBy(key.terminalId)
                if (own) works.orphan(own.root)
              },
            },
            {
              label: "Owner working in it",
              hint: "Open Worktrees: the selected terminal's row spins ⠹ (files changing) and its trash is dimmer; hover the trash for why (its agent is working in this worktree)",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                works.gain(placed(workspace(), key))
                works.setWorking(key.terminalId, true)
              },
            },
            {
              label: "Owner done",
              hint: "Open Worktrees: the selected terminal's row stops spinning and its trash is available again",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.setWorking(key.terminalId, false)
              },
            },
            {
              label: "Worktrees not read yet",
              hint: "Open Worktrees: for 3 s it lists nothing and shows no count, not even No worktrees, as before the runner first reports the worktrees; then the rows come back",
              run: () => works.unreported(3_000),
            },
            {
              label: "Refuse the next close",
              hint: "Open Worktrees: the next trash button click anywhere leaves its row and shows a message above the list that git status couldn't be read",
              run: () => works.refuseNextClose(),
            },
            {
              label: "Close every worktree",
              hint: "Open Worktrees: the project's rows go and the list is empty, saying when an agent opens a worktree in this project it shows up here; other projects keep theirs",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.removeAll(key.projectId)
              },
            },
            {
              label: "Every row state in Worktrees",
              hint: "Open Worktrees: the project's rows become one in each state, newest first: ⣤ checks running into prod, ⠹ changing, a draft's bar, ? checks passed and approved, pi harness leading a team on the rail's wire (! conflict, · empty, and a nested member), ✗ checks failed, a bar of 25 checks, a quiet row, ✓ landed (safe), ✓ with files left (!), × closed and hatched, z an untitled branch with no agent (!), ○ unreadable",
              run: ({ selected, workspace }) => {
                const key = selected()
                const session = key && sessionOf(workspace(), key)
                if (!key || !session) return
                works.gallery(
                  key.projectId,
                  session.state.roster.terminals.map((terminal) => terminal.id),
                )
              },
            },
            {
              label: "Every state in Worktrees",
              hint: "Open Worktrees: the session's first four terminals get a worktree each, one with many files, one small, one in conflict with main and one with the first",
              run: ({ selected, workspace }) => {
                const key = selected()
                const session = key && sessionOf(workspace(), key)
                if (!key || !session) return
                const [many, small, main, between] = session.state.roster.terminals
                  .slice(0, 4)
                  .map((terminal) => placed(workspace(), { ...key, terminalId: terminal.id }))
                if (many) {
                  works.gain(many, 40)
                  works.spread(many, 8)
                }
                if (small) works.gain(small, 12)
                if (main) works.conflictWithMain(main)
                if (many && between) works.conflictBetween(between, many)
              },
            },
          ],
        },
        {
          section: "Agents",
          title: "File preview",
          actions: [
            {
              label: "Third agent clashes with the others",
              hint: "Open Files and click src/checkout/Checkout.tsx (storefront, agents demo): the preview's Clash head at submit() shows owl's version, the last writer, with moth and crow hidden, and a picker of each agent and main; owl joins the merge toggles",
              run: () => works.previewOwl("clash"),
            },
            {
              label: "A change doesn't apply",
              hint: "Open the file preview of src/checkout/Checkout.tsx: a red box says owl changed line 25 before main rewrote it, so it doesn't apply, with Show for its version above main's line 25; the summary counts 1 change that doesn't apply",
              run: () => works.previewOwl("stale"),
            },
            {
              label: "Crow adds OrderSummary.tsx too",
              hint: "Open Files and click src/checkout/OrderSummary.tsx (storefront, agents demo; main lacks it): the preview draws the whole file as added lines under moth's head, then, as crow joins, a whole-file Clash head with crow's version shown (the last writer) and a picker",
              run: () => works.previewScenario("added", true),
            },
            {
              label: "Crow renames PaymentStep.tsx, moth edits it",
              hint: "Open the file preview of src/checkout/PaymentStep.tsx: a note at the top says crow renames this file to src/checkout/PaymentForm.tsx, with Open, above moth's change; Open shows PaymentForm.tsx as main's PaymentStep with crow's head reading renamed from PaymentStep.tsx and moth's change carried onto it",
              run: () => works.previewScenario("rename", true),
            },
            {
              label: "Crow's add and rename end",
              hint: "Open the previews of OrderSummary.tsx and PaymentStep.tsx: crow's version, its Clash head and its rename note are gone",
              run: () => {
                works.previewScenario("added", false)
                works.previewScenario("rename", false)
              },
            },
            {
              label: "Third agent leaves the file preview",
              hint: "Open the file preview of src/checkout/Checkout.tsx: owl's change, clash or box, is gone, and its toggle with it",
              run: () => works.previewOwl(undefined),
            },
          ],
        },
      ]
    : []
