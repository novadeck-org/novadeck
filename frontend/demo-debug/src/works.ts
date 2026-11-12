import type { Backend, TerminalKey } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"
import { isDemoWorks, worktreeRoot, type DemoWorks, type Placed } from "@novadeck/demo/works"
import { sessionOf, terminalOf } from "@novadeck/demo/workspace"

import { othersOf } from "./terminals"
import type { DemoActionGroup } from "./types"

// Where a terminal's worktree is made if it has none: its project, its id, and a worktree of
// the project named after the terminal.
const placed = (workspace: Workspace | undefined, key: TerminalKey): Placed => ({
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
export const worksGroups = (works: Backend["works"]): readonly DemoActionGroup[] =>
  isDemoWorks(works)
    ? [
        {
          section: "Terminals",
          title: "Changes",
          actions: [
            {
              label: "New lines on its work",
              hint: "Open Changes: the selected terminal's row (made now if it had no worktree) shows 14 more unread lines, top right; a read row moves above the line with the brief wash",
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
              hint: "Open Changes: the selected terminal's row stays but has no files, so its × closes it at once; any conflict with it clears on the others",
              run: ({ selected }) => {
                const key = selected()
                const own = key && works.ownedBy(key.terminalId)
                if (own) works.merge(own.root)
              },
            },
            {
              label: "Mark read",
              hint: "Open Changes: the selected row's name and files turn gray, its +N −N goes, and it moves below the line",
              run: ({ selected }) => {
                const key = selected()
                const own = key && works.ownedBy(key.terminalId)
                if (own) works.look(own.root)
              },
            },
            {
              label: "Worktree just made",
              hint: "Open Changes: the selected terminal's row has its branch and no changes; hover it and click ×: it closes with no question",
              run: ({ selected, workspace }) => {
                const key = selected()
                if (key) works.openClean(placed(workspace(), key))
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
              hint: "Open Changes: the selected terminal's worktree has no changed files but two commits main lacks; click its ×: the dialog says it holds 2 commits the main branch doesn't have, and closing needs your Close worktree",
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
              label: "Refuse the next close",
              hint: "Open Changes: the next × anywhere leaves its row and shows a message above the list that git status couldn't be read",
              run: () => works.refuseNextClose(),
            },
            {
              label: "Close every worktree",
              hint: "Open Changes: the project's list is empty, saying when an agent opens a worktree it shows up here; with Agent worktrees off in Preferences > Experimental it also points there",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.removeAll(key.projectId)
              },
            },
            {
              label: "Every state in Changes",
              hint: "Open Changes: the session's first four terminals get a worktree each, one unread with many files, one read, one in conflict with main and one with the first",
              run: ({ selected, workspace }) => {
                const key = selected()
                const session = key && sessionOf(workspace(), key)
                if (!key || !session) return
                const [unread, read, main, between] = session.state.roster.terminals
                  .slice(0, 4)
                  .map((terminal) => placed(workspace(), { ...key, terminalId: terminal.id }))
                if (unread) {
                  works.gain(unread, 40)
                  works.spread(unread, 8)
                }
                if (read) {
                  works.gain(read, 12)
                  const own = works.ownedBy(read.terminalId)
                  if (own) works.look(own.root)
                }
                if (main) works.conflictWithMain(main)
                if (unread && between) works.conflictBetween(between, unread)
              },
            },
          ],
        },
      ]
    : []
