import { readFile } from "node:fs/promises"

import type { VoiceModel } from "@novadeck/protocol"
import { z } from "zod"

/** A file to download, and what it must hash to. */
export type Artifact = { readonly url: string; readonly sha256: string; readonly size: number }

export type Catalog = {
  readonly models: Readonly<Record<VoiceModel, Artifact>>
  /** The voice activity model, fetched with whichever model is installed. */
  readonly vad: Artifact
}

// Pinned by commit, so what a person downloads is what was tested.
const whisper =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1"

export const catalog: Catalog = {
  models: {
    turbo: {
      url: `${whisper}/ggml-large-v3-turbo-q5_0.bin`,
      sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
      size: 574_041_195,
    },
    small: {
      url: `${whisper}/ggml-small-q5_1.bin`,
      sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
      size: 190_085_487,
    },
  },
  vad: {
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    size: 885_098,
  },
}

/** The engine's archive, as `engine.json` describes it. */
export const manifest = z.strictObject({
  // A name beside the manifest or under the source, never a path out of it.
  file: z
    .string()
    .min(1)
    .refine((file) => !/[/\\]/.test(file) && file !== ".."),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().nonnegative(),
  // Which server flags and HTTP surface the engine speaks. An engine unpacked before the
  // marker existed, and a manifest without one, are the first.
  interface: z.int().positive().default(1),
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

/**
 * The model that suits this machine, from how the test clip went: the better one when a
 * GPU ran it in good time, the quicker one otherwise.
 */
export const recommend = (check: { gpu: boolean; milliseconds: number }): VoiceModel =>
  check.gpu && check.milliseconds <= 4000 ? "turbo" : "small"
