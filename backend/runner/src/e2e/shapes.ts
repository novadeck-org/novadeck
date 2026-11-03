import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { shapes as agyShapes, store as agyStore } from "@novadeck/harness-agy/shapes"
import { shapes as claudeShapes, store as claudeStore } from "@novadeck/harness-claude/shapes"
import { shapes as codexShapes, store as codexStore } from "@novadeck/harness-codex/shapes"
import type { Shape, TranscriptStore } from "@novadeck/harness-core/shapes"
import type { AgentName } from "@novadeck/protocol"

// Each harness's transcripts checked against its decoder's shape lists: the e2e fixture's
// teardown runs it over what a test's harnesses wrote, and `pnpm transcripts:shapes` over a
// developer's own history. It imports packages only, as that script loads it by its address.

type Classifier = {
  readonly shapes: (line: string) => readonly Shape[]
  readonly store: TranscriptStore
}

const classifiers: Readonly<Record<AgentName, Classifier>> = {
  claude: { shapes: claudeShapes, store: claudeStore },
  codex: { shapes: codexShapes, store: codexStore },
  agy: { shapes: agyShapes, store: agyStore },
}

/** The transcripts a harness keeps under its home (`Harness.home`), oldest name first. */
export const transcriptFiles = (agent: AgentName, harnessHome: string): string[] => {
  const { folder, file } = classifiers[agent].store
  const root = join(harnessHome, folder)
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => file.test(name))
      .toSorted()
      .map((name) => join(root, name))
  } catch {
    // The harness wrote no transcript there.
    return []
  }
}

/** A shape seen in transcripts: how many lines held it, and the first file one was in. */
export type Seen = { readonly verdict: Shape["verdict"]; lines: number; readonly file: string }

/** Every shape the files hold, by key, with how often it came and where first. */
export const shapesIn = (agent: AgentName, files: readonly string[]): Map<string, Seen> => {
  const { shapes } = classifiers[agent]
  const seen = new Map<string, Seen>()
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      // Gone since it was listed, as a harness rewriting it.
      continue
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      for (const { key, verdict } of shapes(line)) {
        const known = seen.get(key)
        if (known) known.lines += 1
        else seen.set(key, { verdict, lines: 1, file })
      }
    }
  }
  return seen
}

/**
 * What the e2e fixture's teardown reports: each shape the harness's transcripts under its
 * home hold that its decoder's lists don't name, with where it first came.
 */
export const unknownShapes = (agent: AgentName, harnessHome: string): string[] =>
  [...shapesIn(agent, transcriptFiles(agent, harnessHome))]
    .filter(([, seen]) => seen.verdict === "unknown")
    .map(
      ([key, seen]) =>
        `a transcript shape the ${agent} decoder doesn't know: ${key} (${seen.lines} line(s), first in ${seen.file}); add it to harnesses/${agent}/src/shapes.ts, read or skipped`,
    )
