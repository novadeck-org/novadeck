import type { TerminalMetadata } from "@novadeck/core/types"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"

import { terminalProfile } from "./processes/profiles"

// A terminal in a dialog's subject strip, as its window header names it: the icon of what
// runs in it, its handle and its name.
export const TerminalSubject = ({
  terminal,
}: {
  readonly terminal: TerminalMetadata
}): React.JSX.Element => {
  const { icon: Icon } = terminalProfile(terminal)
  return (
    <SubjectSide>
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
      <HandleChip handle={terminal.handle} />
      <SubjectName>{terminal.name}</SubjectName>
    </SubjectSide>
  )
}
