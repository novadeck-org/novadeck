import type { Backend, TerminalKey } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"
import { isDemoWorks, type DemoWorks, type Placed } from "@novadeck/demo/works"
import { sessionOf, terminalOf } from "@novadeck/demo/workspace"

import { othersOf } from "./terminals"
import type { DemoActionGroup } from "./types"

// Where a terminal's work is: its project, its id and its folder.
const placed = (workspace: Workspace | undefined, key: TerminalKey): Placed => ({
  projectId: key.projectId,
  terminalId: key.terminalId,
  root: terminalOf(workspace, key)?.directory ?? "~",
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

// The panel's group for the Changes panel's states, on the selected terminal's work: a work
// is made at a terminal's first change, so each action works on a terminal without one too.
export const worksGroups = (works: Backend["works"]): readonly DemoActionGroup[] =>
  isDemoWorks(works)
    ? [
        {
          section: "Terminals",
          title: "Changes",
          actions: [
            {
              label: "New lines on its work",
              hint: "Open Changes: the selected terminal's row (made now if it had no work) shows 14 more unread lines, top right and on its first file; a read row moves above the line with the brief wash",
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
              hint: 'Open Changes: the selected row and another terminal of the session (one with a work first) both turn red, each saying "Conflicts with" the other\'s title on hover',
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
                if (key) works.settle(key.terminalId)
              },
            },
            {
              label: "Work merged",
              hint: "Open Changes: the selected terminal's row goes, the count drops by one, and any conflict with it clears on the others",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.end(key.terminalId)
              },
            },
            {
              label: "Work discarded",
              hint: "Open Changes: the selected terminal's row goes, the count drops by one, and any conflict with it clears on the others",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.end(key.terminalId)
              },
            },
            {
              label: "Mark read",
              hint: "Open Changes: the selected row's name and files turn gray, its +N −N goes, and it moves below the line",
              run: ({ selected }) => {
                const key = selected()
                if (key) works.look(key.terminalId)
              },
            },
            {
              label: "Every state in Changes",
              hint: "Open Changes: the session's first four terminals get a work each, one unread with many files, one read, one in conflict with main and one with the first",
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
                  works.look(read.terminalId)
                }
                if (main) works.conflictWithMain(main)
                if (unread && between) works.conflictBetween(between, unread)
              },
            },
          ],
        },
      ]
    : []
