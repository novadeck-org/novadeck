import type { CompanionItem } from "@novadeck/protocol"
import { z } from "zod"

/**
 * What an agent asks to show, through Novadeck's MCP server: a file by its path, absolute
 * or from the terminal's directory; for a text file, the lines it points at; a title in
 * place of the file's name; and `open` when the person asked to see it.
 */
// What either request takes: a short name to show, and whether the person asked to see it.
const shared = { title: z.string().min(1).max(256).optional(), open: z.boolean().optional() }

/** Lines of a text file to point at, from the first to the last. */
export const lineRange = z
  .strictObject({ from: z.int().min(1), to: z.int().min(1) })
  .refine(({ from, to }) => to >= from)

/** A file to show, by its path, and the lines to point at. */
export const fileRequest = z.strictObject({
  path: z.string().min(1).max(4096),
  lines: lineRange.optional(),
  ...shared,
})

/** What the protocol takes of a page's address. */
export const maxUrlChars = 8192

/** A page to show, by its http(s) address. */
export const pageRequest = z.strictObject({ url: z.string().min(1).max(maxUrlChars), ...shared })

export type FileRequest = z.infer<typeof fileRequest>
export type PageRequest = z.infer<typeof pageRequest>
export type PresentRequest = FileRequest | PageRequest

/** Why it was not shown, in a sentence the agent can act on. */
export type PresentFailure = { readonly ok: false; readonly reason: string }

/**
 * The MCP server's answer: what the person now sees beside the terminal, or why not.
 * `opened` when it opened at once; `again` when it updated what was already there;
 * `held` when it may hold secrets, so it waits for the person to open it; `tooLarge`
 * for an image too large to preview.
 */
export type PresentAnswer =
  | {
      readonly ok: true
      readonly id: string
      readonly kind: CompanionItem["kind"]
      readonly name: string
      readonly opened: boolean
      readonly again: boolean
      readonly held?: true
      readonly tooLarge?: true
    }
  | PresentFailure

export const failure = (reason: string): PresentFailure => ({ ok: false, reason })

/** The request, or why it cannot be one. */
export const readRequest = (
  value: unknown,
): { readonly ok: true; readonly request: PresentRequest } | PresentFailure => {
  // A page by its url, otherwise a file; each read strictly, so it names what's wrong.
  const page = typeof value === "object" && value !== null && "url" in value
  if (page && "path" in value) return failure("Give a path or a url, not both.")
  if (typeof value === "object" && value !== null && !page && !("path" in value))
    return failure("Give a path or a url.")
  const parsed = (page ? pageRequest : fileRequest).safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  const [issue] = parsed.error.issues
  const field = issue?.path.join(".")
  return failure(field ? `The request's "${field}" is not valid.` : "The request is not valid.")
}
