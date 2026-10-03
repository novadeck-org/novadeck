// An on/off switch, named and described by elements elsewhere in the row. The toggle
// recipe draws it from aria-checked; data-state says the same for themes.
export const Switch = ({
  checked,
  onChange,
  labelledBy,
  describedBy,
  disabled = false,
  busy = false,
  pending = false,
}: {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly labelledBy: string
  readonly describedBy?: string
  readonly disabled?: boolean
  readonly busy?: boolean
  // A change on its way: it keeps focus, says it's busy, and takes no clicks meanwhile.
  readonly pending?: boolean
}): React.JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    aria-checked={checked}
    aria-busy={busy || pending}
    aria-disabled={pending || undefined}
    data-state={checked ? "checked" : "unchecked"}
    disabled={disabled}
    onClick={() => {
      if (!pending) onChange(!checked)
    }}
    className={`switch relative h-5 w-9 shrink-0 ${disabled ? "cursor-not-allowed" : pending ? "cursor-default" : "cursor-pointer"}`}
  >
    <span className="switch-thumb absolute top-0.5 size-3.5" />
  </button>
)
