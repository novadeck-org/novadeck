import { z } from "zod"

/**
 * What an agent asks to summarize its own terminal with, through Novadeck's MCP server: a
 * summary of its work. There is no target (it is always the caller's terminal) and no
 * title: titles are Novadeck's.
 */
const summarizeRequest = z.strictObject({
  summary: z.string().max(4096),
})

export type SummarizeRequest = z.infer<typeof summarizeRequest>

/** The MCP server's answer. */
export type SummarizeAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** The request, read strictly, so a refusal names what's wrong. */
export const readSummarizeRequest = (
  value: unknown,
):
  | { readonly ok: true; readonly request: SummarizeRequest }
  | { readonly ok: false; readonly reason: string } => {
  const parsed = summarizeRequest.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  const [issue] = parsed.error.issues
  const field = issue?.path[0]
  const reason =
    field === "summary" && issue?.code === "too_big"
      ? "The summary is far too long."
      : field === "summary"
        ? "A summary needs a `summary`, as text."
        : "A summary takes only `summary`."
  return { ok: false, reason }
}
