import { useState } from "react"

import { MURMUR_NAME, type Murmur, type MurmurState } from "../model/murmur"
import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"
import { Switch } from "../ui-toolkit/Switch"
import {
  AddonFailure,
  AddonRow,
  addonNoteClasses,
  addonRowClasses,
  InstallProgress,
} from "./addon-parts"
import { deviceText, murmurInstallSize, murmurStepTitles } from "./murmur-addon"
import { settingsCardClasses } from "./settings"
import { formatSize } from "./voice-addon"

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
  const [removing, setRemoving] = useState<{
    readonly failure: string | null
  } | null>(null)
  if (removing && murmur && (!murmur.state.installed || murmur.state.failure !== removing.failure))
    setRemoving(null)
  if (!murmur) return <Note>{`${MURMUR_NAME} isn't available here.`}</Note>
  const { state, actions } = murmur
  const { failure, installing, installed, check } = state
  if (!state.available)
    return <Note>{`This build has no ${MURMUR_NAME} engine for this platform.`}</Note>
  if (installing)
    return (
      <div className={settingsCardClasses}>
        <InstallProgress
          title={murmurStepTitles[installing.step]}
          {...(installing.step !== "check" && {
            detail: `${formatSize(installing.received)} of ${formatSize(installing.total)}`,
          })}
          label={murmurStepTitles[installing.step]}
          received={installing.step === "check" ? 0 : installing.received}
          total={installing.total}
          onCancel={actions.cancel}
        />
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
          <span className={addonNoteClasses}>
            {`Downloads ${formatSize(murmurInstallSize(state))} once, then works offline. Needs a GPU.`}
          </span>
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
  return (
    <>
      <div className={settingsCardClasses}>
        <AddonRow scope="murmur" id="enabled" label="Enabled">
          <Switch
            checked={state.enabled}
            onChange={(enabled) => actions.set({ enabled })}
            disabled={busy}
            labelledBy="murmur-enabled"
          />
        </AddonRow>
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
        {failure && (
          // Installed with no GPU that passed, murmur can't run: the failure says so, and
          // another install runs the check again.
          <div className="flex items-center justify-between gap-6">
            <AddonFailure>{failure}</AddonFailure>
            <button
              type="button"
              className="button mr-4 min-h-8 shrink-0 px-3 text-control"
              disabled={busy}
              onClick={actions.install}
            >
              Try again
            </button>
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
          setRemoving({ failure })
          void actions.uninstall().finally(() => setRemoving(null))
        }}
        onCancel={() => setConfirming(false)}
        widthClassName="w-[min(380px,calc(100vw-32px))]"
      />
    </>
  )
}
