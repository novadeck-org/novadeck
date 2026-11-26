// What Terminal's text settings look like before the person picks: a few lines of terminal
// text. A picture only (aria-hidden): the rows under it say the same in words.

// Lines a terminal might show, with an arrow and an inequality that ligatures join.
const sampleLines = (
  <>
    <span className="settings-sample-muted">~/novadeck</span>{" "}
    <span className="settings-sample-accent">main</span>
    {"\n"}
    <span className="settings-sample-accent">❯</span> pnpm test{" "}
    <span className="settings-sample-muted">--filter runner</span>
    {"\n"}
    {"const ok = (a, b) => a !== b"} <span className="settings-sample-muted">{"// 0O 1lI"}</span>
  </>
)

// The terminal text as Terminal's settings draw it: its font, its size in CSS pixels, and
// whether pairs such as => join.
export const TerminalSample = ({
  family,
  size,
  ligatures,
}: {
  readonly family: string
  readonly size: number
  readonly ligatures: boolean
}): React.JSX.Element => (
  <pre
    className="settings-sample px-4 py-3"
    style={{ fontFamily: `"${family}", var(--font-mono)`, fontSize: `${size}px` }}
    data-ligatures={ligatures ? "on" : "off"}
    aria-hidden="true"
  >
    {sampleLines}
  </pre>
)
