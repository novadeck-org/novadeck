import type { ConnectFailure } from "@novadeck/core/port"

// What the demo fails a boot with, one for each kind of failure, in the words and codes
// the runner adapter gives it (`connectFailure` in @novadeck/runner-adapter).
export const bootFailures: readonly ConnectFailure[] = [
  {
    kind: "transient",
    message: "The runner didn't start.",
    code: "DISCONNECTED",
    detail: "Could not reach the runner.",
  },
  {
    kind: "incompatible",
    update: "app",
    reload: true,
    message: "This page is older than its runner. Reload it to load the newer Novadeck.",
    code: "INCOMPATIBLE_PROTOCOL",
    detail: "The server serves clients from revision 5; this one is 3.",
  },
  {
    kind: "incompatible",
    update: "app",
    message: "This app is older than its runner. Update Novadeck to connect.",
    code: "INCOMPATIBLE_PROTOCOL",
    detail: "The server serves clients from revision 5; this one is 3.",
  },
  {
    kind: "incompatible",
    update: "runner",
    message: "The runner is older than this app. Update Novadeck where the runner runs.",
    code: "INCOMPATIBLE_PROTOCOL",
    detail: "The server is at revision 2; this client works with 4 and later.",
  },
  {
    kind: "outdated",
    message:
      "A newer version of Novadeck has used this workspace. Open the newer Novadeck instead; this copy is out of date.",
    code: "WORKSPACE_TOO_NEW",
    detail: "The workspace database schema is newer than this runner supports",
  },
  {
    kind: "unauthorized",
    message: "The runner didn't accept this app.",
    code: "UNAUTHORIZED",
    detail: "Unauthorized",
  },
  {
    kind: "unknown",
    message: "Something went wrong starting Novadeck.",
    code: "INTERNAL_SERVER_ERROR",
    detail: "Internal server error",
  },
]

// The name the debug panel rehearses a failure by: its code, with the side to update and
// whether a reload mends it where one code reads several ways.
export const failureKey = (failure: ConnectFailure): string =>
  [failure.code, failure.update, failure.reload && "reload"].filter(Boolean).join("/")
