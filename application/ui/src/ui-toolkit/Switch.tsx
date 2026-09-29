// An on/off switch, named and described by elements elsewhere in the row.
export const Switch = ({
  checked,
  onChange,
  labelledBy,
  describedBy,
  disabled = false,
  busy = false,
}: {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly labelledBy: string
  readonly describedBy?: string
  readonly disabled?: boolean
  readonly busy?: boolean
}): React.JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    aria-checked={checked}
    aria-busy={busy}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-5 w-9 shrink-0 rounded-control border focus-visible:outline-2 focus-visible:outline-strong focus-visible:outline-offset-2 ${checked ? "border-strong bg-strong" : "border-line bg-soft"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
  >
    <span
      className={`absolute top-0.5 size-3.5 rounded-control border border-line-strong bg-paper transition-[left] duration-(--motion-feedback) ease-interface ${checked ? "left-[18px]" : "left-0.5"}`}
    />
  </button>
)
