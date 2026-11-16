import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dialogRecord, type DialogRecordInput } from "@novadeck/harness-core/testing/dialog-record"

/** How many saved dialogs a folder keeps: the newest, as a person saves a few and attaches them. */
const kept = 50

// A saved file's name: its time, so the newest sort last, then the harness and the kind and a
// few random characters, so two saved at once don't take one name.
const saved = /^\d{8}T\d{6}Z-[a-z]+-[a-z]+-[0-9a-f]{6}\.json$/

/**
 * Where a person's "Save for debugging" puts a dialog Novadeck could not read: one JSON file
 * in `folder` (the logs folder's `dialogs` in the desktop app, beside the database in a
 * standalone runner, a fresh temporary folder where neither is given), owner-only. The file
 * holds the screen's text and the tool's input, so it is written on that action alone, never
 * for a log (see SECURITY.md).
 */
export class DialogSaves {
  private folder: Promise<string> | undefined

  constructor(
    private readonly configured: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Writes the record of `given`; resolves with the file's absolute path. */
  async save(given: Omit<DialogRecordInput, "now">): Promise<string> {
    const now = this.now()
    const folder = await this.place()
    const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "")
    const name = `${stamp}-${given.harness}-${given.request.kind}-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}.json`
    const path = join(folder, name)
    await writeFile(path, `${JSON.stringify(dialogRecord({ ...given, now }), null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    })
    void this.prune(folder)
    return path
  }

  private place(): Promise<string> {
    this.folder ??= (
      this.configured === undefined
        ? mkdtemp(join(tmpdir(), "novadeck-dialogs-"))
        : mkdir(this.configured, { recursive: true, mode: 0o700 }).then(() => this.configured!)
    ).catch((error: unknown) => {
      // Tried again by the next save.
      this.folder = undefined
      throw error
    })
    return this.folder
  }

  // Best effort: only files this wrote, the oldest past `kept`.
  private async prune(folder: string): Promise<void> {
    try {
      const names = (await readdir(folder)).filter((name) => saved.test(name)).toSorted()
      await Promise.all(
        names.slice(0, -kept).map((name) => rm(join(folder, name), { force: true })),
      )
    } catch {
      // A folder that can't be tidied is left as it is.
    }
  }
}
