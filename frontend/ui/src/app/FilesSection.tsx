import { activeProject } from "@novadeck/core/state"
import { memo, useMemo, type ComponentProps } from "react"

import type { TerminalFollower } from "../sidebar/files-sync"
import { latestTurnEnd } from "../sidebar/files-turns"
import { FilesPanel } from "../sidebar/FilesPanel"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { followTerminal } from "./files-terminals"

// The Files panel, wired to the workspace. It reads when an agent's turn last ended itself, to
// read its folders again: read by the sidebar, each turn's end drew every panel again.
export const FilesSection = memo(
  (props: Omit<ComponentProps<typeof FilesPanel>, "turn" | "terminals">): React.JSX.Element => {
    const turn = useWorkspaceState((workspace) => latestTurnEnd(activeProject(workspace)!))
    const { commands, workspace } = useWorkspaceServices()
    // The terminals a Files card's command runs in: opened beside the person's own without taking
    // the view, shown on Show it, and followed while they go.
    const terminals = useMemo(() => {
      // One follower for each terminal, which keeps where it got to while no card shows it.
      const followers = new Map<string, TerminalFollower>()
      return {
        run: ({ directory, command }: { directory: string | undefined; command: string }) => {
          const id = commands.add({
            command,
            title: command,
            quiet: true,
            ...(directory !== undefined && { directory }),
          })
          // Followed from now on, whether or not a card shows it.
          followers.set(id, followTerminal(workspace, id, Date.now()))
          return id
        },
        show: (id: string) => commands.reveal(id, "terminals"),
        follow: (id: string, since: number) => {
          const known = followers.get(id) ?? followTerminal(workspace, id, since)
          followers.set(id, known)
          return known
        },
      }
    }, [commands, workspace])
    return <FilesPanel {...props} turn={turn} terminals={terminals} />
  },
)
