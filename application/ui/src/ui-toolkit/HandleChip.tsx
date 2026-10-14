// A terminal's handle as a quiet chip before its name, so what an agent says of `@moth`
// matches what the person sees. The handle is stored bare, so `@` is added here. The chip
// never wraps or shrinks: the name beside it gives way. Nothing for a terminal without one.
export const HandleChip = ({
  handle,
  id,
  className = "",
}: {
  handle: string | undefined
  // Names it as what describes its row, so a screen reader hears the handle.
  id?: string
  className?: string
}): React.JSX.Element | null =>
  handle ? (
    <span id={id} className={`handle-chip ${className}`} data-terminal-handle={handle}>
      @{handle}
    </span>
  ) : null
