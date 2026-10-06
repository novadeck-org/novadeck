import type { ConnectFailure } from "../../port"

// What the demo fails a boot with, one for each kind of failure, in the words and codes
// the runner adapter gives it (`connectFailure` in backend/runner).
export const bootFailures: readonly ConnectFailure[] = [
  {
    kind: "transient",
    message: "The runner didn't start.",
    code: "DISCONNECTED",
    detail: "Could not reach the runner.",
  },
  {
    kind: "incompatible",
    message: "This runner is from a different Novadeck version.",
    code: "INCOMPATIBLE_PROTOCOL",
    detail: "Runner speaks protocol 2, this app speaks protocol 1.",
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
