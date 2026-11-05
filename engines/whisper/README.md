# @novadeck/whisper

The whisper.cpp engine voice input downloads: `whisper-server`, pinned to a whisper.cpp
commit, patched and built for each platform by `engines/ggml-build`. `pnpm build:engine`
leaves the archive and its `engine.json` in `dist/`; the package's export says where.

## Patches

`patches/` holds what Novadeck changes in whisper.cpp:

- `exit-with-stdin.patch`, `loopback-only.patch`, `no-load-route.patch`: the server's
  interface to the runner (`backend/runner/src/voice/engine.ts`). A change to the flags or the
  HTTP surface they give bumps `engineInterface` in `scripts/build.ts`.
- `reuse-language-encode.patch`: whisper.cpp's decode loop, which encodes the window again
  right after language detection encoded it. The patch skips that encode, which spares a whole
  encoder pass for each clip dictated in `auto` language.

The encoder patch is the one that can go wrong quietly. When a whisper.cpp bump moves what
language detection leaves in the state, a patch that still applies would decode stale encoder
output: wrong or empty transcripts, no error. So the build checks that `src/whisper.cpp`, once
patched, is the file the patch's own `index` line names. A bump that changes that file fails
the build, with a list of what to re-check. It watches only that file, which holds everything
the patch relies on: language detection, the encoder and the audio context. Once you have
re-checked it, re-cut the patch with `git diff` against the new source.

## Checking a build by hand

CI builds the engine and starts it, but has no model, so nothing there transcribes. After a
whisper.cpp bump or a change to a patch, build the engine, unpack it, and run the runner's
real-engine test against it. That test dictates in `auto` language, the path the encoder
patch changes:

```sh
pnpm --filter @novadeck/whisper build:engine
mkdir -p /tmp/whisper-engine && tar -xzf engines/whisper/dist/novadeck-whisper-*.tar.gz -C /tmp/whisper-engine
NOVADECK_VOICE_REAL_ENGINE=/tmp/whisper-engine \
NOVADECK_VOICE_REAL_MODEL=<ggml-small.bin> NOVADECK_VOICE_REAL_VAD=<ggml-silero vad model> \
NOVADECK_VOICE_REAL_CLIP=/tmp/whisper-engine/check.wav \
  pnpm --filter @novadeck/runner exec vitest run src/voice/real.test.ts
```

It must transcribe "ask not what your country can do for you" and detect `en`.
