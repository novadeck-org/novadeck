import type { AutoRunState } from "@novadeck/core/autorun"
import { outcomeText } from "@novadeck/core/autorun-text"
import { visibleText } from "@novadeck/core/visible-text"

import { addonNoteClasses } from "./addon-parts"
import { settingRowClasses, settingsCardClasses } from "./settings"

const value = (kind: string, text: string): React.JSX.Element => (
  <code data-autorun-value={kind} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
    {visibleText(text)}
  </code>
)

// What Preferences lists of Command Prompt's startup script: one row while Novadeck's hiding
// of its output holds, with Undo, and behind Details the exact value Undo puts back.
export const AutoRunRow = ({
  state,
  onUndo,
  fix,
  busy = false,
}: {
  readonly state: AutoRunState
  readonly onUndo: () => void
  // The link that opens the confirm, which the app makes for the Inbox's own line too.
  readonly fix?: React.ReactNode
  readonly busy?: boolean
}): React.JSX.Element | null => {
  if ((state.state === "offer" || state.state === "manual") && fix)
    return (
      <ul className={`m-0 p-0 ${settingsCardClasses}`} aria-label="Command Prompt startup output">
        <li className={settingRowClasses}>
          <span>Antigravity on this PC needs one fix to use approvals</span>
          <span style={{ whiteSpace: "nowrap" }}>{fix}</span>
        </li>
      </ul>
    )
  if (state.state !== "silenced") return null
  const { outcome } = state
  return (
    <ul className={`m-0 p-0 ${settingsCardClasses}`} aria-label="Command Prompt startup output">
      <li className={settingRowClasses}>
        <div className="flex min-w-0 flex-col gap-1">
          <span id="autorun-label">Command Prompt startup output hidden for Antigravity</span>
          <details className={addonNoteClasses}>
            <summary className="cursor-pointer select-none">Details</summary>
            <p className="m-0 mt-1 break-words">
              Undo puts this back exactly: {value("restores", state.restores)}
            </p>
            {state.machine !== null && (
              <p className="m-0 mt-1 break-words">
                The machine&apos;s startup script (HKLM) holds a value too, which Novadeck
                doesn&apos;t change: {value("machine", state.machine)}. The Inbox shows how to
                change it yourself.
              </p>
            )}
          </details>
          {outcome !== null && (outcome.kind === "undo-refused" || outcome.kind === "failed") && (
            <span className="settings-note text-control leading-5" data-tone="danger" role="alert">
              {outcomeText(outcome)}
            </span>
          )}
        </div>
        <button
          type="button"
          className="button min-h-6 shrink-0 px-2 text-caption"
          aria-describedby="autorun-label"
          disabled={busy}
          onClick={onUndo}
        >
          Undo
        </button>
      </li>
    </ul>
  )
}
