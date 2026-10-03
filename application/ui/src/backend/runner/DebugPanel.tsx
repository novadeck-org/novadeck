// The debug panel: triggers the states the runner adapter handles, for manual checks.
// Toggled with Ctrl+Shift+D where the launch offers it; see README "Debug panel".
import { useEffect, useState } from "react"

import type { BackendConnectionState, DebugPanelProps, TerminalKey } from "../port"
import type { RunnerDebug } from "./debug"
import { pause } from "./pause"

// What the panel reads from the backend it belongs to.
export type DebugInspector = {
  // Types into a terminal's shell through its surface's stream; false without one.
  readonly write: (key: TerminalKey, data: string) => Promise<boolean>
  readonly info: () => {
    readonly runnerId: string | undefined
    readonly connection: BackendConnectionState
    readonly restarts: number
    readonly terminals: number
  }
  // Opens the first-run dialog for connecting agents again.
  readonly showWelcome: () => void
}

type Action = {
  readonly label: string
  // What should appear once it runs.
  readonly hint: string
  readonly run: () => void | Promise<void>
}

const startupCodes = [
  "UNAUTHORIZED",
  "INCOMPATIBLE_PROTOCOL",
  "DISCONNECTED",
  "CLOSED",
  "RESOURCE_LIMIT",
  "RUNTIME_CLOSING",
  "INTERNAL_SERVER_ERROR",
] as const

