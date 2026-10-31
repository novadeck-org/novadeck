import type { Anchors } from "../anchors.ts"
import { sourceFiles } from "../files.ts"
import type { LensInput } from "../lens-input.ts"
import { routerFile, runnerDir, servicesOf, type Service } from "../runner-services.ts"
import { unitsIn, type Unit } from "./units.ts"

export const storeFile = "backend/runner/src/workspaces/store.ts"

// What every part of the runner lens reads from: the router, the services it hands calls
// to, and every runner unit but the store's, to follow a call a hop or two in.
export type RunnerScan = {
  anchors: Anchors
  router: string
  services: Service[]
  // The runner's source files, the store's apart.
  files: string[]
  unitsByFile: Map<string, Unit[]>
}

export const scanRunner = ({ repo, anchors }: LensInput): RunnerScan => {
  const router = anchors.read(routerFile) ?? ""
  const files = sourceFiles(repo, runnerDir).filter((file) => file !== storeFile)
  return {
    anchors,
    router,
    services: servicesOf(anchors, router),
    files,
    unitsByFile: new Map(files.map((file) => [file, unitsIn(file, anchors.read(file) ?? "")])),
  }
}
