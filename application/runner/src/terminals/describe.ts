import { z } from "zod"

import type { Kept } from "./naming.js"

/**
 * What an agent asks to describe its own terminal with, through Novadeck's MCP server: a
 * title, a summary of its work, and whether the person asked, in their own words, for
 * this title. There is no target: it is always the caller's terminal.
 */
const describeRequest = z.strictObject({
  title: z.string().max(1024),
  summary: z.string().max(4096),
  asked: z.boolean().optional(),
})

export type DescribeRequest = z.infer<typeof describeRequest>

/** The MCP server's answer: the terminal's title now, and why its title isn't the one asked for, if so. */
export type DescribeAnswer =
  | { readonly ok: true; readonly title: string; readonly kept?: Kept }
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
  const reason =
    field === "asked"
      ? "`asked` must be true or false."
      : (field === "title" || field === "summary") && issue?.code === "too_big"
        ? `The ${field} is far too long.`
        : field === "title" || field === "summary"
          ? "A description needs a `title` and a `summary`, both text."
          : "A description takes only `title`, `summary` and `asked`."
  return { ok: false, reason }
}
