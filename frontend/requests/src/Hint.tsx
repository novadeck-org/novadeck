// A warning beside a field that is always in the page, empty while the text is fine, so a
// screen reader announces it when its text appears. The field points at it.
export const Hint = ({
  id,
  text,
  className,
}: {
  readonly id: string
  readonly text: string
  readonly className: string
}): React.JSX.Element => (
  <p id={id} role="status" className={className}>
    {text}
  </p>
)
