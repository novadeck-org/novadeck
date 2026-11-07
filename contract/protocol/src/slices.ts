import { z } from "zod"

// `agents.slice` snapshots: the rows of a terminal's screen that stand for something of the
// harness's own at its input, as they are drawn, so the chat can show them live in place of
// a dialog. Nothing reads what the rows mean. Bounded like a transcript's items; a slice past
// these limits is no slice, as rows cut short would be the wrong rows.
export const sliceLimits = { rows: 128, runs: 256, rowText: 2048, columns: 1024 } as const

// A palette index, or an RGB colour as `#rrggbb`; null for the terminal's default.
const sliceColour = z
  .union([z.number().int().min(0).max(255), z.string().regex(/^#[0-9a-f]{6}$/)])
  .nullable()

// Cells side by side in one style. `width` is how many columns they take, as a double-width
// character's two columns are one character of `text`.
export const sliceRun = z.strictObject({
  text: z.string().max(sliceLimits.rowText),
  width: z.number().int().positive().max(sliceLimits.columns),
  fg: sliceColour,
  bg: sliceColour,
  bold: z.boolean(),
  dim: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
  inverse: z.boolean(),
})

// Self-contained: its columns come with its rows, so a copy reads the same later. `reason`
// says only what the box and dialog readers tell: a menu at a box holding the harness's own
// key, a view with the box gone or under one, a dialog no adapter could read. `secret` marks
// rows a harness's reader knows as a secret prompt: nothing keeps a copy of those. A slice's
// rows go to its reader and nowhere else: never to a log, a trace or telemetry.
export const liveSlice = z.strictObject({
  reason: z.enum(["menu", "view", "dialog"]),
  columns: z.number().int().positive().max(sliceLimits.columns),
  rows: z.array(z.array(sliceRun).max(sliceLimits.runs)).min(1).max(sliceLimits.rows),
  // Where the cursor is, in the slice's rows and columns; null when it is elsewhere.
  cursor: z
    .strictObject({ row: z.number().int().nonnegative(), column: z.number().int().nonnegative() })
    .nullable(),
  secret: z.boolean(),
})

export const sliceChange = z.strictObject({ slice: liveSlice.nullable() })

export type SliceRun = z.infer<typeof sliceRun>
export type LiveSlice = z.infer<typeof liveSlice>
export type SliceChange = z.infer<typeof sliceChange>
