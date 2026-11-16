import type { DialogAdapter, RequestFacts } from "@novadeck/harness-core/dialogs"
import { explain } from "@novadeck/harness-core/dialogs"
import type { Log } from "@novadeck/log"
import type { AgentName } from "@novadeck/protocol"

/** Why a request's dialog is raw: no adapter reads it, or the adapter's read failed one way or another. */
export type RawWhy = "unrecognized" | "unsupported" | "clash" | "failed"

/** What the log is told of a request whose dialog turned raw, from the tracker. */
export type Subject = {
  readonly terminalId: string
  readonly agent: AgentName
  /** The harness's version, where the runner knows it. */
  readonly version: string | null
  readonly ref: string
  readonly facts: RequestFacts
  readonly askedAt: number
  readonly adapter: DialogAdapter | undefined
  /** The screen the dialog was looked for on. */
  readonly rows: readonly string[]
  readonly columns: number
}

/** Most characters of the joined refusal codes a line carries. */
const maxCodes = 300

/** The codes, space-separated, as many whole ones as fit in `limit` characters. */
export const codesWithin = (codes: readonly string[], limit: number): string => {
  let joined = ""
  for (const code of codes) {
    const next = joined === "" ? code : `${joined} ${code}`
    if (next.length > limit) break
    joined = next
  }
  return joined
}

/** The bottom rows a verbose line keeps of a screen, as the doorbell's do. */
const screenRows = 24

/**
 * The tool as a log line may name it: a harness's own tool (`Bash`, `AskUserQuestion`,
 * `run_command`) as it is, an MCP tool as `mcp`, as its server's and its own name are the
 * person's, and anything of another shape as `other`.
 */
export const toolForLog = (tool: string): string => {
  if (/mcp/i.test(tool)) return "mcp"
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(tool) ? tool : "other"
}

type Seen = {
  /** When the request's dialog was first told raw. */
  rawAt: number | undefined
  late: boolean
  failed: boolean
}

/**
 * The dialogs' log: one `dialogs.unread` line for each request whose dialog turns raw, with
 * why the adapter did not read it (its refusal codes, from reading the screen once more under
 * `explain`), one `dialogs.read-late` if a raw one reads after all, and one
 * `dialogs.answer-failed` if its answer fails. Never one per read, which the tracker makes
 * every 100 ms while a screen moves. A line holds ids, enums, counts and times, and
 * the refusal codes, which are static; the screen's rows are written only as verbose lines.
 */
export class DialogDiagnostics {
  private readonly seen = new Map<string, Seen>()

  constructor(
    private readonly log: Log,
    private readonly now: () => number,
  ) {}

  /** The refusal codes of reading `rows` once more, in the order noted. */
  refusals(subject: Subject): string[] {
    if (!subject.adapter) return []
    try {
      return explain(() => subject.adapter!.read(subject.rows, subject.facts)).refusals
    } catch {
      // An adapter that throws on a screen is logged as `dialogs.read-failed`; what it noted
      // before the throw goes with it, so the line says only that it threw.
      return ["threw"]
    }
  }

  /** The request's dialog turned raw, or was locked raw: told once for the request. */
  unread(subject: Subject, why: RawWhy): void {
    const seen = this.entry(subject)
    if (seen.rawAt !== undefined) return
    const at = this.now()
    seen.rawAt = at
    this.log.info("dialogs.unread", "An agent's dialog could not be read from its screen.", {
      data: {
        ...this.identity(subject),
        why,
        refusals: codesWithin(this.refusals(subject), maxCodes),
        cols: subject.columns,
        rows: subject.rows.length,
        waitedMs: Math.max(0, at - subject.askedAt),
      },
    })
    const shown = subject.rows.filter((row) => row.trim() !== "").slice(-screenRows)
    shown.forEach((row, index) =>
      this.log.info("dialogs.screen", row.trimEnd(), {
        data: { terminal: subject.terminalId, row: index - shown.length },
        verbose: true,
      }),
    )
  }

  /** A request that was raw has read: told once. */
  readLate(subject: Omit<Subject, "adapter" | "rows" | "columns">): void {
    const seen = this.seen.get(this.key(subject))
    if (!seen || seen.rawAt === undefined || seen.late) return
    seen.late = true
    const at = this.now()
    this.log.info("dialogs.read-late", "An agent's dialog read after it had shown raw.", {
      data: { ...this.identity(subject), rawMs: Math.max(0, at - seen.rawAt) },
    })
  }

  /**
   * An answer failed: told once. `why` is the driver's own wording for the step that failed
   * (a static sentence, or one with a step's counters), never the screen's or the person's text.
   */
  answerFailed(subject: Subject, pressed: boolean, why: string): void {
    const seen = this.entry(subject)
    if (seen.failed) return
    seen.failed = true
    this.log.warn("dialogs.answer-failed", "An answer to an agent's dialog did not go.", {
      data: { ...this.identity(subject), pressed, why },
    })
  }

  /** Forgets the requests of `terminalId` that no longer wait (all of them without `live`). */
  prune(terminalId: string, live?: ReadonlySet<string>): void {
    for (const key of this.seen.keys())
      if (key.startsWith(`${terminalId}\n`) && !live?.has(key.slice(terminalId.length + 1)))
        this.seen.delete(key)
  }

  private key(subject: { terminalId: string; ref: string }): string {
    return `${subject.terminalId}\n${subject.ref}`
  }

  private entry(subject: Subject): Seen {
    const key = this.key(subject)
    let seen = this.seen.get(key)
    if (!seen) {
      seen = { rawAt: undefined, late: false, failed: false }
      this.seen.set(key, seen)
    }
    return seen
  }

  private identity(subject: Omit<Subject, "adapter" | "rows" | "columns">) {
    return {
      terminal: subject.terminalId,
      harness: subject.agent,
      ...(subject.version !== null && { version: subject.version }),
      kind: subject.facts.kind,
      tool: toolForLog(subject.facts.tool),
    }
  }
}
