import { refusalText, type Refusal } from "@novadeck/core/addons/addon"
import { formatSize, stepLabel } from "@novadeck/core/addons/format"
import {
  MURMUR_NAME,
  murmurChecking,
  unchecked,
  type Murmur,
  type MurmurState,
} from "@novadeck/core/addons/murmur"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { Switch } from "@novadeck/toolkit/Switch"
import { Sparkles } from "lucide-react"
import { useState } from "react"

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

// What the removal asks about, named as the card names it, and what it frees.
const removalBar = (shown: MurmurState, asking: "uninstall" | "remove"): React.JSX.Element => (
  <SubjectBar>
    <SubjectSide>
      <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>{MURMUR_NAME}</SubjectName>
    </SubjectSide>
    <SubjectDetail end>
      {formatSize(asking === "uninstall" ? murmurInstallSize(shown) : shown.sizes.model)}
    </SubjectDetail>
  </SubjectBar>
)

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
// no model or language to choose. `murmur` is absent where the backend has none. Not
// `installable` while Murmur's Experimental switch is off: what is on disk keeps its switch,
// its check and its removal, but nothing installs it from what is left.
export const MurmurAddon = ({
  murmur,
  installable = true,
}: {
  readonly murmur: MurmurAddonValue | undefined
  readonly installable?: boolean
}): React.JSX.Element => {
  const [confirming, setConfirming] = useState(false)
  // What the dialog asks, kept after it closes so its words don't change while it fades: the
  // whole uninstall, or only the model kept beside a verdict.
  const [asking, setAsking] = useState<"uninstall" | "remove">("uninstall")
  // Set once the person confirms an uninstall, holding the failure then showing: the state
  // has no field for a removal under way, so the card waits for the engine to be gone, a
  // new failure to turn up, or the removal to settle (a repeat of the same failure).
  const [removing, setRemoving] = useState<{ readonly refused: Refusal | null } | null>(null)
  // The dialog asks about the card it opened on: a card that became another (an install
  // elsewhere passed, or the model went) closes it, so it never confirms what it no longer is.
  const shape = murmur ? `${murmur.state.installed}/${murmur.state.kept}` : ""
  const [openedOn, setOpenedOn] = useState(shape)
  if (openedOn !== shape) {
    setOpenedOn(shape)
    setConfirming(false)
    setAsking("uninstall")
  }
  if (
    removing &&
    murmur &&
    ((!murmur.state.installed && !murmur.state.kept) || murmur.state.refused !== removing.refused)
  )
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
  // Known not to run here, by the app or by an install: nothing to install, and why behind Details.
  // Files that stay beside the verdict (their removal failed) keep the installed card, with its
  // Uninstall; the app's word also never takes away an install that works.
  const dialog = (
    <ConfirmDialog
      subject={confirming ? state : null}
      bar={(shown) => removalBar(shown, asking)}
      title={() => (asking === "uninstall" ? "Uninstall this add-on?" : "Remove the model?")}
      description={(shown) =>
        asking === "uninstall"
          ? `The engine and the model are removed from this computer, freeing ${formatSize(murmurInstallSize(shown))}. You can install them again.`
          : `The model is removed from this computer, freeing ${formatSize(shown.sizes.model)}. A new check downloads it again.`
      }
      confirmLabel={asking === "uninstall" ? "Uninstall" : "Remove"}
      cancelLabel="Cancel"
      onConfirm={() => {
        setConfirming(false)
        setRemoving({ refused: state.refused })
        void actions.uninstall().finally(() => setRemoving(null))
      }}
      onCancel={() => setConfirming(false)}
      widthClassName="w-[min(380px,calc(100vw-32px))]"
    />
  )
  // A model downloaded earlier stays beside an engine that went, so it can be removed.
  const keptModel = state.kept && (
    <AddonRow
      scope="murmur"
      id="remove-model"
      label="Model"
      description={`Downloaded earlier, ${formatSize(state.sizes.model)}.`}
    >
      <button
        type="button"
        className="button min-h-8 shrink-0 px-3 text-control"
        disabled={removing !== null}
        onClick={() => {
          setAsking("remove")
          setConfirming(true)
        }}
      >
        {removing !== null ? "Removing…" : "Remove"}
      </button>
    </AddonRow>
  )
  if (unsupported !== null && !installed)
    return (
      <>
        <div className={settingsCardClasses}>
          <div className={addonRowClasses}>
            <span className={addonNoteClasses}>Not available on this computer</span>
          </div>
          <AddonDetails
            {...(recheck &&
              installable && {
                action: {
                  label: "Check again",
                  onClick: actions.install,
                  disabled: removing !== null,
                },
              })}
          >
            {unsupported.reason}
          </AddonDetails>
          {keptModel}
        </div>
        {dialog}
      </>
    )
  if (!installed)
    return (
      <>
        <div className={settingsCardClasses}>
          {installable && (
            <>
              {/* Off until it is on the computer: an install turns it on. */}
              <AddonRow
                scope="murmur"
                id="enabled"
                label="Name terminals"
                description="Turns on when you install it."
              >
                <Switch
                  checked={false}
                  onChange={() => {}}
                  disabled
                  labelledBy="murmur-enabled"
                  describedBy="murmur-enabled-description"
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
            </>
          )}
          {keptModel}
          {failure && <AddonFailure>{failure}</AddonFailure>}
        </div>
        {dialog}
      </>
    )
  const busy = removing !== null
  // Files beside a verdict and no passed check: it can't run, so no switch that looks as if it did.
  const blocked = unsupported !== null && check === null
  // Nothing to retry where the app's word holds, or no check can run beside a verdict.
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
              {...(recheck && {
                action: { label: "Check again", onClick: actions.install, disabled: busy },
              })}
            >
              {unsupported?.reason ?? ""}
            </AddonDetails>
          </>
        ) : (
          <AddonRow
            scope="murmur"
            id="enabled"
            label="Name terminals"
            {...(check && { description: deviceText(check) })}
          >
            <Switch
              checked={state.enabled}
              onChange={(enabled) => actions.set({ enabled })}
              disabled={busy}
              labelledBy="murmur-enabled"
              {...(check && { describedBy: "murmur-enabled-description" })}
            />
          </AddonRow>
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
            onClick={() => {
              setAsking("uninstall")
              setConfirming(true)
            }}
          >
            {busy ? "Removing…" : "Uninstall"}
          </button>
        </AddonRow>
        {(failure || (owed && !noRetry)) && (
          // Installed with no check that passed, murmur can't run yet: another install runs
          // the check again, unless the app's word holds, where nothing can run it.
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
      {dialog}
    </>
  )
}
