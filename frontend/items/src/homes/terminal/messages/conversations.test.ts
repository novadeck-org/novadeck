import type { AgentMessage, MessageThread, TerminalMail } from "@novadeck/core/messages"

import { context, describe, expect, it } from "../../../test"
import {
  burstMs,
  chatOf,
  conversationsOf,
  cornerOf,
  letterLabel,
  listed,
  openAsks,
  youKey,
  type ChatEntry,
} from "./conversations"

let sequence = 0
const message = (
  from: string,
  to: string,
  sentAt: number,
  text: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage => ({
  id: `m${(sequence += 1)}`,
  hop: 1,
  from,
  to,
  text,
  sentAt,
  state: "delivered",
  held: null,
  deliveredAt: sentAt,
  ...extra,
})

const thread = (id: string, peer: string, messages: readonly AgentMessage[]): MessageThread => ({
  id,
  peer,
  hops: messages.length,
  allowed: 12,
  held: false,
  messages,
})

const mailOf = (...threads: readonly MessageThread[]): TerminalMail => ({
  handle: "moth",
  agent: true,
  threads,
})

const minute = 60_000

describe("a terminal's conversations", () => {
  it("gather the person's letters, a thread each at the runner, into one, oldest first", () => {
    const ask = message("moth", "you", 3 * minute, "Which route?", {
      inbox: "ask",
      inboxState: "answered",
    })
    const answer = message("you", "moth", 4 * minute, "The first.", { inbox: "answer" })
    const tell = message("moth", "you", 1 * minute, "Done.", { inbox: "tell", inboxState: "read" })
    const conversations = conversationsOf(
      mailOf(
        thread("t-a", "you", [ask, answer]),
        thread("t-b", "you", [tell]),
        thread("t-owl", "owl", [message("owl", "moth", 2 * minute, "Hi")]),
      ),
    )
    expect(conversations.map(({ key }) => key)).toEqual([youKey, "owl"])
    const you = conversations[0]!
    expect(you.messages.map(({ text }) => text)).toEqual(["Done.", "Which route?", "The first."])
    expect(you.asked.get(answer.id)?.text).toBe("Which route?")
  })

  it("gather an agent's threads, as the runner starts a new one after a quiet spell, into one", () => {
    const conversations = conversationsOf(
      mailOf(
        thread("t-late", "owl", [message("owl", "moth", 60 * minute, "After lunch")]),
        thread("t-early", "owl", [message("moth", "owl", 1 * minute, "Morning")]),
      ),
    )
    expect(conversations).toHaveLength(1)
    expect(conversations[0]!.key).toBe("owl")
    expect(conversations[0]!.messages.map(({ text }) => text)).toEqual(["Morning", "After lunch"])
  })

  context("listed", () => {
    it("put the person's letters first while a question or news waits, then latest first", () => {
      const conversations = conversationsOf(
        mailOf(
          thread("t-owl", "owl", [message("owl", "moth", 9 * minute, "Late")]),
          thread("t-fox", "fox", [message("fox", "moth", 5 * minute, "Early")]),
          thread("t-l", "you", [
            message("moth", "you", 1 * minute, "?", { inbox: "ask", inboxState: "open" }),
          ]),
        ),
      )
      expect(listed(conversations).map(({ key }) => key)).toEqual([youKey, "owl", "fox"])
    })

    it("keep the person's letters in time order once nothing in them waits", () => {
      const conversations = conversationsOf(
        mailOf(
          thread("t-owl", "owl", [message("owl", "moth", 9 * minute, "Late")]),
          thread("t-l", "you", [
            message("moth", "you", 1 * minute, "?", { inbox: "tell", inboxState: "read" }),
          ]),
        ),
      )
      expect(listed(conversations).map(({ key }) => key)).toEqual(["owl", youKey])
    })
  })
})

describe("a row's corner", () => {
  const owl = (messages: readonly AgentMessage[]) =>
    conversationsOf(mailOf(thread("t-owl", "owl", messages)))[0]!

  it("says Unread for a message from the agent since the person last looked", () => {
    const conversation = owl([message("owl", "moth", 10 * minute, "News")])
    expect(cornerOf(conversation, 5 * minute)).toEqual({ kind: "unread" })
    expect(cornerOf(conversation, 10 * minute)).toEqual({ kind: "time", at: 10 * minute })
  })

  it("never counts the terminal's own messages as news", () => {
    const conversation = owl([message("moth", "owl", 10 * minute, "Mine")])
    expect(cornerOf(conversation, 0)).toEqual({ kind: "time", at: 10 * minute })
  })

  it("says Not delivered once the last message was lost, over news", () => {
    const conversation = owl([
      message("owl", "moth", 1 * minute, "News"),
      message("moth", "owl", 2 * minute, "Lost", { state: "gone", deliveredAt: null }),
    ])
    expect(cornerOf(conversation, 0)).toEqual({ kind: "undelivered" })
  })

  it("says the person is asked over an unread tell, and Unread for a tell alone", () => {
    const letters = (state: "open" | "answered") =>
      conversationsOf(
        mailOf(
          thread("t-a", "you", [
            message("moth", "you", 1, "?", { inbox: "ask", inboxState: state }),
          ]),
          thread("t-b", "you", [
            message("moth", "you", 2, "!", { inbox: "tell", inboxState: "open" }),
          ]),
        ),
      )[0]!
    expect(cornerOf(letters("open"), Infinity)).toEqual({ kind: "asks" })
    expect(openAsks(letters("open"))).toBe(1)
    expect(cornerOf(letters("answered"), Infinity)).toEqual({ kind: "unread" })
  })
})

describe("a letter's label", () => {
  it.each([
    [{ inbox: "ask", inboxState: "open" }, "Asks you"],
    [{ inbox: "ask", inboxState: "answered" }, "Asked you · answered"],
    [{ inbox: "ask", inboxState: "withdrawn" }, "Asked you · withdrawn"],
    [{ inbox: "ask", inboxState: "gone" }, "Asked you · session ended"],
    [{ inbox: "ask", inboxState: "undelivered" }, "Asked you · reply not delivered"],
    [{ inbox: "tell", inboxState: "open" }, "Tells you"],
    [{ inbox: "tell", inboxState: "read" }, "Told you"],
    [{ inbox: "answer" }, undefined],
  ] as const)("reads %o as %s", (extra, label) => {
    expect(letterLabel(message("moth", "you", 0, "", extra))).toBe(label)
  })
})

describe("a chat", () => {
  const kinds = (entries: readonly ChatEntry[]): string[] =>
    entries.map((entry) =>
      entry.kind === "message"
        ? `${entry.side}${entry.grouped ? "+" : ""}:${entry.message.text}${entry.note ? `(${entry.note})` : ""}`
        : entry.kind === "fold"
          ? `fold ${entry.rounds}`
          : entry.kind,
    )
  const owl = (messages: readonly AgentMessage[]) =>
    conversationsOf(mailOf(thread("t-owl", "owl", messages)))[0]!

  it("says the time where a burst starts, puts the terminal's agent on the right, and Delivered under its last", () => {
    const entries = chatOf(
      owl([
        message("owl", "moth", 0, "a"),
        message("owl", "moth", minute, "b"),
        message("moth", "owl", 2 * minute, "c"),
        message("moth", "owl", 2 * minute + burstMs, "d"),
        message("owl", "moth", 3 * minute + burstMs, "e"),
      ]),
      "moth",
      false,
    )
    expect(kinds(entries)).toEqual([
      "time",
      "in:a",
      "in+:b",
      "out:c",
      "time",
      "out:d(delivered)",
      "in:e",
    ])
  })

  it("notes a message only while on its way, held or lost", () => {
    const entries = chatOf(
      owl([
        message("moth", "owl", 0, "a", { state: "leased", deliveredAt: null }),
        message("moth", "owl", 1, "b", { state: "queued", deliveredAt: null }),
        message("moth", "owl", 2, "c", { state: "held", held: "release", deliveredAt: null }),
        message("owl", "moth", 3, "d", { state: "gone", deliveredAt: null }),
      ]),
      "moth",
      false,
    )
    expect(kinds(entries).slice(1)).toEqual([
      "out:a(leased)",
      "out+:b(queued)",
      "out+:c(queued)",
      "in:d(gone)",
    ])
  })

  it("folds three or more repeated rounds, numbers aside, keeping the last in full", () => {
    const rounds = Array.from({ length: 5 }, (_, round) => [
      message("owl", "moth", round * 2, `Run ${round + 1}: failed.`),
      message("moth", "owl", round * 2 + 1, "Once more."),
    ]).flat()
    const conversation = owl([...rounds, message("owl", "moth", 20, "3 of 10 failed.")])
    expect(kinds(chatOf(conversation, "moth", false))).toEqual([
      "time",
      "fold 4",
      "in:Run 5: failed.",
      "out:Once more.(delivered)",
      "in:3 of 10 failed.",
    ])
    expect(
      kinds(chatOf(conversation, "moth", true)).filter((kind) => kind !== "time"),
    ).toHaveLength(11)
  })

  it("never folds over a message lost or still on its way", () => {
    const rounds = Array.from({ length: 4 }, (_, round) => [
      message("owl", "moth", round * 2, `Run ${round + 1}`, round === 1 ? { state: "gone" } : {}),
      message("moth", "owl", round * 2 + 1, "Again"),
    ]).flat()
    expect(kinds(chatOf(owl(rounds), "moth", false))).toContain("in:Run 2(gone)")
  })

  it("leaves two repeated rounds as they are", () => {
    const conversation = owl([
      message("owl", "moth", 0, "Run 1"),
      message("moth", "owl", 1, "Again"),
      message("owl", "moth", 2, "Run 2"),
      message("moth", "owl", 3, "Again"),
    ])
    expect(kinds(chatOf(conversation, "moth", false))).not.toContain("fold 1")
  })

  it("puts the person on the right in their letters, a New line before the first unread", () => {
    const conversation = conversationsOf(
      mailOf(
        thread("t-a", "you", [
          message("moth", "you", 0, "Tax?", { inbox: "ask", inboxState: "answered" }),
          message("you", "moth", 1, "After.", { inbox: "answer" }),
        ]),
        thread("t-b", "you", [
          message("moth", "you", 2, "Done.", { inbox: "tell", inboxState: "open" }),
        ]),
        thread("t-c", "you", [
          message("moth", "you", 3, "Link?", { inbox: "ask", inboxState: "open" }),
        ]),
      ),
    )[0]!
    expect(kinds(chatOf(conversation, "moth", false))).toEqual([
      "time",
      "in:Tax?",
      "out:After.(delivered)",
      "new",
      "in:Done.",
      "in+:Link?",
    ])
  })
})
