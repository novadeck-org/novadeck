import { randomUUID } from "node:crypto"
import { isAbsolute, basename, relative, resolve, sep } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type {
  AgentName,
  CompanionChange,
  CompanionItem,
  CompanionWindow,
  ItemContent,
} from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { PlanSource } from "../harnesses/events.js"
import { agentLabel } from "../messaging/mailbox.js"
import { Watcher } from "../terminals/watcher.js"
import {
  hashOf,
  loadFile,
  loadPlan,
  maxImageBytes,
  pageAt,
  planTitle,
  pointAt,
  probe,
  type PlanText,
  type Pointed,
} from "./content.js"
import type { ItemRecord, ItemRecords, WindowRecord } from "./records.js"
import { failure, type PresentAnswer, type PresentRequest } from "./request.js"

/** A terminal items are shown in or placed on: where it is, and how agents address it. */
export type TerminalPlace = {
  readonly terminalId: string
  readonly sessionId: string
  readonly handle: string
  /** Its shell's directory, which a relative path is read from. */
  readonly cwd: string
  /** The folder of its session's project, which names the files shown from it. */
  readonly project: string | undefined
}

/** Whose plan a plan item mirrors: an agent session's root, or one of its subagents. */
export type PlanSlot = {
  readonly agent: AgentName
  readonly agentSession: string
  readonly actor: string | null
}

export type CompanionOptions = {
  readonly records: ItemRecords
  /** A terminal the runner keeps, running or saved; undefined once it is closed. */
  readonly terminal: (terminalId: string) => TerminalPlace | undefined
  /**
   * What the terminal a text plan came from has of it live, while it still runs that
   * plan's session: read before its transcript or rollout, never instead of it.
   */
  readonly livePlan?: (item: ItemRecord) => PlanText | undefined
  /** How often `content` looks at what an item points at, in milliseconds. */
  readonly pollMs?: number
}

/** What an item points at, and what it says of it, before it is kept. */
type Pointer = Pick<
  ItemRecord,
  "pointerKey" | "kind" | "path" | "url" | "lines" | "plan" | "name" | "detail" | "held"
