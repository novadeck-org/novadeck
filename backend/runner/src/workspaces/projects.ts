import type { Project, TerminalMove, TerminalMoved, WorkspaceSession } from "@novadeck/protocol"

import type { CompanionItems } from "../companions/items.js"
import { DomainError } from "../errors.js"
import type { Terminals } from "../terminals/index.js"
import type { Worktrees } from "../worktrees/worktrees.js"
import type { WorkspaceStore } from "./store.js"

/**
 * Removing projects and sessions, which spans the store, the terminals and their companion
 * items. While a project goes, no session or terminal is created in it, and while a session
 * goes, no terminal is created in that; terminals already being created finish first, so
 * the removal closes them too, before its records are deleted.
 */
export class Projects {
  /** Each project being removed, and its removal. */
  private readonly removing = new Map<string, Promise<void>>()
  /** Each session being removed, and its removal. */
  private readonly removingSessions = new Map<string, Promise<void>>()
  /** Each project's terminals being created, and each session's. */
  private readonly creating = new Map<string, Set<Promise<unknown>>>()

  constructor(
    private readonly store: WorkspaceStore,
    private readonly terminals: Terminals,
    private readonly items: CompanionItems,
    private readonly worktrees?: Pick<Worktrees, "removeProject">,
  ) {}

  /** Every project, in order, but those being removed, which are as good as gone. */
  list(): Project[] {
    return this.store.projects().filter(({ id }) => !this.removing.has(id))
  }

  /** Keeps the person's arrangement; a project being removed is left out, as good as gone. */
  arrange(order: readonly string[], pinned: readonly string[]): void {
    const going = (id: string) => this.removing.has(id)
    this.store.arrangeProjects(
      order.filter((id) => !going(id)),
      pinned.filter((id) => !going(id)),
    )
  }

  /** The project's sessions in the person's order, but those being removed. */
  sessions(projectId: string): WorkspaceSession[] {
    return this.store.sessions(projectId).filter(({ id }) => !this.removingSessions.has(id))
  }

  /** Keeps the person's arrangement of the project's sessions; one being removed is left out. */
  arrangeSessions(projectId: string, order: readonly string[]): void {
    this.store.arrangeSessions(
      projectId,
      order.filter((id) => !this.removingSessions.has(id)),
    )
  }

  /** Moves a terminal and its team to another session of its project. */
  moveTerminal(input: TerminalMove): TerminalMoved {
    return this.terminals.move(input, {
      projectOf: (sessionId) => {
        const { projectId } = this.store.session(sessionId)
        this.ensureNotRemoving(projectId)
        if (this.removingSessions.has(sessionId))
          throw new DomainError("CONFLICT", "The session is being removed.")
        return projectId
      },
    })
  }

  /** Refuses anything new in a project being removed, as `NOT_FOUND`: it is as good as gone. */
  ensureNotRemoving(projectId: string): void {
    if (this.removing.has(projectId)) throw new DomainError("NOT_FOUND", "Project not found")
  }

  /**
   * Runs `work`, which creates a terminal in the session, unless it or its project is being
   * removed; a removal that begins meanwhile waits for it.
   */
  creatingIn<T>(projectId: string, sessionId: string, work: () => Promise<T>): Promise<T> {
    this.ensureNotRemoving(projectId)
    if (this.removingSessions.has(sessionId))
      throw new DomainError("NOT_FOUND", "Session not found")
    const created = work()
    for (const key of [projectId, sessionId]) {
      const pending = this.creating.get(key) ?? new Set()
      this.creating.set(key, pending.add(created))
      const settled = () => {
        pending.delete(created)
        if (pending.size === 0 && this.creating.get(key) === pending) this.creating.delete(key)
      }
      created.then(settled, settled)
    }
    return created
  }

  /**
   * Closes the project's terminals, then deletes it with everything it kept. A second call
   * while it goes shares the first; one after, like one for a project never created, is
   * `NOT_FOUND`.
   */
  remove(projectId: string): Promise<void> {
    const removing = this.removing.get(projectId)
    if (removing) return removing
    this.store.project(projectId)
    const removal = this.removal(projectId).finally(() => this.removing.delete(projectId))
    this.removing.set(projectId, removal)
    return removal
  }

  private async removal(projectId: string): Promise<void> {
    await Promise.allSettled(this.creating.get(projectId) ?? [])
    const sessions = this.store.sessions(projectId).map(({ id }) => id)
    await this.terminals.closeProject(projectId, sessions)
    // Before its rows cascade away: what the agents' worktrees hold is kept on refs first.
    await this.worktrees?.removeProject(projectId)
    // In the same tick as the records go, so nothing new lands in between: watchers hear
    // of each item and window left, as its window outlived its terminal.
    try {
      this.items.sessionsRemoved(sessions)
      this.store.removeProject(projectId)
    } catch (error) {
      // It stays, so terminals may start in it again.
      this.terminals.projectKept(sessions)
      throw error
    }
  }

  /**
   * Closes the session's terminals, keeping each in History, then deletes it with
   * everything it kept. A second call while it goes shares the first; one after, like one
   * for a session never created, is `NOT_FOUND`. The project's last session is a `CONFLICT`.
   */
  removeSession(sessionId: string): Promise<void> {
    const removing = this.removingSessions.get(sessionId)
    if (removing) return removing
    const { projectId } = this.store.session(sessionId)
    this.ensureNotRemoving(projectId)
    if (this.sessions(projectId).length <= 1)
      throw new DomainError("CONFLICT", "A project keeps at least one session")
    const removal = this.sessionRemoval(projectId, sessionId).finally(() =>
      this.removingSessions.delete(sessionId),
    )
    this.removingSessions.set(sessionId, removal)
    return removal
  }

  private async sessionRemoval(projectId: string, sessionId: string): Promise<void> {
    await Promise.allSettled(this.creating.get(sessionId) ?? [])
    await this.terminals.closeProject(projectId, [sessionId], true)
    try {
      this.items.sessionsRemoved([sessionId])
      this.store.removeSession(sessionId)
    } catch (error) {
      // It stays, so terminals may start in it again.
      this.terminals.projectKept([sessionId])
      throw error
    }
  }
}
