import { Editable as ArkEditable } from "@ark-ui/react/editable"
import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react"

import { Tooltip } from "./Tooltip"

export type EditableProps = {
  value: string
  onCommit: (value: string) => void
  onEditingChange: (editing: boolean) => void
  maxLength?: number
  children: ReactNode
}

const Root = ({
  value,
  onCommit,
  onEditingChange,
  maxLength,
  children,
}: EditableProps): React.JSX.Element => {
  const [draft, setDraft] = useState<string>()

  return (
    <ArkEditable.Root
      className="contents"
      value={draft ?? value}
      activationMode="none"
      submitMode="both"
      maxLength={maxLength}
      onValueChange={({ value: next }) => setDraft(next)}
      onValueRevert={() => setDraft(undefined)}
      onValueCommit={({ value: next }) => {
        const committed = next.trim()
        setDraft(undefined)
        if (committed) onCommit(committed)
      }}
      onEditChange={({ edit }) => onEditingChange(edit)}
    >
      {children}
    </ArkEditable.Root>
  )
}

const Input = (props: ComponentPropsWithoutRef<"input">): React.JSX.Element => (
  <ArkEditable.Input {...props} />
)

const Area = (props: ComponentPropsWithoutRef<"div">): React.JSX.Element => (
  <ArkEditable.Area {...props} />
)

type TriggerProps = ComponentPropsWithoutRef<"button"> & { tooltip: string }

const EditTrigger = ({ tooltip, ...props }: TriggerProps): React.JSX.Element => (
  <ArkEditable.Context>
    {(editable) => (
      <Tooltip content={tooltip}>
        <ArkEditable.EditTrigger {...props} id={editable.getEditTriggerProps().id} />
      </Tooltip>
    )}
  </ArkEditable.Context>
)

const SubmitTrigger = ({ tooltip, ...props }: TriggerProps): React.JSX.Element => (
  <ArkEditable.Context>
    {(editable) => (
      <Tooltip content={tooltip}>
        <ArkEditable.SubmitTrigger {...props} id={editable.getSubmitTriggerProps().id} />
      </Tooltip>
    )}
  </ArkEditable.Context>
)

const CancelTrigger = ({ tooltip, ...props }: TriggerProps): React.JSX.Element => (
  <ArkEditable.Context>
    {(editable) => (
      <Tooltip content={tooltip}>
        <ArkEditable.CancelTrigger {...props} id={editable.getCancelTriggerProps().id} />
      </Tooltip>
    )}
  </ArkEditable.Context>
)

export const Editable = { Root, Area, Input, EditTrigger, SubmitTrigger, CancelTrigger }
