# @novadeck/log

Structured, privacy-first log files: a JSON Lines envelope, a size-bounded rotating writer, a
redactor for paths, secrets and addresses, and collapsing of repeats. Node only; no Electron.

What a file holds is exactly what a person could send in a bug report: every text is redacted
as it is written, not when it is read.

## Subpaths

- `.` (Node): everything below.

## The line

One JSON object per line, in one envelope (`Entry`):

```json
{
  "v": 1,
  "t": "2026-10-19T12:00:00.000Z",
  "level": "warn",
  "proc": "host",
  "sid": "6f1c…",
  "pid": 4242,
  "src": "runner",
  "evt": "runner.exit",
  "msg": "The runner exited.",
  "data": { "run": 1, "code": 9 }
}
```

- `v` is the schema version (`logSchema`); a change that renames or retypes a field raises it.
- `level` is one of `debug`, `info`, `warn`, `error`, `fatal`; `proc` names the process and
  `src` its module.
- `sid` names the launch, `run` the start of a process within it, for one started again.
- `evt` is a stable dotted name, lowercase with kebab-case parts (`doorbell.ring-failed`), for a
  reader to group and count by.
- `data` is flat: strings, numbers, booleans and null, never an object dumped whole.
- `err` is `{ name, message, stack, code }`.
- `verbose: true` marks a line only verbose logging writes, which may hold what a screen showed.

`msg`, `err.message` and data text are cut to 500 characters, a stack to 4,000. A
`SyntaxError` keeps nothing from its first quote on, as JSON.parse quotes its input.

## Parts

- `createLogger`: a process's log. Lines below its level, or marked verbose without verbose
  logging, are dropped; a line that comes again within `collapseMs` is held back and counted
  (`log.repeated`). Logging never throws. `switchableLogger` lets modules take their log when
  they load and write to the file a process opens later; `consoleLogger` only shows warnings and
  errors on the console.
- `openLogFile`: appends synchronously, so a crash right after loses nothing, and rotates
  `name.log` → `name.1.log` → … by size, keeping `keep` files. Each rotated-in file starts with a
  `session.resume` line, so it reads on its own.
- `createRedactor`: held secrets, named secret variables, URL credentials, credential headers,
  tokens by shape, `key=value` secrets and email addresses; then `hashPaths`; then the account
  name as a word of its own.
- `hashPaths`: paths in free text, with names hashed by a salted HMAC (`#1f2e3d4c.ts`, keeping
  the extension); the app's folders as placeholders (`<userData>/…`), home as `~`, and the
  system's folders, shared roots' first folder and `node_modules` contents as they are. Linux,
  macOS and Windows paths, shares, WSL and `file://` addresses.
- `loadSalt`: the install's salt, made once in a file and never logged.
- `startSession`: `session.start`, and `session.end` once the launch quits; a launch that left
  its marker behind, killed or crashed, is logged by the next as `session.unclean`.
