import { companionLimits, type CompanionItem } from "@novadeck/protocol"
import { z } from "zod"

import { ellipsized, list } from "../text.js"

/**
 * What an agent asks to show, through Novadeck's MCP server: one source, under the key
 * that names it, with that source's own options inside it, and the options every source
 * shares beside it: a title in place of the source's name, and `open` when the person
 * asked to see it. A `file` is a path, absolute or from the terminal's directory, and
 * for a text file the lines it points at; a `page` is its http(s) address, and the element
 * to bring into view once it loads; `changes` is the whole change in a repository, the
 * terminal's unless it gives the folder `path`.
 */
// What every request takes: a short name to show, and whether the person asked to see it.
const shared = {
  title: z.string().min(1).max(companionLimits.name).optional(),
  open: z.boolean().optional(),
}

/** Lines of a text file to point at, from the first to the last. */
const lineRange = z
  .strictObject({ from: z.int().min(1), to: z.int().min(1) })
  .refine(({ from, to }) => to >= from)

/** A file to show, by its path, and the lines to point at. */
const fileSource = z.strictObject({
  path: z.string().min(1).max(companionLimits.path),
  lines: lineRange.optional(),
})

const fileRequest = z.strictObject({ file: fileSource, ...shared })

/**
 * A page to show, by its http(s) address, and the element to bring into view as it
 * shows: a CSS selector, which only this show carries out, so the runner keeps it in
 * memory, never with the item.
 */
const pageSource = z.strictObject({
  url: z.string().min(1).max(companionLimits.url),
  scroll: z.string().trim().min(1).max(companionLimits.scroll).optional(),
})

const pageRequest = z.strictObject({ page: pageSource, ...shared })

/**
 * The change in a repository: its working tree against HEAD. The repository is the one
 * the folder `path` is in (absolute, or from the terminal's directory), by default the
 * terminal's own folder.
 */
const changesSource = z.strictObject({
  path: z.string().min(1).max(companionLimits.path).optional(),
})

const changesRequest = z.strictObject({ changes: changesSource, ...shared })

/** Each source `show` takes, by the key that names it. A new kind adds one here. */
const sources = { file: fileRequest, page: pageRequest, changes: changesRequest } as const

/** The keys that name a source, as `show` and `close` list them. */
const sourceNames = Object.keys(sources) as readonly (keyof typeof sources)[]

/**
 * What `close` takes: the source alone, as `show` named it, without a file's lines or a
 * page's scroll, since what is beside the terminal is known by its path or address,
 * whatever it pointed at in it.
 */
const closeShownSources = {
  file: z.strictObject({ file: z.strictObject({ path: fileSource.shape.path }) }),
  page: z.strictObject({ page: z.strictObject({ url: pageSource.shape.url }) }),
  changes: z.strictObject({ changes: changesSource }),
} as const

type FileRequest = z.infer<typeof fileRequest>
type PageRequest = z.infer<typeof pageRequest>
type ChangesRequest = z.infer<typeof changesRequest>
export type ShowRequest = FileRequest | PageRequest | ChangesRequest
export type CloseShownRequest = z.infer<(typeof closeShownSources)[keyof typeof closeShownSources]>

/** Why it was not shown, in a sentence the agent can act on. */
export type RequestFailure = { readonly ok: false; readonly reason: string }

/**
 * The MCP server's answer: what the person now sees beside the terminal, or why not.
 * `opened` when it opened at once; `again` when it updated what was already there;
 * `secret` when it may hold secrets, so it waits for the person to open it; `tooLarge`
 * for an image too large to preview.
 */
export type ShowAnswer =
  | {
      readonly ok: true
      readonly id: string
      readonly kind: CompanionItem["kind"]
      readonly name: string
      readonly opened: boolean
      readonly again: boolean
      /** Where the person had moved what it updated, away from the agent's bar. */
      readonly moved?: string
      readonly secret?: true
      readonly tooLarge?: true
    }
  | RequestFailure

/** What `close` answers: what left the terminal's side, or why nothing did. */
export type CloseShownAnswer =
  | { readonly ok: true; readonly name: string; readonly kind: CompanionItem["kind"] }
  | RequestFailure

export const failure = (reason: string): RequestFailure => ({ ok: false, reason })

// How each source is given, for an agent that gave none, or a flat `path` or `url`.
const shapes = {
  file: "file: { path }",
  page: "page: { url }",
  changes: "changes: { path? }",
} as const satisfies {
  readonly [name in (typeof sourceNames)[number]]: string
}
const forms = sourceNames.map((name) => shapes[name])
const oneSource = `one source, ${list(forms, "or")}`

/** Text named back to the agent, as a key or a path: quoted, and cut short, as it is the agent's own. */
export const named = (key: string): string => JSON.stringify(ellipsized(key, 64, false))

type Read<T> = (value: unknown) => { readonly ok: true; readonly request: T } | RequestFailure

// A request by its schema, or the field it got wrong. A key no schema knows is named too,
// as "file.open" or "lines" beside a page.
const parse = <T>(schema: z.ZodType<T>, value: unknown): ReturnType<Read<T>> => {
  const parsed = schema.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  const [issue] = parsed.error.issues
  const path = issue?.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue?.path
  const field = path?.map(String).join(".")
  return failure(
    field ? `The request's ${named(field)} is not valid.` : "The request is not valid.",
  )
}

// Reads a request that gives exactly one source, by that source's own strict schema, so
// it names what's wrong.
const reader =
  <T>(schemas: { readonly [name in (typeof sourceNames)[number]]: z.ZodType<T> }): Read<T> =>
  (value) => {
    if (typeof value !== "object" || value === null) return failure("The request is not valid.")
    const given = sourceNames.filter((name) => Object.hasOwn(value, name))
    if (given.length === 0) return failure(`Give ${oneSource}.`)
    if (given.length > 1) return failure(`Give ${oneSource}, not several.`)
    return parse(schemas[given[0]!], value)
  }

/** A `show` request, or why it cannot be one. */
export const readShowRequest: Read<ShowRequest> = reader<ShowRequest>(sources)

/** A `close` request, or why it cannot be one. */
export const readCloseShownRequest: Read<CloseShownRequest> =
  reader<CloseShownRequest>(closeShownSources)

/**
 * What `look` takes: the page to look at, named by the address given `show`, or nothing
 * when the terminal's bar holds a single page.
 */
const lookRequest = z.strictObject({
  page: z.strictObject({ url: pageSource.shape.url }).optional(),
})

export type LookRequest = z.infer<typeof lookRequest>

/** A `look` request, or why it cannot be one. */
export const readLookRequest: Read<LookRequest> = (value) => parse(lookRequest, value)
