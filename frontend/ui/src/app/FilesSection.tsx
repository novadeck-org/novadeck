import { activeProject } from "@novadeck/core/state"
import { memo, type ComponentProps } from "react"

import { latestTurnEnd } from "../sidebar/files-turns"
import { FilesPanel } from "../sidebar/FilesPanel"
import { useWorkspaceState } from "./controller/context"

// The Files panel, wired to the workspace. It reads when an agent's turn last ended itself, to
// read its folders again: read by the sidebar, each turn's end drew every panel again.
export const FilesSection = memo(
  (props: Omit<ComponentProps<typeof FilesPanel>, "turn">): React.JSX.Element => {
    const turn = useWorkspaceState((workspace) => latestTurnEnd(activeProject(workspace)!))
    return <FilesPanel {...props} turn={turn} />
  },
)
