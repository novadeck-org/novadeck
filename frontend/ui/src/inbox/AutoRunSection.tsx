import { Terminal } from "lucide-react"

import { autoRunEverywhere, autoRunWhy, manualWhy, outcomeText } from "./autorun-text"
import { useInboxContext } from "./InboxProvider"

// cmd's AutoRun, at the top of the Inbox beside the grants, where it prints: the person's value
// and the exact new one, what silencing it does, and the clicks that make it or put it back.
// Nothing here is an agent's text; the runner reads the values, and only a click changes them.

export const AutoRunSection = (): React.JSX.Element | null => {
  const { autorun, silenceAutoRun, undoAutoRun, dismissAutoRun, autorunFailure } = useInboxContext()
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
                <code data-autorun-value="current">{autorun.current}</code>
              </div>
              <div className="grant-row-what text-caption">Novadeck would change it to:</div>
              <div className="grant-row-commands text-caption">
                <code data-autorun-value="next">{autorun.next}</code>
              </div>
              <div className="grant-row-what text-caption">{autoRunEverywhere}</div>
              {autorun.machine !== null && (
                <div className="grant-row-what text-caption">
                  The machine&apos;s AutoRun (HKLM) holds a value too, which Novadeck doesn&apos;t
                  change: <code data-autorun-value="machine">{autorun.machine}</code>
                </div>
              )}
              <div className="grant-row-head">
                {silenceAutoRun && (
                  <button
                    type="button"
                    className="button min-h-6 shrink-0 px-2 text-caption"
                    onClick={() => silenceAutoRun(autorun.next)}
                  >
                    Silence cmd&apos;s AutoRun output
                  </button>
                )}
                {dismissAutoRun && (
                  <button
                    type="button"
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
                  <code data-autorun-value="current">{autorun.current}</code>
                </div>
              )}
              {autorun.machine !== null && (
                <div className="grant-row-commands text-caption">
                  <code data-autorun-value="machine">{autorun.machine}</code>
                </div>
              )}
              <div className="grant-row-what text-caption" data-autorun-step="">
                To change it yourself: open{" "}
                <code>HKEY_{autorun.reason === "machine" ? "LOCAL_MACHINE" : "CURRENT_USER"}</code>
                {"\\Software\\Microsoft\\Command Processor in regedit"}
                {autorun.reason === "machine" && ", as an administrator"}, and change AutoRun
                {(autorun.machine ?? autorun.current) !== null && (
                  <>
                    {" from "}
                    <code>{autorun.machine ?? autorun.current}</code>
                  </>
                )}
                {autorun.suggested === null ? (
                  " so that it sends its output to nul."
                ) : (
                  <>
                    {" to "}
                    <code data-autorun-value="suggested">{autorun.suggested}</code>
                    {", or send its output to nul."}
                  </>
                )}
              </div>
              <div className="grant-row-head">
                {dismissAutoRun && (
                  <button
                    type="button"
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
                <code data-autorun-value="restores">{autorun.restores}</code>
              </div>
              {autorun.machine !== null && (
                <div className="grant-row-what text-caption">
                  The machine&apos;s AutoRun (HKLM) holds a value, which Novadeck doesn&apos;t
                  change: <code data-autorun-value="machine">{autorun.machine}</code>
                </div>
              )}
              <div className="grant-row-head">
                {undoAutoRun && (
                  <button
                    type="button"
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
