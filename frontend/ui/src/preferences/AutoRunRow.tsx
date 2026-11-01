import type { AutoRunState } from "@novadeck/core/autorun"

import { outcomeText } from "../inbox/autorun-text"
import { AutoRunValue } from "../inbox/AutoRunValue"
import { settingRowClasses, settingsCardClasses } from "./settings"

// What Preferences lists of cmd's AutoRun: only while Novadeck's silencing holds, with Undo and
// the exact value it puts back.
export const AutoRunRow = ({
  state,
  onUndo,
  busy = false,
}: {
  readonly state: AutoRunState
  readonly onUndo: () => void
  readonly busy?: boolean
}): React.JSX.Element | null => {
  if (state.state !== "silenced") return null
  const { outcome } = state
  return (
    <ul className={`m-0 p-0 ${settingsCardClasses}`} aria-label="cmd's AutoRun">
      <li className={settingRowClasses}>
        <div className="flex min-w-0 flex-col gap-1">
          <span id="autorun-label">cmd&apos;s AutoRun output is silenced</span>
          <span className="settings-note text-control leading-5">
            Undo restores <AutoRunValue value={state.restores} kind="restores" />
          </span>
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
