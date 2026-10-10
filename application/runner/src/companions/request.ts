import type { CompanionItem } from "@novadeck/protocol"
import { z } from "zod"

/**
 * What an agent asks to show, through Novadeck's MCP server: one source, under the key
 * that names it, with that source's own options inside it, and the options every source
 * shares beside it: a title in place of the source's name, and `open` when the person
 * asked to see it. A `file` is a path, absolute or from the terminal's directory, and
 * for a text file the lines it points at; a `url` is a page's http(s) address.
 */
// What every request takes: a short name to show, and whether the person asked to see it.
const shared = { title: z.string().min(1).max(256).optional(), open: z.boolean().optional() }

/** Lines of a text file to point at, from the first to the last. */
export const lineRange = z
  .strictObject({ from: z.int().min(1), to: z.int().min(1) })
  .refine(({ from, to }) => to >= from)

/** A file to show, by its path, and the lines to point at. */
export const fileSource = z.strictObject({
  path: z.string().min(1).max(4096),
  lines: lineRange.optional(),
})

export const fileRequest = z.strictObject({ file: fileSource, ...shared })

/** What the protocol takes of a page's address. */
export const maxUrlChars = 8192

/** A page to show, by its http(s) address. */
export const pageRequest = z.strictObject({ url: z.string().min(1).max(maxUrlChars), ...shared })

/** Each source `show` takes, by the key that names it. A new kind adds one here. */
const sources = { file: fileRequest, url: pageRequest } as const

/** The keys that name a source, as `show` and `close` list them. */
export const sourceNames = Object.keys(sources) as readonly (keyof typeof sources)[]

/**
 * What `close` takes: the source alone, as `show` named it, without a file's lines,
 * since what is beside the terminal is known by its path or address, whatever lines
 * it pointed at.
 */
const dismissSources = {
  file: z.strictObject({ file: z.strictObject({ path: fileSource.shape.path }) }),
  url: z.strictObject({ url: pageRequest.shape.url }),
} as const

export type FileRequest = z.infer<typeof fileRequest>
export type PageRequest = z.infer<typeof pageRequest>
export type PresentRequest = FileRequest | PageRequest
export type DismissRequest = z.infer<(typeof dismissSources)[keyof typeof dismissSources]>

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

/** What `close` answers: what left the terminal's side, or why nothing did. */
export type DismissAnswer =
  | { readonly ok: true; readonly name: string; readonly kind: CompanionItem["kind"] }
  | PresentFailure

export const failure = (reason: string): PresentFailure => ({ ok: false, reason })

// How each source is given, for an agent that gave none, or the old flat `path`.
const shapes = { file: "file: { path }", url: "url" } as const satisfies {
  readonly [name in (typeof sourceNames)[number]]: string
}
const oneSource = `one source, ${sourceNames.map((name) => shapes[name]).join(" or ")}`

/** Text named back to the agent, as a key or a path: quoted, and cut short, as it is the agent's own. */
export const named = (key: string): string =>
  JSON.stringify(key.length <= 64 ? key : `${key.slice(0, 63)}…`)

type Read<T> = (value: unknown) => { readonly ok: true; readonly request: T } | PresentFailure

// Reads a request that gives exactly one source, by that source's own strict schema, so
// it names what's wrong.
const reader =
  <T>(schemas: { readonly [name in (typeof sourceNames)[number]]: z.ZodType<T> }): Read<T> =>
  (value) => {
    if (typeof value !== "object" || value === null) return failure("The request is not valid.")
    const given = sourceNames.filter((name) => Object.hasOwn(value, name))
    if (given.length === 0) return failure(`Give ${oneSource}.`)
    if (given.length > 1) return failure(`Give ${oneSource}, not several.`)
    const parsed = schemas[given[0]!].safeParse(value)
    if (parsed.success) return { ok: true, request: parsed.data }
    const [issue] = parsed.error.issues
    // A key no source knows is named too, as "file.open" or "lines" beside a url.
    const path = issue?.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue?.path
    const field = path?.map(String).join(".")
    return failure(
      field ? `The request's ${named(field)} is not valid.` : "The request is not valid.",
    )
  }

/** A `show` request, or why it cannot be one. */
export const readRequest: Read<PresentRequest> = reader<PresentRequest>(sources)

/** A `close` request, or why it cannot be one. */
export const readDismissRequest: Read<DismissRequest> = reader<DismissRequest>(dismissSources)
