import { readFile } from "node:fs/promises"

import { z } from "zod"

/** A file to download, and what it must hash to. */
export type Artifact = { readonly url: string; readonly sha256: string; readonly size: number }

/** The engine's archive, as `engine.json` describes it. */
export const manifest = z.strictObject({
  // A name beside the manifest or under the source, never a path out of it.
  file: z
    .string()
    .min(1)
    .refine((file) => !/[/\\]/.test(file) && file !== ".."),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().nonnegative(),
  // Which server flags and HTTP surface the engine speaks.
  interface: z.int().positive(),
})

export type Manifest = z.infer<typeof manifest>

/** The manifest at `path`, or `undefined` when there is none or it makes no sense. */
export const readManifest = async (path: string | undefined): Promise<Manifest | undefined> => {
  if (path === undefined) return undefined
  try {
    return manifest.parse(JSON.parse(await readFile(path, "utf8")))
  } catch {
    return undefined
  }
}
