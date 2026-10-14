import { useEffect, useState } from "react"

const copiedMs = 1500

type Copy = "idle" | "copied" | "failed"

// A command to run in a terminal: selectable text, and a button that puts it on the
// clipboard and says so for a moment, or says it could not, then the text asks to be
// selected by hand.
export const CopyCommand = ({
  command,
  label,
}: {
  readonly command: string
  // What the command is, for the person who cannot see it.
  readonly label: string
}): React.JSX.Element => {
  const [copy, setCopy] = useState<Copy>("idle")
  useEffect(() => {
    // A failure stays, with its hint, until the next try.
    if (copy !== "copied") return
    const timer = setTimeout(() => setCopy("idle"), copiedMs)
    return () => clearTimeout(timer)
  }, [copy])
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="settings-command flex-1"
          // A long unbroken run scrolls sideways, so the keyboard needs to reach it.
          tabIndex={0}
          role="group"
          aria-label={label}
        >
          {command}
        </code>
        <button
          type="button"
          className="button min-h-8 shrink-0 px-3 text-control"
          onClick={() => {
            const write = navigator.clipboard?.writeText(command)
            if (!write) return setCopy("failed")
            void write.then(
              () => setCopy("copied"),
              () => setCopy("failed"),
            )
          }}
        >
          {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
      <span aria-live="polite" aria-atomic className="sr-only">
        {copy === "failed"
          ? "Copy failed. Select the command to copy it."
          : copy === "copied"
            ? "Copied"
            : ""}
      </span>
      {copy === "failed" && (
        <span className="settings-note text-caption">Select the command and copy it.</span>
      )}
    </div>
  )
}
