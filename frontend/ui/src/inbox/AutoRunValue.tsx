import { visibleText } from "./autorun-text"

// An AutoRun value as the runner read it: verbatim, wrapping at its own spaces and anywhere
// else it must, with the characters nothing shows written out (`visibleText`).
export const AutoRunValue = ({
  value,
  kind,
}: {
  readonly value: string
  readonly kind: string
}): React.JSX.Element => (
  <code data-autorun-value={kind} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
    {visibleText(value)}
  </code>
)

// The step for a value Novadeck won't change, in words and never as a command line: regedit,
// as an administrator for the machine's key, and what to change AutoRun from and to.
export const RegeditStep = ({
  machine,
  from,
  to,
}: {
  readonly machine: boolean
  readonly from: string | null
  readonly to: string | null
}): React.JSX.Element => (
  <div className="grant-row-what text-caption" data-autorun-step="">
    To change it yourself: open{" "}
    <code>
      HKEY_{machine ? "LOCAL_MACHINE" : "CURRENT_USER"}\Software\Microsoft\Command Processor
    </code>{" "}
    in regedit{machine && ", as an administrator"}, and change AutoRun
    {from !== null && (
      <>
        {" from "}
        <AutoRunValue value={from} kind="from" />
      </>
    )}
    {to === null ? (
      " so that it sends its output to nul."
    ) : (
      <>
        {" to "}
        <AutoRunValue value={to} kind="suggested" />
        {", or send its output to nul."}
      </>
    )}
  </div>
)
