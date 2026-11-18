import type { ProcessTrees } from "@novadeck/terminal/pty"

import type { Messaging } from "../messaging/messaging.js"
import {
  hostPollMs,
  HostLoad,
  renderHost,
  Strain,
  type Agent,
  type HostReading,
  type Load,
} from "./host-load.js"
import { readHost, readProcesses, type Processes } from "./host-reading.js"
import { waitingOf } from "./peers-host.js"
import type { Record } from "./record.js"

/** What the watch reads of a terminal's record. */
export type WatchedRecord = Pick<Record, "summary" | "bound"> & {
  readonly terminal: { readonly exit: unknown; readonly exiting: boolean } & {
    readonly pty: { readonly pid: number | undefined }
  }
}

export type HostWatchHost = {
  readonly stopping: () => boolean
  /** Every terminal the runner holds. */
  readonly records: () => Iterable<WatchedRecord>
  readonly trees: () => Pick<ProcessTrees, "read">
  readonly messaging: () => Pick<Messaging, "notice">
}

/** What the watch reads, which tests replace: the host now, and each terminal's processes. */
export type HostReaders = {
  readonly host: () => Promise<HostReading>
  readonly processes: Processes
}

/**
 * The host's CPU and memory, and which terminals' processes use the CPU: read every
 * `pollMs` while a terminal runs an agent (nothing is read while none does), so a listing
 * agents ask for (`listing`) costs no read of its own. When the CPU stays high with two
 * or more of one project and session's agent terminals among the users, each is told, once
 * per strain (`Strain`), through the same notice its lead's news goes by, which every harness
 * delivers alike.
 */
export class HostWatch {
  private timer: ReturnType<typeof setInterval> | undefined
  private reading = false
  private readonly load = new HostLoad()
  private readonly strain = new Strain()

  constructor(
    private readonly host: HostWatchHost,
    private readonly readers: HostReaders = {
      host: () => readHost(process.platform),
      processes: readProcesses(process.platform, () => host.trees()),
    },
    private readonly pollMs = hostPollMs,
  ) {}

  /** Starts reading, which goes on while the runner runs. */
  start(): void {
    if (this.timer || this.host.stopping()) return
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * What a listing for the terminal `callerId` says of the host, given the terminals of its
   * project and session (`peers`); undefined when the load is quiet or no recent reading says.
   */
  readonly listing = (
    callerId: string,
    peers: readonly Pick<Record, "summary">[],
  ): string | undefined => {
    const { current } = this.load
    if (!current || Date.now() - current.at > this.pollMs * 3) return undefined
    return renderHost(
      current,
      new Map(peers.map(({ summary }) => [summary.id, summary.handle])),
      callerId,
    )
  }

  /** One reading and what follows from it. */
  async tick(): Promise<Load | undefined> {
    if (this.reading || this.host.stopping()) return undefined
    const running = [...this.host.records()].filter(
      ({ terminal }) => terminal.exit === null && !terminal.exiting && (terminal.pty.pid ?? 0) > 0,
    )
    const agents = running.filter(({ bound }) => bound !== null)
    if (agents.length === 0) {
      this.load.reset()
      this.strain.reset()
      return undefined
    }
    this.reading = true
    try {
      const [host, processes] = await Promise.all([
        this.readers.host(),
        this.readers.processes(
          new Map(running.map(({ summary, terminal }) => [summary.id, terminal.pty.pid!])),
        ),
      ])
      const load = this.load.ingest(host, processes)
      if (load && !this.host.stopping())
        this.strain.run(
          load,
          agents.map(({ summary, bound }): Agent => ({
            id: summary.id,
            handle: summary.handle,
            sessionId: summary.sessionId,
            waiting: waitingOf(bound?.activity ?? null) !== null,
          })),
          (id, text) => this.host.messaging().notice(id, text),
        )
      return load
    } catch {
      // A reading that failed tells nothing; the next one is read against the last good one.
      return undefined
    } finally {
      this.reading = false
    }
  }
}
