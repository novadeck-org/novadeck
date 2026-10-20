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

`msg`, `err.message` and data text are cut to 500 characters, a stack to 4,000, after
redaction, so a secret is never cut short before it is looked for. A
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
- `createRedactor`: held secrets, named secret variables, URL credentials, credential headers
  and `key=value` secrets; then `hashUrls`; then email addresses; then `hashPaths`; then keys
  and tokens by their shapes, as [`@novadeck/secrets`](../secrets/README.md) finds them, as
  `<secret>`, after the hashing, so a secret never stops it and one inside a hashed path or
  address goes with it; then the account name as a word of its own. Those shapes take
  more than secrets: long hex and base64 runs (a digest without its `sha256:`, a dashless id;
  commit ids, dashed UUIDs and `sha256:` digests are kept), any `-----BEGIN …-----` block to its
  end (certificates too), a `Cookie:` or `Set-Cookie:` line to its end, the value after any
  name that sounds secret (`credential.helper=`, `signature:`, `set token …`), and command-line
  passwords (`mysql -p`, `redis-cli -a`, `docker login -p`, `curl -u`).
- `hashUrls`: addresses and Git remotes over SSH. Those the app names readable (`readableUrls`:
  a host, `*.` a host and its subdomains, or a host and path) stay whole; public forges
  (`github.com`, `gitlab.com`, `bitbucket.org`) and the loopback keep their host; any other host
  is hashed but for its top-level domain. Paths are hashed as `hashPaths` hashes names, and a
  query and fragment are dropped.
- `hashPaths`: paths in free text (Windows' `\\?\` long paths too), with names hashed by a salted HMAC (`#1f2e3d4c.ts`, keeping
  the extension); the app's folders as placeholders (`<userData>/…`), what is under a private
  place hashed (`<uploads>/#…`), home as `~`, and the
  system's folders, shared roots' first folder and `node_modules` contents as they are. Linux,
  macOS and Windows paths, shares, WSL and `file://` addresses. Names in `readableNames`
  (well-known programs and tool folders: `node`, `git`, `.nvm`, `AppData`…), those an app adds
  (`readable`) and version numbers are never hashed, so a log says which program failed.
- `loadSalt`: the install's salt, made once in a file and never logged.
- `startSession`: `session.start`, and `session.end` once the launch quits; a launch that left
  its marker behind, killed or crashed, is logged by the next as `session.unclean`.

## Privacy, and its limits

The redactor finds paths by their shape: a drive, a share, `~`, a placeholder, a leading `/`,
or a quoted path, which it takes whole. It can't tell a bare name from any other word, so a
relative path (`src/billing.ts`), a folder's name, a project's or terminal's title can't be
found by it. **A line's `msg` and `data` must never interpolate those: only ids, enums, counts,
times and absolute paths.** An unquoted path whose last name has spaces in it, with no extension and at
the end of the text (`/home/ana/My Project`), keeps the words after the first space, and a
bare host is hashed only where a network error names it (`getaddrinfo ENOTFOUND host`). A path
right after a letter or digit and a `+` (`name+/tmp/x`, `x+~/a`, `x+C:\a`, `x+<uploads>/a`) is
taken for part of a base64 key and not hashed; after a `+` alone, as a diff's added line has
it, it is. What a screen showed, typed text, prompts and message bodies are
never logged, but for lines marked `verbose`.

`startSession`'s marker belongs to one process per launch, the one whose end is the launch's
(the app's host): a process started within the launch, and perhaps again, never touches it.
