import type { CompanionItem } from "@novadeck/core/companion"
import type { Workspace } from "@novadeck/core/types"

// What a showcase reads of the workspace it reports to.

// The folder of a terminal's project.
export const directoryOf = (
  workspace: Workspace | undefined,
  key: { readonly projectId: string },
): string | undefined =>
  workspace?.projects.find((project) => project.id === key.projectId)?.directory

// Every item the workspace's sessions hold.
export const itemsOf = (workspace: Workspace): readonly CompanionItem[] =>
  workspace.projects.flatMap((project) => project.history.flatMap((each) => each.state.items))
