import { useEffect, useId, useRef, useState } from "react"

import { KeepFocus, useOverlayOpen, useRecoverFocus } from "./notice-focus"

const copiedMs = 1500

type Copy = "idle" | "copied" | "failed"

// The fix to copy: a button that puts it on the clipboard and says so for a moment, or
// says it could not, then the text beside it asks to select the command by hand.
const CopyFix = ({ fix }: { readonly fix: string }): React.JSX.Element => {
  const [copy, setCopy] = useState<Copy>("idle")
  useEffect(() => {
    // A failure stays, with its hint, until the next try.
    if (copy !== "copied") return
    const timer = setTimeout(() => setCopy("idle"), copiedMs)
    return () => clearTimeout(timer)
  }, [copy])
  const label = copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy"
  return (
    <>
      <button
        type="button"
        className="button min-h-8 px-3"
        onClick={(event) => {
          // The panel keeps mouse focus from moving, and the workspace hands it to the
          // terminal after a click: take it here, so Escape still closes the panel.
          event.currentTarget.focus()
          const write = navigator.clipboard?.writeText(fix)
          if (!write) {
            setCopy("failed")
            return
          }
          void write.then(
            () => setCopy("copied"),
            () => setCopy("failed"),
          )
        }}
      >
        {label}
      </button>
      <span aria-live="polite" aria-atomic className="sr-only">
        {copy === "failed"
          ? "Copy failed. Select the command to copy it."
          : copy === "copied"
            ? "Copied"
            : ""}
      </span>
      {copy === "failed" && <span className="sandbox-text">Select the command and copy it.</span>}
    </>
  )
}

export type FooterSandboxProps = {
  // The command that lets the app run sandboxed; "" where none is known.
  readonly fix: string
  // Whether the notice is raised. It shows only while the footer does, and while nothing
  // else asks for the person's attention (`blocked`).
  readonly open: boolean
  readonly blocked: boolean
  readonly onOpenChange: (open: boolean) => void
}

// Novadeck running without Electron's security sandbox, beside the footer's status: a
// chip, "No sandbox", and the notice above it, which says what happened and gives the one
// command that fixes it. Quiet like the update's chip: it never opens by itself, and the
// notice is a plain panel that takes no focus until the person opens it from the chip,
// where Escape closes it and returns. Opening it closes the update's notice, which shares
// its place, and it waits behind any dialog, menu or popover.
export const FooterSandbox = ({
  sandbox,
  hidden,
}: {
  // Undefined while the app is sandboxed, or the host does not say.
  readonly sandbox: FooterSandboxProps | undefined
  readonly hidden: boolean
}): React.JSX.Element | null => {
  const panel = useRef<HTMLElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const requested = useRef(false)
  const titleId = useId()
  const panelId = useId()
  const wanted = (sandbox?.open ?? false) && !hidden && !sandbox?.blocked
  const overlay = useOverlayOpen(wanted)
  const visible = wanted && !overlay
  const lost = useRecoverFocus((sandbox?.blocked ?? false) || overlay || hidden, chip)
  useEffect(() => {
    if (!visible || !requested.current) return
    // A frame on, after the click that asked has been through the workspace's own click
    // handling, which would hand focus back to the terminal from a panel focused too soon.
    const frame = requestAnimationFrame(() => {
      requested.current = false
      panel.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
  if (!sandbox) return null
  const { fix } = sandbox
  const close = (): void => {
    const inside = panel.current?.contains(document.activeElement) === true
    requested.current = false
    sandbox.onOpenChange(false)
    if (inside) chip.current?.focus()
  }
  return (
    <>
      <button
        ref={chip}
        type="button"
        className="footer-action footer-update cursor-pointer font-bold"
        aria-label="No sandbox: Novadeck is running without its security sandbox"
        aria-expanded={visible}
        aria-controls={visible ? panelId : undefined}
        onClick={() => {
          if (visible) {
            close()
            return
          }
          requested.current = true
          sandbox.onOpenChange(true)
        }}
      >
        No sandbox
      </button>
      {visible && (
        <section
          ref={panel}
          id={panelId}
          data-workspace-notice
          aria-labelledby={titleId}
          className="floating sandbox-panel"
          tabIndex={-1}
          // A click on it leaves focus where it was, in a terminal; except on the command,
          // which must stay selectable.
          onMouseDown={(event) => {
            if (event.target instanceof Element && event.target.closest(".sandbox-command")) return
            event.preventDefault()
          }}
          // Plain Escape closes it; with Shift it goes on to the workspace, which
          // starts navigating.
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.shiftKey) return
            event.preventDefault()
            event.stopPropagation()
            close()
          }}
        >
          <KeepFocus lost={lost} selector=".sandbox-panel" />
          <p id={titleId} className="update-title">
            Novadeck is running without its security sandbox
          </p>
          <p className="sandbox-text">
            {fix === ""
              ? "Started with --no-sandbox, or this system doesn't let Novadeck create the user namespaces the sandbox needs."
              : "This system blocks the sandbox. Run this command, then quit Novadeck and start it again from your applications menu."}
          </p>
          {fix !== "" && (
            <>
              <code
                className="sandbox-command"
                // A long unbroken run, such as the URL, scrolls sideways in a narrow
                // panel, so the keyboard needs to reach it.
                tabIndex={0}
                role="group"
                aria-label="Command to turn on the sandbox"
              >
                {fix}
              </code>
              <div className="update-actions">
                <CopyFix fix={fix} />
              </div>
            </>
          )}
        </section>
      )}
    </>
  )
}
