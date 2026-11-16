import type { Conversation } from "../conversation"

// Why a conversation with nothing to show is not known to be empty:
// - `lost`: the runner can't find or read the session's record;
// - `unread`: the record holds lines Novadeck couldn't make anything of;
// - `turned`: the agent has had a turn in this session, and the record gave nothing for it;
// - `screen`: something of the agent's own is on its screen, or what is there can't be told.
export type Unproven = "lost" | "unread" | "turned" | "screen"

// What a conversation with no items is. `empty` is a claim, made only from what the runner
// said: the record was read to its end and holds nothing it couldn't read (or isn't there yet),
// no turn was seen, and the agent sits at its idle, empty box. Anything else that isn't still
// being read is `unproven`, as a false `empty` hides a conversation or a dialog that is there,
// where a false `unproven` only shows the agent's own screen.
export type Emptiness =
  | { readonly state: "loading" }
  | { readonly state: "empty" }
  | { readonly state: "unproven"; readonly reason: Unproven }

export const emptiness = ({
  loaded,
  records,
  rest,
  turned,
}: Pick<Conversation, "loaded" | "records" | "rest" | "turned">): Emptiness => {
  if (!loaded) return { state: "loading" }
  // Read to an end, or a record not there yet, is what an empty one looks like. Items arriving
  // while it is `reading` loaded it too, but then there is nothing empty to tell.
  if (records.state !== "read" && records.state !== "absent")
    return { state: "unproven", reason: "lost" }
  if (records.state === "read" && records.unread > 0) return { state: "unproven", reason: "unread" }
  if (turned) return { state: "unproven", reason: "turned" }
  if (rest === null) return { state: "loading" }
  return rest ? { state: "empty" } : { state: "unproven", reason: "screen" }
}
