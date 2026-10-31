// What a harness's permission hook asked, matched against the person's grants (#587, #588).
// The rules are in architecture/team-issues/approvals-design.md, Appendix A. Every harness uses
// this one matcher; anything it can't read with certainty doesn't match, so the harness's own
// check decides.

/** A preset scope, matched by its allowlist (Appendix A2). */
export type GrantPreset = "push" | "pr"

/** A granted command: exact words, or with `rest`, followed by plain words. */
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
   * The shell dialect the command is read in: POSIX unless it is Codex's on Windows, whose
   * shell (PowerShell or cmd) the payload does not name (Appendix A1).
   */
  readonly dialect?: "windows-codex"
}

/** Why a payload is no shell call the matcher can judge. */
export type NotACall =
  | "not-shell" // another tool
  | "unreadable" // a field missing, of the wrong type, or the payload not whole
  | "extra-fields" // a tool-input field outside the harness's allowed list
  | "too-long" // a command over `maxCommand`

/** A command longer than this never matches. */
export const maxCommand = 16 * 1024

/** What the matcher reads of git in a folder; injected so the matcher stays pure. */
export type GitLookups = {
  /** Every push URL of `remote` in `cwd` (`git remote get-url --push --all`), or undefined. */
  readonly pushUrls: (cwd: string, remote: string) => Promise<readonly string[] | undefined>
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
  lex,
  lexWindows,
  matchCall,
  normalizeRepoUrl,
  refusesCommand,
  type Lexed,
} from "./grants/index.js"
