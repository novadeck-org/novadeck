import { useSyncExternalStore } from "react"

import type { Store } from "../../../model/store"
import type { TerminalMetadata } from "../../../model/types"
import { sampleOutput } from "../samples"
import { TerminalOutput } from "../TerminalOutput"
import type { Beats } from "./ambient"

// The dev server's or the tests' screen, moved on by as many beats as the desk has had
// of them since it opened.
export const AmbientOutput = ({
  terminal,
  projectName,
  beats,
}: {
  terminal: TerminalMetadata
  projectName: string
  beats: Store<Beats>
}): React.JSX.Element => {
  const counted = useSyncExternalStore(beats.subscribe, beats.getSnapshot)
  const output = sampleOutput(terminal)
  return (
    <TerminalOutput
      terminal={terminal}
      projectName={projectName}
      beats={output === "server" ? counted.server : counted.tests}
    />
  )
}
