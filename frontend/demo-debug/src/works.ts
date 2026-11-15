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

// The panel's group for the Changes panel's states, on the selected terminal's first worktree: a
// terminal without one gets a worktree at its first change, so each action works on a
// terminal without one too.
// The Changes panel shows only with agent worktrees on: "On, with Changes" in the App section's
// Agent worktrees and Changes group boots with it.
export const worksGroups = (works: Backend["works"]): readonly DemoActionGroup[] =>
  isDemoWorks(works)
    ? [
        {
          section: "Terminals",
          title: "Changes",
          actions: [
            {
              label: "New lines on its work",
              hint: "Open Changes: the selected terminal's row (made now if it had no worktree) shows 14 more lines in its +N −N, top right",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.gain(placed(workspace(), key))
              },
            },
            {
              label: "Many files changed",
              hint: "Open Changes and select the row: it lists five files and a sixth row counting the rest (+N more)",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.spread(placed(workspace(), key), 9)
              },
            },
            {
              label: "Conflict with main",
              hint: "Open Changes: the selected terminal's row icon turns red, its first file's name is red, and the row says \"Conflicts with main\" on hover",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.conflictWithMain(placed(workspace(), key))
              },
            },
            {
              label: "Conflict with another work",
              hint: 'Open Changes: the selected row and another terminal of the session (one with a worktree first) both turn red, each saying "Conflicts with" the other\'s title on hover',
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
              hint: "Open Changes: the selected row's icon and files are no longer red",
              run: ({ selected }) => {
                const key = selected()
                const own = key && works.ownedBy(key.terminalId)
                if (own) works.settle(own.root)
              },
            },
            {
              label: "Work merged",
              hint: 'Open Changes: the selected terminal\'s row stays, with a merge icon in green and "Merged" on hover, and has no files, so its × closes it at once; any conflict with it clears on the others',
              run: ({ selected }) => {
                const key = selected()
                const own = key && works.ownedBy(key.terminalId)
                if (own) works.merge(own.root)
              },
            },
            {
              label: "Worktree just made",
              hint: "Open Changes: the selected terminal's row has its branch, the plain icon and no changes (not merged); hover it and click ×: it closes with no question",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.openClean(placed(workspace(), key))
              },
            },
            {
              label: "New worktree",
              hint: "Close Changes if it is open: the Changes toggle in the rail flares a dot with a ring for a moment (again for each click), and Changes lists another clean worktree of the selected terminal",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.makeAnother(placed(workspace(), key))
              },
            },
            {
              label: "Worktree with changes",
              hint: "Open Changes: the selected terminal's row has files; click its ×: a dialog says it holds changed files, committed work stays on the branch, uncommitted work (and commits only a detached HEAD reaches) is kept on a ref and ignored files like .env are not kept",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                const own = works.ownedBy(key.terminalId)
                if (!own || own.files.length === 0) works.gain(placed(workspace(), key), 30)
              },
            },
            {
              label: "Commits main lacks",
              hint: "Open Changes: the selected terminal's worktree has no changed files but two commits main lacks (as a squash-merged one has, or a commit and its revert), so it reads as merged; click its ×: the dialog says it holds 2 commits the main branch doesn't have, and closing needs your Close worktree",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.commitsMainLacks(placed(workspace(), key), 2)
              },
            },
            {
              label: "Owner in History",
              hint: "Open Changes: the selected terminal's worktree reads Closed terminal (its owner is in History); click it: its changes open on the selected terminal's bar instead",
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
              hint: "Open Changes: the selected terminal's worktree reads No owner and keeps its branch; click it to show it on the selected terminal's bar",
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
              hint: "Open Changes: the selected terminal's row has its × dimmed; hover it for why (its agent is working in this worktree)",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (!key) return
                works.gain(placed(workspace(), key))
                works.setWorking(key.terminalId, true)
              },
            },
            {
              label: "Owner done",
              hint: "Open Changes: the selected terminal's × is available again",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.setWorking(key.terminalId, false)
              },
            },
            {
              label: "Worktrees not read yet",
              hint: "Open Changes: for 3 s it lists nothing and shows no count, not even No worktrees, as before the runner first reports the worktrees; then the rows come back",
              run: () => works.unreported(3_000),
            },
            {
              label: "Refuse the next close",
              hint: "Open Changes: the next × anywhere leaves its row and shows a message above the list that git status couldn't be read",
              run: () => works.refuseNextClose(),
            },
            {
              label: "Close every worktree",
              hint: "Open Changes: the project's rows go, those of other projects stay; with every project's gone the list is empty, saying when an agent opens a worktree it shows up here",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.removeAll(key.projectId)
              },
            },
            {
              label: "Every state in Changes",
              hint: "Open Changes: the session's first four terminals get a worktree each, one with many files, one small, one in conflict with main and one with the first",
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
              hint: "Open Source and double-click src/checkout/Checkout.tsx (storefront, agents demo): the preview's Clash head at submit() shows owl's version, the last writer, with moth and crow hidden, and a picker of each agent and main; owl joins the merge toggles",
              run: () => works.previewOwl("clash"),
            },
            {
              label: "A change doesn't apply",
              hint: "Open the file preview of src/checkout/Checkout.tsx: a red box says owl changed line 25 before main rewrote it, so it doesn't apply, with Show for its version above main's line 25; the summary counts 1 change that doesn't apply",
              run: () => works.previewOwl("stale"),
            },
            {
              label: "Crow adds OrderSummary.tsx too",
              hint: "Open Source and double-click src/checkout/OrderSummary.tsx (storefront, agents demo; main lacks it): the preview draws the whole file as added lines under moth's head, then, as crow joins, a whole-file Clash head with crow's version shown (the last writer) and a picker",
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