export const createDebugPanel = (debug: RunnerDebug, inspect: DebugInspector) => {
  const DebugPanel = ({
    addTerminal,
    startFresh,
    selected,
  }: DebugPanelProps): React.JSX.Element | null => {
    const [open, setOpen] = useState(false)
    const [info, setInfo] = useState(inspect.info)
    const [note, setNote] = useState("")

    useEffect(() => {
      const toggle = (event: KeyboardEvent): void => {
        if (!(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d")) return
        // Before the terminal or the app's shortcuts see it.
        event.preventDefault()
        event.stopImmediatePropagation()
        setInfo(inspect.info())
        setOpen((value) => !value)
      }
      window.addEventListener("keydown", toggle, { capture: true })
      return () => window.removeEventListener("keydown", toggle, { capture: true })
    }, [])

    useEffect(() => {
      if (!open) return
      const timer = setInterval(() => setInfo(inspect.info()), 500)
      return () => clearInterval(timer)
    }, [open])

    if (!open) return null

    // Types into a terminal's shell, waiting a moment for its stream to attach.
    const type = async (key: TerminalKey | undefined, text: string): Promise<void> => {
      if (!key) return setNote("Select a terminal first.")
      for (let attempt = 0; attempt < 40; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- Waits for the stream to attach.
        if (await inspect.write(key, text).catch(() => false))
          return setNote(`Sent ${JSON.stringify(text)}`)
        // eslint-disable-next-line no-await-in-loop -- Waits for the stream to attach.
        await pause(50)
      }
      setNote("That terminal has no live stream.")
    }
    const typeInSelected = (text: string) => () => type(selected(), text)
    const kill = async (): Promise<void> => {
      if (!debug.killRunner) return setNote("No desktop host to kill the runner.")
      setNote((await debug.killRunner()) ? "Runner killed." : "No runner was running.")
    }

    const groups: readonly (readonly [string, readonly Action[]])[] = [
      [
        "Startup",
        [
          {
            label: "Splash (sim)",
            hint: "Boots again and holds the splash; press Esc to go on.",
            run: () => debug.rehearse({ hold: true }),
          },
          {
            label: "Welcome dialog",
            hint: "Opens the first-run dialog for connecting agents again.",
            run: inspect.showWelcome,
          },
          ...startupCodes.map((code) => ({
            label: `Error ${code} (sim)`,
            hint: "Boots again and fails the first attempt; retrying connects for real.",
            run: () => debug.rehearse({ fail: code }),
          })),
        ],
      ],
      [
        "Runner",
        [
          {
            label: "Kill runner process",
            hint: "Dims and locks terminals, footer Reconnecting…, then shells respawn in place.",
            run: kill,
          },
          {
            label: "Crash loop (4 kills)",
            hint: "Kills it 4× 1.5 s apart; terminals end as Failed to start + Press Enter.",
            run: async () => {
              for (let count = 0; count < 4; count += 1) {
                // eslint-disable-next-line no-await-in-loop -- One kill at a time.
                await kill()
                // eslint-disable-next-line no-await-in-loop -- Lets it come back first.
                await pause(1_500)
              }
            },
          },
          {
            label: "Force reconnecting 5 s (sim)",
            hint: "Footer Reconnecting…, terminals dimmed and locked, then back.",
            run: () => debug.forceReconnecting(5_000),
          },
        ],
      ],
      [
        "Selected terminal",
        [
          { label: "exit", hint: "Clean exit: the tile closes.", run: typeInSelected("exit\r") },
          {
            label: "exit 3",
            hint: "Honey bar Exited · code 3 with Restart (after 2 s of running).",
            run: typeInSelected("exit 3\r"),
          },
          {
            label: "kill -9 $$",
            hint: "Rose bar Killed · SIGKILL with Restart.",
            run: typeInSelected("kill -9 $$\r"),
          },
          {
            label: "sleep 600",
            hint: "Footer 1 running; closing it asks first.",
            run: typeInSelected("sleep 600\r"),
          },
          {
            label: "Run as claude",
            hint: "Claude icon, running (bash: exec -a claude sleep 600).",
            run: typeInSelected("exec -a claude sleep 600\r"),
          },
        ],
      ],
      [
        "New terminals",
        [
          {
            label: "Quick failure",
            hint: "New terminal exits 2 at once: Failed to start · Exited right after starting.",
            run: () => type(addTerminal(), "exit 2\r"),
          },
          {
            label: "Spawn failure",
            hint: "New terminal in a missing folder: Failed to start · Folder not found.",
            run: () => {
              debug.armCreate({ cwd: `/tmp/novadeck-debug-missing-${crypto.randomUUID()}` })
              addTerminal()
            },
          },
          {
            label: "Terminal limit (sim)",
            hint: "Next new terminal fails: Failed to start · Terminal limit reached.",
            run: () => {
              debug.armCreate({ fail: "TERMINAL_LIMIT" })
              addTerminal()
            },
          },
          {
            label: "Burst: 30 terminals",
            hint: "Adds 30 real shells; then kill the runner to watch them respawn.",
            run: () => {
              for (let count = 0; count < 30; count += 1) addTerminal()
            },
          },
        ],
      ],
      [
        "Sessions",
        [
          {
            label: "Background sleep + fresh session",
            hint: "Starts sleep 600 here, then a new session; the panel shows 1 running.",
            run: async () => {
              await type(selected(), "sleep 600\r")
              await pause(1_500)
              startFresh()
            },
          },
        ],
      ],
    ]

    return (
      <aside
        aria-label="Debug panel"
        className="debug-panel floating fixed right-3 bottom-10 z-50 flex max-h-[80vh] w-80 flex-col gap-3 overflow-y-auto p-3 text-[11px]"
      >
        <header className="flex items-center justify-between">
          <strong className="text-[12px]">Debug · Ctrl+Shift+D</strong>
          <button type="button" className="debug-close" onClick={() => setOpen(false)}>
            Close
          </button>
        </header>
        <p className="debug-meta m-0 text-[10px] leading-[1.5]">
          runner {info.runnerId?.slice(0, 8) ?? "?"} · {info.connection} · restarts/60 s{" "}
          {info.restarts} · terminals {info.terminals}
        </p>
        {groups.map(([title, actions]) => (
          <section key={title} className="flex flex-col gap-1.5">
            <h2 className="debug-heading m-0 text-[10px] font-semibold">{title}</h2>
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="debug-action flex flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                onClick={() => {
                  setNote("")
                  void Promise.resolve(action.run()).catch((error: unknown) =>
                    setNote(String(error)),
                  )
                }}
              >
                <span className="font-medium">{action.label}</span>
                <span className="debug-hint text-[10px]">{action.hint}</span>
              </button>
            ))}
          </section>
        ))}
        {note && <p className="debug-hint m-0 text-[10px]">{note}</p>}
      </aside>
    )
  }
  return DebugPanel
}
