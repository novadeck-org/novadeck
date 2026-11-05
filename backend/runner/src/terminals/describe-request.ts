import { z } from "zod"

/**
 * What an agent asks to describe its own terminal with, through Novadeck's MCP server: a
 * title that names its work and a summary of it. There is no target: it is always the
 * caller's terminal.
 */
const describeRequest = z.strictObject({
  title: z.string().max(4096),
  summary: z.string().max(4096),
})

type DescribeRequest = z.infer<typeof describeRequest>

/** The MCP server's answer. */
export type DescribeAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string }

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
    (field === "title" || field === "summary") && issue?.code === "too_big"
      ? `The ${field} is far too long.`
      : field === "title" || field === "summary"
        ? `A description needs a \`${field}\`, as text.`
        : "A description takes only `title` and `summary`."
  return { ok: false, reason }
}
