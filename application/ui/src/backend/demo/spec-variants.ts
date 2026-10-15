import type { InstallResult } from "../../model/portable"
import type { SandboxState } from "../../model/sandbox"
import type { UpdateOffer } from "../../model/update"
import type { Backend } from "../port"
import { createContentDemo } from "./content"
import { createDemoPortable } from "./debug/portable"
import { createDemoSandbox, sampleFix } from "./debug/sandbox"
import { createDemoUninstall, uninstallScenarios } from "./debug/uninstall"
import { createDemoUpdates, sampleNotes } from "./debug/updates"
import { createDemoBackend } from "./index"
import { visitorDemo } from "./visitor"

// The demo's variants a spec asks for in its address, kept out of the file that chooses
// the backend so the demo stays one folder.

// Specs open the content demo, with its agents' plans and artifacts, by adding
// `?demo=showcase` to the address's hash. The address is read when the workspace
// mounts, since each spec sets its own.
const showcaseRequested = (): boolean =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("demo") === "showcase"

// Specs open the demo on a host that has an update waiting with `?demo=update`, one the
// host can't install itself with `?demo=update-available`, one downloading, then ready,
// with `?demo=update-downloading`, or beside another variant with `&update=ready` or
// `&update=available`.
const requestedUpdate = (): UpdateOffer | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const demo = query.get("demo")
  const kind =
    demo === "update" || query.get("update") === "ready"
      ? "ready"
      : demo === "update-available" || query.get("update") === "available"
        ? "available"
        : demo === "update-downloading"
          ? "downloading"
          : undefined
  // `&outdated=recent` or `&outdated=old` dates when this copy learned of the release,
  // two or twenty days back.
  const outdated = query.get("outdated")
  const days = outdated === "recent" ? 2 : outdated === "old" ? 20 : undefined
  const outdatedSince =
    days === undefined ? undefined : new Date(Date.now() - days * 86_400_000).toISOString()
  return (
    kind && {
      kind,
      version: "0.0.80",
      notes: sampleNotes,
      ...(outdatedSince ? { outdatedSince } : {}),
    }
  )
}

const demoWithUpdate = (update: UpdateOffer): ReturnType<typeof createDemoBackend> => {
  const { updates, offer, download } = createDemoUpdates()
  if (update.kind === "downloading") download(update.version, update.notes)
  else offer(update)
  return { ...createDemoBackend(), updates }
}

// Specs open the demo on a host running without its security sandbox with `?sandbox=off`,
// or `?sandbox=off-unfixed` for one with no command to offer.
const requestedSandbox = (): SandboxState | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  const sandbox = query.get("sandbox")
  if (sandbox === "off") return { sandboxed: false, fix: sampleFix }
  if (sandbox === "off-unfixed") return { sandboxed: false, fix: "" }
  return undefined
}

// Specs open the demo on a portable copy with `?portable=on`, and choose how installing
// ends with `&install=newer` or `&install=failed`; it never ends otherwise.
const requestedInstall = (): InstallResult | undefined => {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "")
  if (query.get("portable") !== "on") return undefined
  const install = query.get("install")
  if (install === "newer") return { kind: "newer", version: "0.0.99" }
  if (install === "failed") return { kind: "failed", reason: "There is no space left." }
  return { kind: "installing" }
}

// Specs open the demo on a host that offers uninstalling with `?uninstall=` one of the
// debug panel's scenarios (see backend/demo/debug/uninstall.ts).
const requestedUninstall = (): Backend["uninstall"] => {
  const name = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("uninstall")
  return name && name in uninstallScenarios
    ? createDemoUninstall(uninstallScenarios[name as keyof typeof uninstallScenarios]).uninstall
    : undefined
}

// `&answer=late` makes the host take 4 seconds to say it is a portable copy.
const answerDelay = (): number =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("answer") === "late" ? 4000 : 0

// `&version=dev` makes the host a development build, which carries 0.0.0, and
// `&version=none` one that gives no version.
const requestedVersion = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  const version = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("version")
  if (version === "dev") return { ...backend, version: () => Promise.resolve("0.0.0") }
  if (version !== "none") return backend
  const { version: _given, ...rest } = backend
  return rest
}

// Specs open the demo as a visitor's, with `?visitor=on`: what the app shows for one.
const visitorRequested = (): boolean =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("visitor") === "on"

// The demo a spec opens, as its address's hash asks.
export const createSpecBackend = (): ReturnType<typeof createDemoBackend> => {
  if (visitorRequested()) return visitorDemo()
  if (showcaseRequested()) return createContentDemo()
  const update = requestedUpdate()
  const sandbox = requestedSandbox()
  const install = requestedInstall()
  const demo = requestedVersion(update ? demoWithUpdate(update) : createDemoBackend())
  const uninstall = requestedUninstall()
  const withSandbox = sandbox ? { ...demo, sandbox: createDemoSandbox(sandbox) } : demo
  const withUninstall = uninstall ? { ...withSandbox, uninstall } : withSandbox
  return install
    ? {
        ...withUninstall,
        portable: createDemoPortable({ install, answerAfterMs: answerDelay() }).portable,
      }
    : withUninstall
}
