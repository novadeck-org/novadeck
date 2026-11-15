import { forgeTitles, type ForgeName } from "@novadeck/core/forges"
import { Switch } from "@novadeck/toolkit/Switch"

import { forgeNote, hostLine, type ForgeSwitch } from "./forge-switches"
import { settingRowClasses, settingsCardClasses } from "./settings"

// One switch per forge: on has Novadeck read its pull requests with its command-line tool's
// sign-in, off stops. A forge whose tool is not installed, or one mid-change, cannot be
// switched; one with a known installer offers Install in place of its switch, where
// `onInstall` is given. Under a switched-on forge, each host it found and whether its tool is
// signed in there, with Sign in for one signed out, where `onSignIn` is given.
export const ForgeSwitches = ({
  forges,
  onChange,
  onInstall,
  installing,
  onSignIn,
  signingIn,
}: {
  readonly forges: readonly ForgeSwitch[]
  readonly onChange: (forge: ForgeName, enabled: boolean) => void
  readonly onInstall?: ((forge: ForgeName, command: string) => void) | undefined
  // The forges whose installer runs now.
  readonly installing?: ReadonlySet<ForgeName> | undefined
  // Runs a host's sign-in command in a terminal.
  readonly onSignIn?: ((forge: ForgeName, host: string, command: string) => void) | undefined
  // The hosts whose sign-in runs now, as `${forge}/${host}`.
  readonly signingIn?: ReadonlySet<string> | undefined
}): React.JSX.Element => (
  <ul className={`m-0 p-0 ${settingsCardClasses}`} aria-label="Forges">
    {forges.map((connection) => {
      const { forge, available, enabled, busy, installer } = connection
      const label = forgeTitles[forge]
      if (!available && installer && onInstall)
        return (
          <InstallRow
            key={forge}
            forge={forge}
            label={label}
            command={installer}
            running={installing?.has(forge) === true}
            onInstall={() => onInstall(forge, installer)}
          />
        )
      const note = forgeNote(connection)
      const hosts = available && enabled ? connection.hosts.map(hostLine) : []
      return (
        <li key={forge} className={settingRowClasses}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span id={`forge-${forge}`}>{label}</span>
            {note && (
              <span
                id={`forge-${forge}-note`}
                className="settings-note text-control leading-5"
                {...(note.error ? { "data-tone": "danger", role: "alert" } : {})}
              >
                {note.text}
              </span>
            )}
            {hosts.length > 0 && (
              <ul className="m-0 mt-1 flex flex-col gap-1.5 p-0" aria-label={`${label} hosts`}>
                {hosts.map((line) => {
                  const running = signingIn?.has(`${forge}/${line.host}`) === true
                  return (
                    <li
                      key={line.host}
                      className="settings-note flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-control leading-5"
                      data-forge-host={line.host}
                    >
                      <span className="forge-host-name">{line.host}</span>
                      <span aria-hidden>·</span>
                      <span>{line.words}</span>
                      {line.fix && (
                        <code className="settings-installer min-w-0 [overflow-wrap:anywhere]">
                          {line.fix}
                        </code>
                      )}
                      {line.signIn && onSignIn && (
                        <button
                          type="button"
                          className="button min-h-7 px-2.5 text-control"
                          aria-label={
                            running
                              ? `Signing in to ${line.host}`
                              : `Sign in to ${line.host} with ${forgeTitles[forge]}`
                          }
                          data-forge-sign-in
                          aria-disabled={running || undefined}
                          aria-busy={running || undefined}
                          onClick={() => {
                            if (!running) onSignIn(forge, line.host, line.signIn!)
                          }}
                        >
                          {running ? "Signing in…" : "Sign in"}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Switch
              checked={enabled}
              onChange={(next) => onChange(forge, next)}
              labelledBy={`forge-${forge}`}
              {...(note ? { describedBy: `forge-${forge}-note` } : {})}
              disabled={!available || busy}
              busy={busy}
            />
          </div>
        </li>
      )
    })}
  </ul>
)

// A forge whose tool isn't here: the command its installer runs, whole under its name so
// nothing it will do is hidden, and Install, which runs it in a terminal of the workspace.
const InstallRow = ({
  forge,
  label,
  command,
  running,
  onInstall,
}: {
  readonly forge: ForgeName
  readonly label: string
  readonly command: string
  readonly running: boolean
  readonly onInstall: () => void
}): React.JSX.Element => (
  <li className={settingRowClasses}>
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span id={`forge-${forge}`}>{label}</span>
      <span id={`forge-${forge}-note`} className="settings-note text-control leading-5">
        {running ? "Installing in a terminal of its own." : "Not installed. Install runs"}
        {!running && (
          <code className="settings-installer mt-0.5 block [overflow-wrap:anywhere]">
            {command}
          </code>
        )}
      </span>
    </div>
    <button
      type="button"
      className="button min-h-8 shrink-0 px-3 text-control"
      aria-label={running ? `Installing ${label}` : `Install ${label}`}
      aria-describedby={`forge-${forge}-note`}
      data-forge-install
      aria-disabled={running || undefined}
      aria-busy={running || undefined}
      onClick={() => {
        if (!running) onInstall()
      }}
    >
      {running ? "Installing…" : "Install"}
    </button>
  </li>
)
