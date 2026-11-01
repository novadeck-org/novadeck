import { autoRunEverywhere, autoRunWhy, manualWhy, outcomeText } from "@novadeck/core/autorun-text"
import { Terminal } from "lucide-react"

import { AutoRunValue, RegeditStep } from "./AutoRunValue"
import { useInboxContext } from "./InboxProvider"

// cmd's AutoRun, at the top of the Inbox beside the grants, where it prints: the person's value
// and the exact new one, what silencing it does, and the clicks that make it or put it back.
// Nothing here is an agent's text; the runner reads the values, and only a click changes them.

export const AutoRunSection = (): React.JSX.Element | null => {
  const { autorun, silenceAutoRun, undoAutoRun, dismissAutoRun, autorunFailure, autorunBusy } =
    useInboxContext()
  if (autorun.state === "none" && autorun.outcome === null) return null
  const outcome = autorun.outcome
  return (
    <section className="inbox-grants" aria-label="cmd's AutoRun" data-autorun={autorun.state}>
      <h3 className="inbox-grants-title text-caption">
        <Terminal size={12} strokeWidth={1.8} aria-hidden="true" />
        cmd&apos;s AutoRun
      </h3>
      <ul className="inbox-grants-list">
        <li className="grant-row">
          {autorun.state === "offer" && (
            <>
              <div className="grant-row-what text-caption">{autoRunWhy}</div>
              <div className="grant-row-what text-caption">Now:</div>
              <div className="grant-row-commands text-caption">
                <AutoRunValue value={autorun.current} kind="current" />
              </div>
              <div className="grant-row-what text-caption">Novadeck would change it to:</div>
              <div className="grant-row-commands text-caption">
                <AutoRunValue value={autorun.next} kind="next" />
              </div>
              <div className="grant-row-what text-caption">{autoRunEverywhere}</div>
              {autorun.machine !== null && (
                <div className="grant-row-what text-caption">
                  The machine&apos;s AutoRun (HKLM) holds a value too, which Novadeck doesn&apos;t
                  change: <AutoRunValue value={autorun.machine} kind="machine" />
                </div>
              )}
              <div className="grant-row-head">
                {silenceAutoRun && (
                  <button
                    type="button"
                    disabled={autorunBusy}
                    className="button min-h-6 shrink-0 px-2 text-caption"
                    onClick={() => silenceAutoRun(autorun.next)}
                  >
                    Silence cmd&apos;s AutoRun output
                  </button>
                )}
                {dismissAutoRun && (
                  <button
                    type="button"
                    disabled={autorunBusy}
                    className="button min-h-6 shrink-0 px-2 text-caption"
                    onClick={dismissAutoRun}
                  >
                    Not now
                  </button>
                )}
              </div>
            </>
          )}
          {autorun.state === "manual" && (
            <>
              <div className="grant-row-what text-caption">{autoRunWhy}</div>
              <div className="grant-row-what text-caption">
                {manualWhy(autorun.reason, autorun.rule)}
              </div>
              {autorun.current !== null && (
                <div className="grant-row-commands text-caption">
                  <AutoRunValue value={autorun.current} kind="current" />
                </div>
              )}
              {autorun.machine !== null && (
                <div className="grant-row-commands text-caption">
                  <AutoRunValue value={autorun.machine} kind="machine" />
                </div>
              )}
              <RegeditStep
                machine={autorun.reason === "machine"}
                from={autorun.reason === "machine" ? autorun.machine : autorun.current}
                to={autorun.suggested}
              />
              <div className="grant-row-head">
                {dismissAutoRun && (
                  <button
                    type="button"
                    disabled={autorunBusy}
                    className="button min-h-6 shrink-0 px-2 text-caption"
                    onClick={dismissAutoRun}
                  >
                    Not now
                  </button>
                )}
              </div>
            </>
          )}
          {autorun.state === "silenced" && (
            <>
              <div className="grant-row-what text-caption">
                cmd&apos;s AutoRun is silenced. Undo puts this value back exactly:
              </div>
              <div className="grant-row-commands text-caption">
                <AutoRunValue value={autorun.restores} kind="restores" />
              </div>
              {autorun.machine !== null && (
                <div className="grant-row-what text-caption">
                  The machine&apos;s AutoRun (HKLM) holds a value, which Novadeck doesn&apos;t
                  change: <AutoRunValue value={autorun.machine} kind="machine" />
                </div>
              )}
              {autorun.machine !== null && (
                <RegeditStep machine from={autorun.machine} to={autorun.suggested} />
              )}
              <div className="grant-row-head">
                {undoAutoRun && (
                  <button
                    type="button"
                    disabled={autorunBusy}
                    className="button min-h-6 shrink-0 px-2 text-caption"
                    onClick={undoAutoRun}
                  >
                    Undo
                  </button>
                )}
              </div>
            </>
          )}
          {outcome !== null && (
            <div
              className={
                outcome.kind === "failed" || outcome.kind === "undo-refused"
                  ? "grant-row-error text-caption"
                  : "grant-row-last text-caption"
              }
              role="status"
              data-autorun-outcome={outcome.kind}
            >
              {outcomeText(outcome)}
            </div>
          )}
          {autorunFailure !== null && (
            <div className="grant-row-error text-caption" role="alert">
              Could not reach Novadeck&apos;s runner: {autorunFailure}
            </div>
          )}
        </li>
      </ul>
    </section>
  )
}
