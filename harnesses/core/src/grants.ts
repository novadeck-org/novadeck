// What a harness's permission hook asked, matched against the person's grants (#587, #588).
// The rules are in architecture/team-issues/approvals-design.md, Appendix A. Every harness uses
// this one matcher; anything it can't read with certainty doesn't match, so the harness's own
// check decides.

import type { RolloutCall } from "./grants/rollout.js"

/** A preset scope, matched by its allowlist (Appendix A2). */
export type GrantPreset = "push" | "pr"

/** A granted command: exact words. `rest` stays for the wire and is never true: it matches nothing. */
export type GrantCommand = { readonly argv: readonly string[]; readonly rest: boolean }

/** A repo push and pr may reach, `github.com/owner/name`, with its default branch. */
export type GrantRepo = { readonly url: string; readonly defaultBranch: string }

/** What one grant lets through, as the matcher needs it. */
export type GrantScope = {
  readonly presets: readonly GrantPreset[]
  readonly commands: readonly GrantCommand[]
  readonly repos: readonly GrantRepo[]
}

/**
 * The shell command a permission hook asked about, taken from the raw hook payload (never the
 * pruned report), with the folder the call runs in when the harness says it.
 */
export type ShellCall = {
  readonly command: string
  /** The call's own folder: Claude Code's `cwd`; null for Codex and Antigravity (unknown). */
  readonly cwd: string | null
  /**
   * The shell dialect the command is read in: POSIX unless it is Codex's or Antigravity's on
   * Windows, whose shell (PowerShell or cmd) the payload does not name (Appendix A1).
   */
  readonly dialect?: "windows-quote-free"
  /**
   * The folder the harness's payload names apart from `cwd`: Codex's top-level `cwd`, which is
   * the turn's folder on 0.165 and the call's own on 0.166. The rollout says which (`FsLookups.codexCall`).
   */
  readonly sessionFolder?: string
  /**
   * The command may run in a folder the payload doesn't show: Codex's exec tool takes a
   * `workdir` that neither of its hooks carries (probed, 0.165.0). What git says of a folder
   * (refs, remotes, URL rewrites, configuration) is then no answer for this command.
   */
  readonly folderHidden?: true
  /**
   * Where Codex recorded the call: its rollout and the turn's id, which the permission hook
   * names. The rollout holds the call's `workdir` and its turn's mode (see `FsLookups.codexCall`).
   */
  readonly rollout?: { readonly path: string; readonly turn: string }
}

/** Why a payload is no shell call the matcher can judge. */
export type NotACall =
  | "not-shell" // another tool
  | "unreadable" // a field missing, of the wrong type, or the payload not whole
  | "extra-fields" // a tool-input field outside the harness's allowed list
  | "too-long" // a command over `maxCommand`

/** A command longer than this never matches. */
export const maxCommand = 16 * 1024

/** What the matcher reads of the disk; injected so the matcher stays pure. Any error is undefined. */
export type FsLookups = {
  /** The real path of `path` (symlinks followed) and whether it is a regular file. */
  readonly real: (
    path: string,
  ) => Promise<{ readonly path: string; readonly file: boolean } | undefined>
  /**
   * What Codex's rollout says of the call (`rolloutCall`): its `workdir`, its turn's folder and
   * whether the turn plans. Undefined where the rollout can't be read.
   */
  readonly codexCall: (
    rollout: { readonly path: string; readonly turn: string },
    command: string,
  ) => Promise<RolloutCall | undefined>
  /**
   * The names in the folder `path` (a folder that does not exist holds none), or undefined
   * where that couldn't be told (an error other than absence, a timeout).
   */
  readonly names: (path: string) => Promise<readonly string[] | undefined>
}

/** What the matcher reads of git in a folder; injected so the matcher stays pure. */
export type GitLookups = {
  /** Every push URL of `remote` in `cwd` (`git remote get-url --push --all`), or undefined. */
  readonly pushUrls: (cwd: string, remote: string) => Promise<readonly string[] | undefined>
  /**
   * The full name `name` resolves to in `cwd` (`git rev-parse --symbolic-full-name`, as
   * `refs/heads/x` or `refs/tags/x`), null for a name that is no ref there, undefined where
   * that couldn't be told (an error, a timeout).
   */
  readonly resolve: (cwd: string, name: string) => Promise<string | null | undefined>
  /**
   * Every place `git push <url>` sends in `cwd`: the push URLs of a remote section named like
   * the URL, else the URL after the configuration's `pushInsteadOf` (else `insteadOf`) rewrite.
   * Undefined where that couldn't be told or git's rewrite isn't modelled.
   */
  readonly pushTarget: (cwd: string, url: string) => Promise<readonly string[] | undefined>
}

/** A match: which grant entry let it through, for the use line. */
export type GrantMatch =
  | { readonly kind: "preset"; readonly preset: GrantPreset }
  | { readonly kind: "command"; readonly index: number }

// Implemented in ./grants/ (lexer, presets, commands, payload readers); re-exported here.
export {
  agyNonCommandTools,
  callFromPayload,
  isAgyNonCommandTool,
  novadeckMcpTools,
  lex,
  lexCall,
  lexWindows,
  matchCall,
  normalizeRepoUrl,
  rolloutCall,
  type RolloutCall,
  refusesCommand,
  type Lexed,
} from "./grants/index.js"
