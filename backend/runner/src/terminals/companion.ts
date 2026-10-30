import type { ActivityEvent } from "@novadeck/harness-core/events"
import type { PageTrouble } from "@novadeck/protocol"

import type { PlanText } from "../companions/content.js"
import type { CompanionItems, TerminalPlace } from "../companions/items.js"
import type { ItemRecord } from "../companions/records.js"
import {
  readDismissRequest,
  readLookRequest,
  readRequest,
  type DismissAnswer,
  type PresentAnswer,
} from "../companions/request.js"
import type { Binding } from "../harnesses/bindings.js"
import { harnesses } from "../harnesses/registry.js"
import { unanswered, unansweredCalls, type Call } from "../shell/reports.js"
import type { HintFacts } from "../voice/hint.js"
import { callerOf } from "./callers.js"
import { lookText, lookTroubles, pictureAllowed } from "./looks.js"
import { peerOf, type TerminalPeers } from "./peers.js"
import type { Record } from "./record.js"
import type { SavedTerminal } from "./records.js"
import { itemGone, lookedAt, troubled } from "./troubles.js"

/** What `look` answers: words and the picture, or why there is none. */
export type LookAnswer =
  | {
      readonly ok: true
      readonly text: string
      readonly picture: { readonly data: string; readonly mimeType: "image/jpeg" }
    }
  | { readonly ok: false; readonly reason: string }

export type CompanionHost = {
  /** Every terminal the runner holds, by id. */
  readonly records: () => ReadonlyMap<string, Record>
  /** A kept terminal, running or not, as saved. */
  readonly saved: (terminalId: string) => SavedTerminal | undefined
  /** The folder of the session's project; undefined when that cannot be told. */
  readonly projectFolder: (sessionId: string) => string | undefined
  readonly peers: () => TerminalPeers
  /** The runner is stopping: no plan is mirrored any more. */
  readonly stopping: () => boolean
}

/**
 * What agents show beside their terminals (see `CompanionItems`): what they show, list and
 * close on their own terminal's bar through Novadeck's MCP server, and the plans their
 * sessions keep there; nothing without items.
 */
export class Companion {
  constructor(
    private readonly items: CompanionItems | undefined,
    readonly host: CompanionHost,
  ) {
    items?.listen({
      troubled: (item, troubles) => this.troubled(item, troubles),
      gone: (item) => this.untroubled(item),
    })
  }

  /**
   * The pane told of troubles on a page an agent showed: they wait for the terminal it was
   * shown from, to be told at the person's next prompt there (see `Nudges`).
   */
  private troubled(item: ItemRecord, troubles: readonly PageTrouble[]): void {
    const record = item.from && this.host.records().get(item.from.terminalId)
    // A show made before the terminal's current root session began is not that session's.
    if (!record || item.url === null || item.shownAt < record.nudges.since) return
    const page = { itemId: item.id, version: item.version, name: item.name, url: item.url }
    record.nudges = {
      ...record.nudges,
      troubles: troubled(record.nudges.troubles, page, troubles),
    }
  }

  /** An item is gone or shown again: the troubles held of it go. */
  private untroubled(item: ItemRecord): void {
    const record = item.from && this.host.records().get(item.from.terminalId)
    if (record)
      record.nudges = { ...record.nudges, troubles: itemGone(record.nudges.troubles, item.id) }
  }

  /**
   * Shows the person what an agent asked to, through Novadeck's MCP server in one of
   * the terminal's shells, on the terminal's own bar (see `CompanionItems.show`). A call
   * without the shell's own token learns nothing more.
   */
  async present(call: Call): Promise<PresentAnswer> {
    if (!callerOf(this.host.records(), call)) return unanswered
    const read = readRequest(call.request)
    if (!read.ok) return read
    const place = this.place(call.terminalId)
    if (!place || !this.items) return unanswered
    return this.items.show(place, read.request)
  }

  /**
   * Closes what the caller's agent showed on its own terminal's bar, through Novadeck's
   * MCP server (see `CompanionItems.dismiss`). A call without the shell's own token
   * learns nothing more.
   */
  async dismiss(call: Call): Promise<DismissAnswer> {
    if (!callerOf(this.host.records(), call)) return unansweredCalls.dismiss
    const read = readDismissRequest(call.request)
    if (!read.ok) return read
    const place = this.place(call.terminalId)
    if (!place || !this.items) return unansweredCalls.dismiss
    return this.items.dismiss(place, read.request)
  }

  /**
   * What the caller's own terminal's bar holds, as its agent asked through Novadeck's MCP
   * server.
   */
  showing(call: Call): { ok: true; text: string } | typeof unansweredCalls.showing {
    if (!callerOf(this.host.records(), call)) return unansweredCalls.showing
    if (!this.items) return unansweredCalls.showing
    return { ok: true, text: this.items.listing(call.terminalId) }
  }

