import type { TerminalMetadata } from "@novadeck/core/types"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"

import { terminalProfile } from "./processes/profiles"
import { clipped } from "./visible-text"

// A terminal in a dialog's subject strip, as its window header names it: the icon of what
// runs in it, its handle and its name. The name is the terminal's own text, which an agent can
// set: shown in one clipped line with nothing invisible, its direction kept to itself, so it
// can't pose as Novadeck's words in a dialog that approves what an agent does.
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
      <SubjectName>
        <bdi>{clipped(terminal.name, 40)}</bdi>
      </SubjectName>
    </SubjectSide>
  )
}
