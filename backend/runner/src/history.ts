import type { ClosedTerminal, HistoryChange } from "@novadeck/protocol"

/** What the router needs of History: a project's closed terminals, and a stream of changes. */
export type History = {
  /** A project's closed terminals, newest first, each with its availability as of now. */
  list(projectId: string): Promise<ClosedTerminal[]>
  /**
   * Every closed terminal, then `synced`, then each later change, until `signal` aborts;
   * `ownerId` is the session following.
   */
  watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<HistoryChange>
}
