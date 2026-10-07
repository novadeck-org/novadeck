import { spawnSync } from "node:child_process"
import { cp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { maxVoicePartLength } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { folder, sha256 } from "../testing/voice.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { Voice } from "./service.js"

const artifact = async (url: string) => {
  const data = await readFile(url)
  return { url, sha256: sha256(data), size: data.length }
}

// Runs the real engine, which CI has none of. Point these at a whisper.cpp build's `bin`
// folder, a small model, the voice activity model, and a 16 kHz mono WAV of English speech:
//   NOVADECK_VOICE_REAL_ENGINE NOVADECK_VOICE_REAL_MODEL NOVADECK_VOICE_REAL_VAD NOVADECK_VOICE_REAL_CLIP
const { NOVADECK_VOICE_REAL_ENGINE: engine, NOVADECK_VOICE_REAL_MODEL: model } = process.env
const { NOVADECK_VOICE_REAL_VAD: vad, NOVADECK_VOICE_REAL_CLIP: clip } = process.env

describe.skipIf(!engine || !model || !vad || !clip)("voice input with the real engine", () => {
  it("installs, checks and transcribes speech", { timeout: 300_000 }, async ({ resources }) => {
    const source = await folder(resources)
    const contents = join(source, "contents")
    await cp(engine ?? "", contents, { recursive: true })
    await cp(clip ?? "", join(contents, "check.wav"))
    const packed = spawnSync("tar", ["-czf", join(source, "engine.tar.gz"), "-C", contents, "."])
    expect(packed.status).toBe(0)
    const archive = await readFile(join(source, "engine.tar.gz"))
    const manifest = join(source, "engine.json")
    await writeFile(
      manifest,
      JSON.stringify({ file: "engine.tar.gz", sha256: sha256(archive), size: archive.length }),
    )
    const store = new WorkspaceStore()
    const voice = new Voice(store, {
      engine: manifest,
      directory: await folder(resources),
      catalog: {
        models: { small: await artifact(model ?? ""), turbo: await artifact(model ?? "") },
        vad: await artifact(vad ?? ""),
      },
    })
    resources.defer(async () => {
      await voice.close()
      store.close()
    })

    await voice.install("small")
    await voice.settled()
    const { check, failure } = voice.state()
    console.info("check", JSON.stringify(check), "failure", failure)
    expect(failure).toBeNull()
    expect(check).toMatchObject({ model: "small" })

    const speech = (await readFile(clip ?? "")).subarray(44)
    const part = Math.floor((maxVoicePartLength / 4) * 3)
    for (let offset = 0; offset < speech.length; offset += part)
      // eslint-disable-next-line no-await-in-loop -- Parts arrive in order.
      await voice.record(
        "owner",
        "clip",
        offset,
        speech.subarray(offset, offset + part).toString("base64"),
      )
    const started = performance.now()
    const transcript = await voice.transcribe("owner", "clip", "Kennedy")
    console.info("transcribed in", Math.round(performance.now() - started), "ms:", transcript)

    expect(transcript.text.toLowerCase()).toContain("ask not what your country can do for you")
    expect(transcript.language).toBe("en")
  })
})
