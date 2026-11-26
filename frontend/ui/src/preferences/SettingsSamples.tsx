// What Terminal's text settings look like before the person picks: a few lines of terminal
// text. A picture only (aria-hidden): the rows under it say the same in words.

// Lines a terminal might show, with an arrow and an inequality that ligatures join, and a prompt
// waiting under them.
const sampleLines = (
  <>
    <span className="settings-sample-muted">~/novadeck</span>{" "}
    <span className="settings-sample-accent">main</span>
    {"\n"}
    <span className="settings-sample-accent">❯</span> pnpm test{" "}
    <span className="settings-sample-muted">--filter runner</span>
    {"\n"}
    <span className="settings-sample-keyword">const</span>
    {" ok = (a, b) => a !== b "}
    <span className="settings-sample-muted">{"// 0O 1lI"}</span>
    {"\n"}
    <span className="settings-sample-accent">❯</span> <span className="settings-sample-cursor" />
  </>
)

// The terminal text as Terminal's settings draw it: its font, its size in CSS pixels, and
// whether pairs such as => join, under a caption that names them. `font` is the font's name as
// the font list shows it.
export const TerminalSample = ({
  family,
  font,
  size,
  ligatures,
}: {
  readonly family: string
  readonly font: string
  readonly size: number
  readonly ligatures: boolean
}): React.JSX.Element => (
  <div className="settings-sample" aria-hidden="true">
    <div className="settings-sample-caption flex justify-between gap-4 px-4 pt-2.5">
      <span>Sample</span>
      <span className="truncate">
        {size}px · {font} · ligatures {ligatures ? "on" : "off"}
      </span>
    </div>
    <pre
      className="m-0 overflow-hidden px-4 pt-1.5 pb-3 whitespace-pre"
      style={{ fontFamily: `"${family}", var(--font-mono)`, fontSize: `${size}px` }}
      data-ligatures={ligatures ? "on" : "off"}
    >
      {sampleLines}
    </pre>
  </div>
)