>

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`

const size = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Whether `path` lies inside `folder`; both resolved alike. */
const inside = (folder: string, path: string): boolean => {
  const route = relative(folder, path)
  return route !== "" && !isAbsolute(route) && route.split(sep)[0] !== ".."
}

const planKey = (slot: Pick<PlanSlot, "agentSession" | "actor">): string =>
  `plan:${slot.agentSession}:${slot.actor ?? ""}`

/** A window's title by default: its item's name, as one line a title may be. */
const defaultTitle = (name: string): string => {
  // eslint-disable-next-line no-control-regex -- These are the characters a title refuses.
  const line = name.replaceAll(/[\x00-\x1f\x7f]/g, " ").trim()
  return [...line].slice(0, 200).join("").trim() || "Window"
}

/** An item as clients see it. */
export const wireItem = (item: ItemRecord): CompanionItem => ({
  id: item.id,
  sessionId: item.sessionId,
  holder: item.windowId === null ? { terminalId: item.terminalId! } : { windowId: item.windowId },
  kind: item.kind,
  name: item.name,
  detail: item.detail,
  path: item.path,
  url: item.url,
  lines: item.lines && { ...item.lines },
  held: item.held,
  by: item.by,
  from: { ...item.from },
  version: item.version,
  asked: item.asked,
  shownAt: item.shownAt,
  plan: item.plan && {
    agent: item.plan.agent,
    role: item.plan.actor === null ? "root" : "subagent",
    source: item.plan.format,
  },
})

/** A window as clients see it. */
export const wireWindow = (window: WindowRecord): CompanionWindow => ({
  id: window.id,
  sessionId: window.sessionId,
  itemId: window.itemId,
  title: window.personTitle ?? defaultTitle(window.itemName),
  titleSource: window.personTitle === null ? { kind: "default" } : { kind: "person" },
})

/** What a content reader compares to tell whether to yield again. */
const keyOf = (content: ItemContent): string =>
  content.state === "ready" ? `ready:${content.stamp}` : `${content.reason}:${content.size}`

/**
 * What agents show and the person attaches beside terminals, kept as pointers: each item
 * is held by one terminal's bar or one undocked window, survives restarts, and goes when
 * it is closed, with its holder, or with its session. An agent's show lands on its own
 * bar, updating what it showed there before; plans mirror each agent session's latest
 * plans on the bar of the terminal they run in. Content is read from disk as it loads.
 */
export class CompanionItems {
  private readonly records: ItemRecords
  private readonly pollMs: number
  /** Each `watch` stream and the owner whose release ends it. */
  private readonly watchers = new Map<Watcher<string, CompanionChange>, string>()
  /** Each item's `content` readers, which end once it is deleted. */
  private readonly readers = new Map<string, Set<AbortController>>()
  /**
   * The agent session each terminal bound last, in this runner's lifetime: a plan of
   * another one, observed while it bound, is not mirrored on its bar.
   */
  private readonly bound = new Map<string, string>()
  /** Plan observations, one after another, so two never add the same slot twice. */
  private observing: Promise<void> = Promise.resolve()
  private stopping = false

  constructor(private readonly options: CompanionOptions) {
    this.records = options.records
    this.pollMs = options.pollMs ?? 500
  }

  /**
   * Shows what an agent asked to, on its own terminal's bar: a file any path reaches, as
   * a viewer would, or an http(s) page. Showing the same again updates it, with a later
   * version; an item moved elsewhere is never touched. It opens when the agent says the
   * person asked, unless it may hold secrets.
   */
  async show(place: TerminalPlace, request: PresentRequest): Promise<PresentAnswer> {
    if (this.stopping) return failure("NovaDeck is closing.")
    const pointed = await this.pointer(place, request)
    if (!pointed.ok) return pointed
    const { pointer, tooLarge } = pointed
    const asked = request.open === true && !pointer.held
    let kept: ReturnType<CompanionItems["keep"]>
    try {
      kept = this.keep(place, pointer, { by: "agent", asked })
    } catch (error) {
      // Its terminal went while the file was looked at; anything else is worth a word.
      if (!(error instanceof DomainError && error.code === "TERMINAL_NOT_FOUND"))
        console.error("NovaDeck could not keep an item beside its terminal:", error)
      kept = undefined
    }
    if (!kept) return failure("NovaDeck couldn't show it.")
    return {
      ok: true,
      id: kept.item.id,
      kind: kept.item.kind,
      name: kept.item.name,
      opened: asked,
      again: kept.again,
      ...(pointer.held && { held: true }),
      ...(tooLarge && { tooLarge: true }),
    }
  }

  /**
   * Attaches a file the person picked to a terminal's bar, as an agent's show would, by
   * a path from the terminal's directory. TERMINAL_NOT_FOUND for a terminal not kept,
   * INVALID_FILE, saying why, for a path that is no file.
   */
  async attach(input: {
    readonly terminalId: string
    readonly path: string
    readonly lines?: { readonly from: number; readonly to: number } | undefined
    readonly title?: string | undefined
  }): Promise<CompanionItem> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const place = this.place(input.terminalId)
    const pointed = await this.pointer(place, {
      path: input.path,
      ...(input.lines && { lines: input.lines }),
      ...(input.title !== undefined && { title: input.title }),
    })
    if (!pointed.ok) throw new DomainError("INVALID_FILE", pointed.reason)
    const kept = this.keep(this.place(input.terminalId), pointed.pointer, {
      by: "person",
      asked: false,
    })
    if (!kept) throw new DomainError("TERMINAL_NOT_FOUND")
    return wireItem(kept.item)
  }

  /**
   * What a terminal's bar holds, as its agent reads it through `showing`: each item with
   * where it points, and who put it there.
   */
  listing(terminalId: string): string {
    const items = this.records.barItems(terminalId)
    if (items.length === 0) return "Nothing is showing beside your terminal in NovaDeck."
    const lines = items.map((item) => {
      const own = item.from.terminalId === terminalId
      const range = item.lines ? ` lines ${item.lines.from}–${item.lines.to}` : ""
      const where = item.url ?? item.path ?? ""
      const placed = own ? undefined : `placed here from ${item.from.handle}`
      const whose =
        item.kind === "plan"
          ? own
            ? "your plan"
            : "its agent's plan"
          : item.by === "agent"
            ? own
              ? "shown by you"
              : "shown by its agent"
            : "attached by the user"
      const notes = [placed, whose].filter(Boolean).join(", ")
      const secrets = item.held ? "; may hold secrets" : ""
      const name = `${item.kind} ${JSON.stringify(item.name)}${range}`
      // A plan it presents as text is in its own conversation.
      if (own && item.plan?.format === "text") return `- ${name} (in your conversation)`
      return `- ${name}: ${where} (${notes}${secrets})`
    })
    return [`Showing beside your terminal in NovaDeck (${items.length}):`, ...lines].join("\n")
  }

  /**
   * Moves an item onto a terminal's bar of its session, from a bar or a window, which
   * goes with it; what that bar held under the same pointer is replaced.
   */
  move(itemId: string, terminalId: string): CompanionItem {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const item = this.item(itemId)
    const place = this.place(terminalId)
    if (place.sessionId !== item.sessionId)
      throw new DomainError("CONFLICT", "The item belongs to another session.")
    if (item.terminalId === terminalId) return wireItem(item)
    const { item: moved, left, replaced } = this.records.dockItem(itemId, terminalId)
    if (replaced) this.removed(replaced, undefined)
    this.changed(moved)
    if (left) this.windowRemoved(left)
    return wireItem(moved)
  }

  /** Moves an item into a new window the client names; a taken id is a CONFLICT. */
  undock(itemId: string, windowId: string): CompanionWindow {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    this.item(itemId)
    if (this.options.terminal(windowId))
      throw new DomainError("CONFLICT", "Window id is already taken")
    const { item, left } = this.records.undockItem(itemId, { id: windowId, createdAt: Date.now() })
    const window = this.records.window(windowId)!
    this.windowChanged(window)
    this.changed(item)
    if (left) this.windowRemoved(left)
    return wireWindow(window)
  }

  /** Deletes an item and the window holding it; one already gone is let be. */
  close(itemId: string): void {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const removed = this.records.removeItem(itemId)
    if (removed) this.removed(removed.item, removed.window)
  }

  /** Gives a window the person's title, or with null its item's name again. */
  renameWindow(windowId: string, title: string | null): void {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    if (!this.records.renameWindow(windowId, title)) throw new DomainError("NOT_FOUND")
    const window = this.records.window(windowId)
    if (window) this.windowChanged(window)
  }

  /** A session's items and windows. */
  list(sessionId: string): { items: CompanionItem[]; windows: CompanionWindow[] } {
    return {
      items: this.records.items(sessionId).map(wireItem),
      windows: this.records.windows(sessionId).map(wireWindow),
    }
  }

  /** The items a terminal's bar holds, oldest shown first. */
  bar(terminalId: string): CompanionItem[] {
    return this.records.barItems(terminalId).map(wireItem)
  }

  /**
   * Every window and item across sessions, `synced`, then later changes, until `signal`
   * aborts, the owner is released or the runner shuts down.
   */
  async *watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<CompanionChange> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const watcher = new Watcher<string, CompanionChange>(
      [
        ...this.records
          .windows()
          .map(
            (window) =>
              [`window:${window.id}`, { type: "window", window: wireWindow(window) }] as const,
          ),
        ...this.records
          .items()
          .map((item) => [`item:${item.id}`, { type: "item", item: wireItem(item) }] as const),
      ],
      { type: "synced" },
    )
    this.watchers.set(watcher, ownerId)
    const abort = () => watcher.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) watcher.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Changes are delivered in order.
        const change = await watcher.next()
        if (change === undefined) return
        yield change
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      watcher.finish()
      this.watchers.delete(watcher)
    }
  }

  /** Ends the watch streams of an owner, as its connection goes. */
  release(ownerId: string): void {
    for (const [watcher, owner] of this.watchers) if (owner === ownerId) watcher.finish()
  }

  /** What an item points at, read now; NOT_FOUND for one not kept. */
  async load(itemId: string, reveal: boolean): Promise<ItemContent> {
    const item = this.item(itemId)
    return this.read(item, reveal, this.live(item))
  }

  /**
   * What an item points at, read now, then again each time it changes, until it is
   * deleted or `signal` aborts. A file that may hold secrets is `held` unless `reveal`.
   */
  async *content(
    itemId: string,
    reveal: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<ItemContent> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    this.item(itemId)
    const reader = new AbortController()
    const readers = this.readers.get(itemId) ?? new Set()
    this.readers.set(itemId, readers.add(reader))
    const abort = () => reader.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) reader.abort()
    try {
      let probed: string | undefined
      let sent: string | undefined
      while (!reader.signal.aborted) {
        const item = this.records.item(itemId)
        if (!item) return
        const live = this.live(item)
        const lines = item.lines ? `${item.lines.from}-${item.lines.to}` : ""
        // eslint-disable-next-line no-await-in-loop -- Each look follows the one before.
        const now = `${item.version}|${item.path}|${lines}|${await probe(item, live)}`
        if (now !== probed) {
          // eslint-disable-next-line no-await-in-loop -- As above.
          const content = await this.read(item, reveal, live)
          if (reader.signal.aborted) return
          probed = now
          const key = `${item.version}|${keyOf(content)}`
          if (key !== sent) {
            sent = key
            yield content
          }
        }
        // eslint-disable-next-line no-await-in-loop -- As above.
        await sleep(this.pollMs, undefined, { signal: reader.signal }).catch(() => {})
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.abort()
      readers.delete(reader)
      if (readers.size === 0 && this.readers.get(itemId) === readers) this.readers.delete(itemId)
    }
  }

  /**
   * An agent session's plan, as its terminal observed it: the item mirroring that slot
   * on the terminal's own bar is pointed at it and renamed, with a later version only
   * when the observation is newer than the one it holds, so a replay marks nothing new.
   * Without one there, as when it was moved away or the plan is new, one is added,
   * unless one elsewhere already holds this observation. `path` is the plan's file, or
   * for one presented as text, the transcript or rollout recording it.
   */
  planObserved(
    place: TerminalPlace,
    slot: PlanSlot,
    plan: { readonly source: PlanSource; readonly path: string },
    at: number,
  ): Promise<void> {
    const observed = this.observing.then(() => this.observe(place, slot, plan, at))
    this.observing = observed.catch((error: unknown) => {
      console.error("NovaDeck could not keep a plan beside its terminal:", error)
    })
    return this.observing
  }

  /**
   * A terminal's agent session is now `agentSession`: the plans its own bar mirrored of
   * other sessions go. Those placed here from elsewhere, and those moved away, stay.
   */
  sessionBound(terminalId: string, agentSession: string): void {
    if (this.stopping) return
    this.bound.set(terminalId, agentSession)
    for (const item of this.records.barItems(terminalId))
      if (
        item.plan !== null &&
        item.from.terminalId === terminalId &&
        item.plan.session !== agentSession
      )
        this.delete(item.id)
  }

  /** A terminal is closed: the items on its bar go with it. Windows stay. */
  terminalClosed(terminalId: string): void {
    if (this.stopping) return
    this.bound.delete(terminalId)
    for (const item of this.records.barItems(terminalId)) this.delete(item.id)
  }

  /**
   * Sessions are being deleted with their project: every item and window they still keep
   * goes, as closing it would, so watchers hear of each and its content readers end. Their
   * terminals closed first, which already took their bars' items and what each bound.
   */
  sessionsRemoved(sessionIds: readonly string[]): void {
    if (this.stopping) return
    for (const sessionId of sessionIds)
      for (const item of this.records.items(sessionId)) this.delete(item.id)
  }

  /** Ends every stream; nothing changes afterwards. */
  shutdown(): void {
    this.stopping = true
    for (const watcher of this.watchers.keys()) watcher.finish()
    for (const readers of this.readers.values()) for (const reader of readers) reader.abort()
  }

  private async observe(
    place: TerminalPlace,
    slot: PlanSlot,
    plan: { readonly source: PlanSource; readonly path: string },
    at: number,
  ): Promise<void> {
    const title = await planTitle(plan.source)
    if (this.stopping || !this.options.terminal(place.terminalId)) return
    // Another session bound there meanwhile: this plan is no longer its terminal's.
    const bound = this.bound.get(place.terminalId)
    if (bound !== undefined && bound !== slot.agentSession) return
    const key = planKey(slot)
    const format = plan.source.kind
    const pointer: Pointer = {
      pointerKey: key,
      kind: "plan",
      path: plan.path,
      url: null,
      lines: null,
      plan: { agent: slot.agent, session: slot.agentSession, actor: slot.actor, format },
      name: clip(title ?? `${agentLabel(slot.agent)} plan`, 256),
      detail: clip(
        format === "file" ? plan.path : `In ${agentLabel(slot.agent)}'s conversation`,
        512,
      ),
      held: false,
    }
    const own = this.records.barItems(place.terminalId).find((item) => item.pointerKey === key)
    if (own) {
      // An older observation, as a replay, changes nothing it already has.
      if (own.observedAt !== null && at <= own.observedAt) {
        if (own.path === null) this.save({ ...own, path: pointer.path })
        return
      }
      this.save({
        ...own,
        ...pointer,
        version: own.version + 1,
        shownAt: Date.now(),
        observedAt: at,
      })
      return
    }
    // A replay of what an item moved away already holds, as after a restart, adds nothing.
    const kept = this.records.itemsAt(place.sessionId, key)
    if (kept.some((item) => item.observedAt !== null && item.observedAt >= at)) return
    this.save({
      ...pointer,
      id: randomUUID(),
      sessionId: place.sessionId,
      terminalId: place.terminalId,
      windowId: null,
      by: "agent",
      from: { terminalId: place.terminalId, handle: place.handle },
      version: 1,
      asked: false,
      shownAt: Date.now(),
      observedAt: at,
    })
  }

  /** What a request points at, or why it can't be an item. */
  private async pointer(
    place: TerminalPlace,
    request: PresentRequest,
  ): Promise<
    | { readonly ok: true; readonly pointer: Pointer; readonly tooLarge: boolean }
    | { readonly ok: false; readonly reason: string }
  > {
    if ("url" in request) {
      const page = pageAt(request.url)
      if (!page.ok) return page
      const { href, host } = page.url
      return {
        ok: true,
        tooLarge: false,
        pointer: {
          pointerKey: href,
          kind: "page",
          path: null,
          url: href,
          lines: null,
          plan: null,
          name: clip(request.title ?? host, 256),
          detail: clip(href, 512),
          held: false,
        },
      }
    }
    const pointed = await pointAt(request.path, place.cwd)
    if (!pointed.ok) return pointed
    // A held file goes by its own name, so the person sees what they would open.
    const name = pointed.held
      ? basename(pointed.path)
      : (request.title ?? basename(resolve(place.cwd, request.path)))
    return {
      ok: true,
      tooLarge: pointed.kind === "image" && pointed.size > maxImageBytes,
      pointer: {
        pointerKey: pointed.path,
        kind: pointed.kind,
        path: pointed.path,
        url: null,
        lines: request.lines ?? null,
        plan: null,
        name: clip(name, 256),
        detail: this.detail(pointed, place, request.path, request.lines),
        held: pointed.held,
      },
    }
  }

  /** How a file is described: an image by its size and format, a text file by its path and lines. */
  private detail(
    pointed: Pointed,
    place: TerminalPlace,
    given: string,
    lines: { readonly from: number; readonly to: number } | undefined,
  ): string {
    if (pointed.kind === "image") {
      const format = pointed.path.split(".").at(-1)!.toUpperCase().replace("JPG", "JPEG")
      return `${size(pointed.size)} ${format}`
    }
    const { project } = place
    const shown = project && inside(project, pointed.path) ? relative(project, pointed.path) : given
    const range = lines ? ` · lines ${lines.from}–${lines.to}` : ""
    return `${clip(shown, 512 - range.length)}${range}`
  }

  /**
   * Keeps a pointer on a terminal's own bar: updating the item it holds under it, or
   * adding one. Undefined once the terminal is gone; TERMINAL_NOT_FOUND once its record
   * is, and any other failure to keep it as it is.
   */
  private keep(
    place: TerminalPlace,
    pointer: Pointer,
    origin: { readonly by: ItemRecord["by"]; readonly asked: boolean },
  ): { item: ItemRecord; again: boolean } | undefined {
    if (this.stopping || !this.options.terminal(place.terminalId)) return undefined
    const own = this.records
      .barItems(place.terminalId)
      .find((item) => item.pointerKey === pointer.pointerKey)
    const item: ItemRecord = own
      ? { ...own, ...pointer, version: own.version + 1, asked: origin.asked, shownAt: Date.now() }
      : {
          ...pointer,
          id: randomUUID(),
          sessionId: place.sessionId,
          terminalId: place.terminalId,
          windowId: null,
          by: origin.by,
          from: { terminalId: place.terminalId, handle: place.handle },
          version: 1,
          asked: origin.asked,
          shownAt: Date.now(),
          observedAt: null,
        }
    this.save(item)
    return { item, again: own !== undefined }
  }

  private save(item: ItemRecord): void {
    this.records.saveItem(item)
    this.changed(item)
  }

  private delete(itemId: string): void {
    const removed = this.records.removeItem(itemId)
    if (removed) this.removed(removed.item, removed.window)
  }

  private item(itemId: string): ItemRecord {
    const item = this.records.item(itemId)
    if (!item) throw new DomainError("NOT_FOUND", "Item not found")
    return item
  }

  private place(terminalId: string): TerminalPlace {
    const place = this.options.terminal(terminalId)
    if (!place) throw new DomainError("TERMINAL_NOT_FOUND")
    return place
  }

  private live(item: ItemRecord): PlanText | undefined {
    return item.plan?.format === "text" ? this.options.livePlan?.(item) : undefined
  }

  private read(
    item: ItemRecord,
    reveal: boolean,
    live: PlanText | undefined,
  ): Promise<ItemContent> {
    if (item.kind === "page")
      return Promise.resolve({
        state: "ready",
        stamp: hashOf(item.url ?? ""),
        content: { kind: "page", url: item.url ?? "" },
      })
    if (item.kind === "plan") return loadPlan(item, live)
    return loadFile(item, reveal)
  }

  private changed(item: ItemRecord): void {
    this.emit(`item:${item.id}`, { type: "item", item: wireItem(item) }, false)
  }

  private removed(item: ItemRecord, window: WindowRecord | undefined): void {
    for (const reader of this.readers.get(item.id) ?? []) reader.abort()
    this.emit(
      `item:${item.id}`,
      { type: "itemRemoved", itemId: item.id, sessionId: item.sessionId },
      true,
    )
    if (window) this.windowRemoved(window)
  }

  private windowChanged(window: WindowRecord): void {
    this.emit(`window:${window.id}`, { type: "window", window: wireWindow(window) }, false)
  }

  private windowRemoved(window: Pick<WindowRecord, "id" | "sessionId">): void {
    this.emit(
      `window:${window.id}`,
      { type: "windowRemoved", windowId: window.id, sessionId: window.sessionId },
      true,
    )
  }

  private emit(key: string, change: CompanionChange, removal: boolean): void {
    for (const watcher of this.watchers.keys())
      if (removal) watcher.removed(key, change)
      else watcher.changed(key, change)
  }
}
