import { maxVoiceSeconds, voiceSampleRate } from "@novadeck/protocol"

import { DomainError } from "../errors.js"

/** The most audio a clip holds, in bytes. */
export const maxClipBytes = maxVoiceSeconds * voiceSampleRate * 2

/** The most clips one connection records at once, and all connections together. */
export const maxClipsPerOwner = 4
export const maxClips = 16

// How long a clip nobody transcribes stays: its person stopped, or went away.
const keepMs = 5 * 60 * 1000

// A clip is kept in pages that exist once written, so a part costs what it covers and
// neither many parts nor one far from the start copy or allocate the whole clip.
const pageBytes = 64 * 1024

type Clip = {
  readonly owner: string
  readonly pages: Map<number, Buffer>
  length: number
  at: number
}

/**
 * Clips being recorded, in memory, by owner and name: audio arrives in parts at the byte
 * offset each says, so a part sent again overwrites itself. Clips untouched for five
 * minutes are forgotten whenever another is written, and an owner's go when it does.
 */
export class Clips {
  private readonly clips = new Map<string, Clip>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether the clip is new, so the first part can start the engine warming up. */
  write(owner: string, id: string, offset: number, bytes: Uint8Array): boolean {
    this.sweep()
    if (offset + bytes.length > maxClipBytes) throw new DomainError("UPLOAD_TOO_LARGE")
    const key = this.key(owner, id)
    const existing = this.clips.get(key)
    // A clip begins at its start: a later part of one the runner doesn't have means its
    // beginning went with a dropped connection, and the rest alone would mislead.
    if (existing === undefined && offset !== 0)
      throw new DomainError("NOT_FOUND", "The start of this recording was lost.")
    if (existing === undefined) this.admit(owner)
    const clip = existing ?? { owner, pages: new Map(), length: 0, at: 0 }
    for (let done = 0; done < bytes.length;) {
      const at = offset + done
      const index = Math.floor(at / pageBytes)
      const inside = at - index * pageBytes
      const size = Math.min(pageBytes - inside, bytes.length - done)
      let page = clip.pages.get(index)
      if (page === undefined) {
        page = Buffer.alloc(pageBytes)
        clip.pages.set(index, page)
      }
      page.set(bytes.subarray(done, done + size), inside)
      done += size
    }
    clip.length = Math.max(clip.length, offset + bytes.length)
    clip.at = this.now()
    this.clips.set(key, clip)
    return existing === undefined
  }

  /** The clip's audio, or `undefined` for one not kept. A gap, from a part that went missing, is silence. */
  get(owner: string, id: string): Buffer | undefined {
    const clip = this.clips.get(this.key(owner, id))
    if (clip === undefined) return undefined
    const pcm = Buffer.alloc(clip.length)
    for (const [index, page] of clip.pages) {
      const start = index * pageBytes
      if (start < clip.length) page.copy(pcm, start, 0, Math.min(pageBytes, clip.length - start))
    }
    return pcm
  }

  /** How many clips are kept. */
  get size(): number {
    return this.clips.size
  }

  discard(owner: string, id: string): void {
    this.clips.delete(this.key(owner, id))
  }

  /** Forgets everything an owner recorded, as its connection goes. */
  release(owner: string): void {
    for (const [key, clip] of this.clips) if (clip.owner === owner) this.clips.delete(key)
  }

  private admit(owner: string): void {
    let mine = 0
    for (const clip of this.clips.values()) if (clip.owner === owner) mine += 1
    if (mine >= maxClipsPerOwner || this.clips.size >= maxClips)
      throw new DomainError("RESOURCE_LIMIT", "Too many recordings at once.")
  }

  // Owners are connection ids and clips ids a client chose, so the pair names a clip and
  // one connection never reaches another's.
  private key(owner: string, id: string): string {
    return `${owner}\n${id}`
  }

  private sweep(): void {
    const now = this.now()
    for (const [key, clip] of this.clips) if (now - clip.at > keepMs) this.clips.delete(key)
  }
}
