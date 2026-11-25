import { z } from "zod"

/**
 * What an agent asks to describe its own terminal with, through Novadeck's MCP server: a
 * title that names its work and a summary of it. There is no target: it is always the
 * caller's terminal. With `worktree` (a folder) and `worktreeTitle` together, it titles a
 * worktree the caller owns too.
 */
const describeRequest = z
  .strictObject({
    title: z.string().max(4096),
    summary: z.string().max(4096),
    // What the work waits on, in the agent's words; empty clears it, absent leaves it as it is.
    waitingFor: z.string().max(4096).optional(),
    worktree: z.string().min(1).max(4096).optional(),
    worktreeTitle: z.string().max(4096).optional(),
  })
  .refine((request) => (request.worktree === undefined) === (request.worktreeTitle === undefined), {
    path: ["worktree"],
    message: "together",
  })

type DescribeRequest = z.infer<typeof describeRequest>

/** The MCP server's answer. */
export type DescribeAnswer =
  | {
      readonly ok: true
      /** The worktree it titled too: its branch and title. */
      readonly worktree?: { readonly branch: string; readonly title: string }
    }
  | { readonly ok: false; readonly reason: string }

/** The request, read strictly, so a refusal names what's wrong. */
export const readDescribeRequest = (
  value: unknown,
):
  | { readonly ok: true; readonly request: DescribeRequest }
  | { readonly ok: false; readonly reason: string } => {
  const parsed = describeRequest.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  const [issue] = parsed.error.issues
  const field = issue?.path[0]
  const named =
    field === "title" ||
    field === "summary" ||
    field === "waitingFor" ||
    field === "worktree" ||
    field === "worktreeTitle"
  const reason =
    issue?.code === "custom"
      ? "`worktree` and `worktreeTitle` go together: the folder of a worktree you own, and its title."
      : named && issue?.code === "too_big"
        ? `The ${field} is far too long.`
        : named
          ? `A description needs a \`${field}\`, as text.`
          : "A description takes only `title`, `summary`, `waitingFor`, `worktree` and `worktreeTitle`."
  return { ok: false, reason }
}

/** How much of what the work waits on is kept, in characters. */
const waitingChars = 200

/**
 * What a `describe` says of what the work waits on: undefined where it said nothing (what
 * was said before stands), null where it cleared it, else the words, in one short line.
 */
export const waitingForOf = (
  said: string | undefined,
  now: number,
): { readonly text: string; readonly at: number } | null | undefined => {
  if (said === undefined) return undefined
  const text = [
    ...said
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, waitingChars)
    .join("")
    .trim()
  return text === "" ? null : { text, at: now }
}
