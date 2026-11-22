import type { Project, ProjectsChange } from "@novadeck/protocol"
import { KeyedChanges } from "@novadeck/wire/server"

const key = "projects"

/**
 * The projects as they change, for the clients that share them (`projects.watch`): the whole
 * list, in the person's order with each one's pin, first and again after each change. A
 * reader slower than the changes gets the latest list only. The list is short and changes
 * seldom, so it goes whole, its order and pins exact.
 */
export class ProjectFeed {
  private readonly readers = new Set<KeyedChanges<string, ProjectsChange>>()

  constructor(private readonly list: () => readonly Project[]) {}

  /** Tells every reader the projects as they are now. */
  changed(): void {
    if (this.readers.size === 0) return
    const change: ProjectsChange = { type: "projects", projects: [...this.list()] }
    for (const reader of this.readers) reader.changed(key, change)
  }

  /** One client's stream, until `signal` aborts. */
  async *watch(signal: AbortSignal): AsyncGenerator<ProjectsChange> {
    const reader = new KeyedChanges<string, ProjectsChange>([], {
      type: "projects",
      projects: [...this.list()],
    })
    this.readers.add(reader)
    const stop = () => reader.finish()
    signal.addEventListener("abort", stop, { once: true })
    try {
      while (!signal.aborted) {
        // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal.removeEventListener("abort", stop)
      this.readers.delete(reader)
      reader.finish()
    }
  }
}
