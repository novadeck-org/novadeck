import { useState } from "react"

import type { AgentName } from "#core/harnesses"
import type { OfferedUninstall, UninstallResult } from "#core/uninstall"

import { Checkbox } from "../ui-toolkit/Checkbox"
import { Dialog, DialogDescription, DialogTitle } from "../ui-toolkit/Dialog"
import { AddonFailure, AddonRow, addonNoteClasses, addonRowClasses } from "./addon-parts"
import { CopyCommand } from "./CopyCommand"
import { settingsCardClasses } from "./settings"
import {
  askUninstall,
  chooseKeepData,
  namedAgents,
  noteDisconnected,
  confirmLabel,
  disconnectedNote,
  dismissible,
  removalText,
  settleUninstall,
  startUninstall,
  uninstallDescription,
  uninstallLabel,
  type UninstallDialog,
} from "./uninstall"

// What Preferences' About section offers of uninstalling, as the backend has it. Absent
// where the plan is `unavailable` or the backend has none.
export type UninstallValue = {
  readonly plan: OfferedUninstall
  // The agents connected now, which the uninstall disconnects first.
  readonly connected: readonly AgentName[]
  // Disconnects the connected agents and removes the app; it never rejects.
  readonly run: (options: {
    readonly keepData: boolean
    readonly onDisconnected: (agent: AgentName) => void
  }) => Promise<UninstallResult>
  readonly quit: () => void
}

const failed = (): UninstallResult => ({ kind: "failed", reason: "Something went wrong." })

// The About section's row for removing Novadeck from this computer. Where a package
// manager installed it, the row gives the command to run instead of a button.
export const UninstallApp = ({
  uninstall,
}: {
  readonly uninstall: UninstallValue
}): React.JSX.Element => {
  const { plan, connected, run, quit } = uninstall
  const [dialog, setDialog] = useState<UninstallDialog | null>(null)
  // The dialog keeps its last content while it animates out.
  const [last, setLast] = useState(dialog)
  if (dialog !== null && dialog !== last) setLast(dialog)
  const shown = dialog ?? last
  if (plan.kind === "manual") {
    return (
      <div className={settingsCardClasses}>
        <AddonRow
          scope="uninstall"
          id="app"
          label={uninstallLabel}
          description="Homebrew installed Novadeck. To remove it, run this in a terminal."
        />
        <div className={addonRowClasses}>
          <CopyCommand command={plan.command} label="Command to uninstall Novadeck" />
        </div>
      </div>
    )
  }
  const confirm = (): void => {
    if (!dialog) return
    const keepData = dialog.keepData
    setDialog(startUninstall(dialog))
    void run({
      keepData,
      onDisconnected: (agent) =>
        setDialog((current) => current && noteDisconnected(current, agent)),
    })
      .catch(failed)
      .then((result) => setDialog((current) => current && settleUninstall(current, result)))
  }
  return (
    <>
      <div className={settingsCardClasses}>
        <AddonRow
          scope="uninstall"
          id="app"
          label={uninstallLabel}
          description={uninstallDescription}
        >
          <button
            type="button"
            className="button min-h-8 shrink-0 px-3 text-control"
            aria-describedby="uninstall-app-description"
            onClick={() => setDialog(askUninstall())}
          >
            Uninstall…
          </button>
        </AddonRow>
      </div>
      <Dialog
        open={dialog !== null}
        role="alertdialog"
        // Not while it works, nor once the app is closing or gone.
        onOpenChange={(open) => {
          if (!open && dialog && dismissible(dialog)) setDialog(null)
        }}
        label={shown ? heading(shown) : ""}
        initialFocusEl={() => document.querySelector<HTMLElement>("[data-uninstall-focus]")}
        backdropClassName="overlay fixed inset-0 z-50"
        positionerClassName="fixed inset-0 z-50 flex items-center justify-center px-5"
        className="modal flex w-[min(440px,calc(100vw-32px))] flex-col gap-2 p-5"
      >
        {shown && (
          <UninstallBody
            plan={plan}
            connected={connected}
            dialog={shown}
            onKeepData={(keepData) =>
              setDialog((current) => current && chooseKeepData(current, keepData))
            }
            onCancel={() => setDialog(null)}
            onConfirm={confirm}
            onQuit={quit}
          />
        )}
      </Dialog>
    </>
  )
}

const heading = ({ outcome }: UninstallDialog): string =>
  outcome?.kind === "uninstalling"
    ? "Novadeck is closing for its uninstaller."
    : outcome?.kind === "removed"
      ? "Novadeck is uninstalled."
      : "Uninstall Novadeck?"

const UninstallBody = ({
  plan,
  connected,
  dialog,
  onKeepData,
  onCancel,
  onConfirm,
  onQuit,
}: {
  readonly plan: OfferedUninstall
  readonly connected: readonly AgentName[]
  readonly dialog: UninstallDialog
  readonly onKeepData: (keepData: boolean) => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly onQuit: () => void
}): React.JSX.Element => {
  const { outcome, busy, error, keepData } = dialog
  const title = (
    <DialogTitle className="modal-title m-0 text-heading font-medium">
      {heading(dialog)}
    </DialogTitle>
  )
  if (outcome?.kind === "uninstalling") {
    return (
      <>
        {title}
        <DialogDescription className="modal-description m-0 text-body">
          Windows&apos; uninstaller finishes the job.
        </DialogDescription>
      </>
    )
  }
  if (outcome?.kind === "removed") {
    return (
      <>
        {title}
        <DialogDescription className="modal-description m-0 text-body">
          {outcome.leftover
            ? "One step is left for you. Run this in a terminal."
            : "You can quit Novadeck now."}
        </DialogDescription>
        {outcome.leftover && (
          <div className="mt-1">
            <CopyCommand command={outcome.leftover} label="Command to finish uninstalling" />
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="button primary" autoFocus onClick={onQuit}>
            Quit
          </button>
        </div>
      </>
    )
  }
  if (plan.kind !== "ready") return <>{title}</>
  return (
    <>
      {title}
      <DialogDescription className="modal-description m-0 flex flex-col gap-2 text-body">
        <span>
          {removalText(namedAgents(dialog, connected))}
          {plan.handoff === "uninstaller" ? " Windows' uninstaller finishes the job." : ""}
        </span>
        <span>Running terminals will end.</span>
      </DialogDescription>
      {plan.dataFolders.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2.5 text-body">
            <Checkbox
              checked={keepData}
              disabled={busy}
              onChange={onKeepData}
              aria-describedby="uninstall-folders"
            />
            Keep my projects and sessions
          </label>
          <div id="uninstall-folders" className="flex min-w-0 flex-col gap-1.5 pl-6.5">
            <span className={addonNoteClasses}>
              {keepData ? "Stays in" : "Deleted with Novadeck, from"}
            </span>
            {plan.dataFolders.map((folder) => (
              <code key={folder} className="settings-command">
                {folder}
              </code>
            ))}
          </div>
        </div>
      )}
      {error && (
        <AddonFailure>
          {[error, disconnectedNote(dialog.disconnected)].filter(Boolean).join(" ")}
        </AddonFailure>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="button"
          data-uninstall-focus
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="button" className="button primary" disabled={busy} onClick={onConfirm}>
          {busy ? "Removing…" : confirmLabel(plan)}
        </button>
      </div>
    </>
  )
}
