import { spawnSync } from "node:child_process"
import { cp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { maxVoicePartLength } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { folder, sha256 } from "../testing/voice.js"
import { WorkspaceStore } from "../workspaces/store.js"
import type { HintFacts } from "./hint.js"
import { Voice } from "./service.js"

const artifact = async (url: string) => {
  const data = await readFile(url)
  return { url, sha256: sha256(data), size: data.length }
}

// The interface the engine package's build wrote, so a bump follows by itself: build the
// engine there first (`pnpm --filter @novadeck/whisper build:engine`).
const builtInterface = async (): Promise<number> =>
  (
    JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../../whisper/dist/engine.json", import.meta.url)),
        "utf8",
      ),
    ) as { interface: number }
  ).interface

// Runs the real engine, which CI has none of. Point these at a whisper.cpp build's `bin`
// folder, a small model, the voice activity model, and a 16 kHz mono WAV of English speech:
//   NOVADECK_VOICE_REAL_ENGINE NOVADECK_VOICE_REAL_MODEL NOVADECK_VOICE_REAL_VAD NOVADECK_VOICE_REAL_CLIP
// To see the hint spell a project's name, also a WAV of English speech saying a name the
// model gets wrong by itself, and that name, as it is spelled:
//   NOVADECK_VOICE_REAL_NAME_CLIP NOVADECK_VOICE_REAL_NAME
const { NOVADECK_VOICE_REAL_ENGINE: engine, NOVADECK_VOICE_REAL_MODEL: model } = process.env
const { NOVADECK_VOICE_REAL_VAD: vad, NOVADECK_VOICE_REAL_CLIP: clip } = process.env
const { NOVADECK_VOICE_REAL_NAME_CLIP: nameClip, NOVADECK_VOICE_REAL_NAME: name } = process.env

const noFacts: HintFacts = {
  project: null,
  cwd: "",
  branch: null,
  folders: [],
  files: [],
}

/** Records a WAV file's speech as a clip, in parts as the client sends them. */
const recorded = async (voice: Voice, clipId: string, path: string) => {
  const speech = (await readFile(path)).subarray(44)
  const part = Math.floor((maxVoicePartLength / 4) * 3)
  for (let offset = 0; offset < speech.length; offset += part)
    // eslint-disable-next-line no-await-in-loop -- Parts arrive in order.
    await voice.record(
      "owner",
      clipId,
      offset,
      speech.subarray(offset, offset + part).toString("base64"),
    )
}

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
      JSON.stringify({
        file: "engine.tar.gz",
        sha256: sha256(archive),
        size: archive.length,
        interface: await builtInterface(),
      }),
    )
    const store = new WorkspaceStore()
    const voice = new Voice(store, {
      engine: manifest,
      directory: await folder(resources),
      catalog: {
        models: { small: await artifact(model ?? ""), turbo: await artifact(model ?? "") },
        vad: await artifact(vad ?? ""),
      },
      hint: (terminalId) =>
        Promise.resolve(terminalId === "named" ? { ...noFacts, project: name ?? null } : undefined),
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

    await recorded(voice, "clip", clip ?? "")
    const started = performance.now()
    const transcript = await voice.transcribe("owner", "clip")
    console.info("transcribed in", Math.round(performance.now() - started), "ms:", transcript)

    expect(transcript.text.toLowerCase()).toContain("ask not what your country can do for you")
    expect(transcript.language).toBe("en")

    if (!nameClip || !name) return
    await recorded(voice, "plain", nameClip)
    const plain = await voice.transcribe("owner", "plain")
    await recorded(voice, "named", nameClip)
    const named = await voice.transcribe("owner", "named", "named")
    console.info("without a hint:", plain.text, "with one:", named.text)
    expect(plain.text).not.toContain(name)
    expect(named.text).toContain(name)
  })
})