  /**
   * Pictures a page on the caller's own terminal's bar for its agent, through Novadeck's
   * MCP server (see `CompanionItems.look`): the picture as an MCP image, and in words the
   * page's name, address, title, how it was taken and its troubles, those the runner holds
   * of the person's pane too, which this look then spends, so the next prompt's notice does
   * not repeat them. A page that moved off this machine since is
   * not pictured. A call without the shell's own token learns nothing more.
   */
  async look(call: Call): Promise<LookAnswer> {
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.look
    const read = readLookRequest(call.request)
    if (!read.ok) return read
    const place = this.place(call.terminalId)
    if (!place || !this.items) return unansweredCalls.look
    const looked = await this.items.look(place, read.request)
    if (!looked.ok) return looked
    const { item, answer } = looked
    if (!pictureAllowed(answer.url))
      return {
        ok: false,
        reason:
          "The page moved on to an address not served from this machine, and look only " +
          "pictures pages you serve here.",
      }
    const entry = record.nudges.troubles.get(item.id)
    const held = entry?.version === item.version && !entry.told ? entry : undefined
    const told = lookTroubles(answer, held)
    // The look tells what was held, and a pane's picture is the show it was held for.
    if (answer.taken === "pane" && held)
      record.nudges = {
        ...record.nudges,
        troubles: lookedAt(record.nudges.troubles, item.id, item.version),
      }
    const base64 = answer.picture.slice(answer.picture.indexOf(",") + 1)
    return {
      ok: true,
      text: lookText(
        item,
        answer,
        told,
        item.by === "agent" && item.from?.terminalId === call.terminalId,
      ),
      picture: { data: base64, mimeType: "image/jpeg" },
    }
  }

  /**
   * Where a terminal kept by the runner is, running or saved, as items shown in it or
   * placed on it need: its session, handle, directory and project folder.
   */
  place(terminalId: string): TerminalPlace | undefined {
    const live = this.host.records().get(terminalId)
    const terminal = live?.summary ?? this.host.saved(terminalId)
    if (!terminal) return undefined
    return {
      terminalId,
      sessionId: terminal.sessionId,
      handle: terminal.handle,
      cwd: terminal.cwd,
      project: this.host.projectFolder(terminal.sessionId),
    }
  }

  /**
   * What a running terminal's dictation hint is made of (see `dictationHint`), but its
   * project's name, with the files shown in its bar. Undefined for a terminal not running
   * here.
   */
  async hintFacts(terminalId: string): Promise<Omit<HintFacts, "project"> | undefined> {
    const records = this.host.records()
    const record = records.get(terminalId)
    if (!record) return undefined
    const facts = await this.host.peers().hint(peerOf(record), this.items?.bar(terminalId) ?? [])
    // The session's open terminals' handles, in the order they were given, so dictation
    // spells them.
    const handles = [...records.values()]
      .filter(({ closed, summary }) => !closed && summary.sessionId === record.summary.sessionId)
      .map(({ summary }) => summary.handle)
    return { ...facts, handles }
  }

  /**
   * A plan presented as text, as the terminal it came from has it live while it still
   * runs the plan's session: the latest its actor presented, and when.
   */
  livePlan(item: ItemRecord): PlanText | undefined {
    const { plan } = item
    const record = item.from && this.host.records().get(item.from.terminalId)
    const { bound } = record ?? {}
    const binding = bound?.binding
    if (!plan || !binding || binding.agent !== plan.agent || binding.sessionId !== plan.session)
      return undefined
    const live = bound?.activity.plans.find(({ actor }) => actor === plan.actor)
    if (live?.source.kind !== "text") return undefined
    return { text: live.source.text, truncated: live.source.truncated, changedAt: live.at }
  }

  /**
   * Mirrors a plan the bound session observed on the terminal's bar: its file, or for one
   * presented as text, the transcript or rollout recording it, which reads it back once
   * the terminal is gone. A text plan with no record to point at is not kept.
   */
  async planned(
    record: Record,
    binding: Binding,
    fact: Extract<ActivityEvent, { type: "plan-observed" }>,
  ): Promise<void> {
    const { items } = this
    const place = this.place(record.summary.id)
    if (!items || !place) return
    const { plan, actor } = fact
    const transcripts = harnesses[binding.agent].transcripts
    const path =
      plan.kind === "file"
        ? plan.path
        : record.transcript && transcripts
          ? await transcripts
              .locate(record.transcript, binding.sessionId, actor)
              .catch(() => undefined)
          : undefined
    if (!path || this.host.stopping()) return
    await items.planObserved(
      place,
      { agent: binding.agent, agentSession: binding.sessionId, actor },
      { source: plan, path },
      fact.startedAt,
    )
  }

  /** A session bound in the terminal: the plans its bar mirrored of another session go. */
  bound(terminalId: string, sessionId: string): void {
    this.items?.sessionBound(terminalId, sessionId)
  }

  /** The terminal is closed: what its agents showed goes. */
  closed(terminalId: string): void {
    this.items?.terminalClosed(terminalId)
  }

  /** The owner is released: what waited on it goes. */
  release(ownerId: string): void {
    this.items?.release(ownerId)
  }

  /** The runner shuts down. */
  shutdown(): void {
    this.items?.shutdown()
  }
}
