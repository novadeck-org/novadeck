import { useState } from "react"

import { refusalText, type Refusal } from "../model/addon"
import { formatSize, stepLabel } from "../model/addon-format"
import {
  MURMUR_NAME,
  murmurChecking,
  unchecked,
  type Murmur,
  type MurmurState,
} from "../model/murmur"
import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"
import { Switch } from "../ui-toolkit/Switch"
import {
  AddonDetails,
  AddonFailure,
  AddonRow,
  addonNoteClasses,
  addonRowClasses,
  InstallProgress,
} from "./addon-parts"
import {
  deviceText,
  murmurDownloadNote,
  murmurInstallSize,
  murmurUncheckedText,
} from "./murmur-addon"
import { settingsCardClasses } from "./settings"

export type MurmurAddonValue = {
  readonly state: MurmurState
  readonly actions: Pick<Murmur, "install" | "cancel" | "uninstall" | "set">
}

const Note = ({ children }: { readonly children: string }): React.JSX.Element => (
  <div className={settingsCardClasses}>
    <p className={`${addonRowClasses} m-0 ${addonNoteClasses}`}>{children}</p>
  </div>
)

// Murmur's card in Preferences' Addons tab: install it, turn it on, take it away. There is
// no model or language to choose. `murmur` is absent where the backend has none.
export const MurmurAddon = ({
  murmur,
}: {
  readonly murmur: MurmurAddonValue | undefined
}): React.JSX.Element => {
  const [confirming, setConfirming] = useState(false)
  // Set once the person confirms an uninstall, holding the failure then showing: the state
  // has no field for a removal under way, so the card waits for the engine to be gone, a
  // new failure to turn up, or the removal to settle (a repeat of the same failure).
  const [removing, setRemoving] = useState<{ readonly refused: Refusal | null } | null>(null)
  if (removing && murmur && (!murmur.state.installed || murmur.state.refused !== removing.refused))
    setRemoving(null)
  if (!murmur) return <Note>{`${MURMUR_NAME} isn't available here.`}</Note>
  const { state, actions } = murmur
  const { installing, installed, check, unsupported } = state
  // What went wrong: the runner's word, or else the backend's refusal of a call.
  const failure = state.failure ?? (state.refused ? refusalText(state.refused, MURMUR_NAME) : null)
  const recheck = unsupported?.source === "check"
  const owed = unchecked(state)
  if (!state.available)
    return <Note>{`This build has no ${MURMUR_NAME} engine for this platform.`}</Note>
  // An install under way is shown whatever the verdict said: Check again keeps it until the new check ends.
  if (installing)
    return (
      <div className={settingsCardClasses}>
        <InstallProgress
          title={stepLabel(installing.step, murmurChecking)}
          {...(installing.step !== "check" && {
            detail: `${formatSize(installing.received)} of ${formatSize(installing.total)}`,
          })}
          label={stepLabel(installing.step, murmurChecking)}
          received={installing.step === "check" ? 0 : installing.received}
          total={installing.total}
          indeterminate={installing.step === "check"}
          onCancel={actions.cancel}
        />
      </div>
    )
  // Known not to run here, by the host or by an install: nothing to install, and why behind Details.
  // Files that stay beside the verdict (their removal failed) keep the installed card, with its
  // Uninstall; the host's word also never takes away an install that works.
  if (unsupported !== null && !installed)
    return (
      <div className={settingsCardClasses}>
        <div className={addonRowClasses}>
          <span className={addonNoteClasses}>Not available on this computer</span>
        </div>
        <AddonDetails
          {...(recheck && { action: { label: "Check again", onClick: actions.install } })}
        >
          {unsupported.reason}
        </AddonDetails>
      </div>
    )
  if (!installed)
    return (
      <div className={settingsCardClasses}>
        {/* Wanted until turned off: an install turns it on. */}
        <AddonRow scope="murmur" id="enabled" label="Enabled">
          <Switch
            checked={state.wanted}
            onChange={(enabled) => actions.set({ enabled })}
            labelledBy="murmur-enabled"
          />
        </AddonRow>
        <div className={addonRowClasses}>
          <span className={addonNoteClasses}>{murmurDownloadNote(state)}</span>
          <button
            type="button"
            className="button primary min-h-8 shrink-0 px-3 text-control"
            onClick={actions.install}
          >
            Install
          </button>
        </div>
        {failure && <AddonFailure>{failure}</AddonFailure>}
      </div>
    )
  const busy = removing !== null
  // Files beside a verdict and no passed check: it can't run, so no switch that looks as if it did.
  const blocked = unsupported !== null && check === null
  // Nothing to retry where the host's word holds, or no check can run beside a verdict.
  const noRetry = unsupported !== null && (check === null || !recheck)
  return (
    <>
      <div className={settingsCardClasses}>
        {blocked ? (
          <>
            <div className={addonRowClasses}>
              <span className={addonNoteClasses}>Not available on this computer</span>
            </div>
            <AddonDetails
              {...(recheck && { action: { label: "Check again", onClick: actions.install } })}
            >
              {unsupported?.reason ?? ""}
            </AddonDetails>
          </>
        ) : (
          <AddonRow scope="murmur" id="enabled" label="Enabled">
            <Switch
              checked={state.enabled}
              onChange={(enabled) => actions.set({ enabled })}
              disabled={busy}
              labelledBy="murmur-enabled"
            />
          </AddonRow>
        )}
        {check && (
          <div className={addonRowClasses}>
            <span className={addonNoteClasses}>{deviceText(check)}</span>
          </div>
        )}
        <AddonRow
          scope="murmur"
          id="uninstall"
          label="Uninstall"
          description={`Frees ${formatSize(murmurInstallSize(state))}.`}
        >
          <button
            type="button"
            className="button min-h-8 shrink-0 px-3 text-control"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {busy ? "Removing…" : "Uninstall"}
          </button>
        </AddonRow>
        {(failure || (owed && !noRetry)) && (
          // Installed with no check that passed, murmur can't run yet: another install runs
          // the check again, unless the host's word holds, where nothing can run it.
          <div className="flex items-center justify-between gap-6">
            {failure ? (
              <AddonFailure>{failure}</AddonFailure>
            ) : (
              <p className={`${addonNoteClasses} m-0 px-4 py-3`}>{murmurUncheckedText}</p>
            )}
            {!noRetry && (
              <button
                type="button"
                className="button mr-4 min-h-8 shrink-0 px-3 text-control"
                disabled={busy}
                onClick={actions.install}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        subject={confirming ? state : null}
        title={() => `Uninstall ${MURMUR_NAME}?`}
        description={(shown) =>
          `The engine and the model are removed from this computer, freeing ${formatSize(murmurInstallSize(shown))}. You can install them again.`
        }
        confirmLabel="Uninstall"
        cancelLabel="Cancel"
        onConfirm={() => {
          setConfirming(false)
          setRemoving({ refused: state.refused })
          void actions.uninstall().finally(() => setRemoving(null))
        }}
        onCancel={() => setConfirming(false)}
        widthClassName="w-[min(380px,calc(100vw-32px))]"
      />
    </>
  )
}
