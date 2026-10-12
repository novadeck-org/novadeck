import { Progress } from "../ui-toolkit/Progress"
import { settingRowClasses } from "./settings"

// What the addon cards in Preferences' Addons tab share: their rows, an install under way,
// and a failure's note.

export const addonRowClasses = `preference-row ${settingRowClasses}`
export const addonNoteClasses = "settings-description text-control leading-relaxed"

// A setting's row in an addon's card. `scope` names the addon, so the label and its
// description get ids no other card's row has.
export const AddonRow = ({
  scope,
  id,
  label,
  description,
  children,
}: {
  readonly scope: string
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly children?: React.ReactNode
}): React.JSX.Element => (
  <div className={addonRowClasses}>
    <span className="flex min-w-0 flex-col gap-1">
      <span id={`${scope}-${id}`}>{label}</span>
      {description && (
        <span id={`${scope}-${id}-description`} className={addonNoteClasses}>
          {description}
        </span>
      )}
    </span>
    {children}
  </div>
)

// An install under way: its step and size beside Cancel, and the step's progress. `title`
// says what the step fetches, `detail` how much of it is there; a check has no size.
export const InstallProgress = ({
  title,
  detail,
  label,
  received,
  total,
  onCancel,
}: {
  readonly title: string
  readonly detail?: string
  // The progress bar's name.
  readonly label: string
  readonly received: number
  readonly total: number
  readonly onCancel: () => void
}): React.JSX.Element => (
  <div
    className={`${addonRowClasses} flex-col items-stretch gap-2.5`}
    role="group"
    aria-label="Installing"
  >
    <div className="flex items-center justify-between gap-6">
      <span className="flex min-w-0 flex-col gap-1">
        <span>{title}</span>
        {detail && <span className={addonNoteClasses}>{detail}</span>}
      </span>
      <button
        type="button"
        className="button min-h-8 shrink-0 px-3 text-control"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
    <Progress label={label} value={received} max={total} />
  </div>
)

// Why an install or a change failed, in the card.
export const AddonFailure = ({ children }: { readonly children: string }): React.JSX.Element => (
  <p
    className="settings-note m-0 px-4 py-3 text-control leading-relaxed"
    data-tone="danger"
    role="alert"
  >
    {children}
  </p>
)
