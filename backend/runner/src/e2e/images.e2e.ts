/* eslint-disable no-await-in-loop -- A scenario's steps run in order, each after the one before. */
import { setups } from "./agents/index.js"
import { item, prompted } from "./chat-prompts.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { picture } from "./pictures.js"
import { replies, lacking, own, start, through } from "./scenarios.js"

// The chat's images, the same for every harness (see messaging.e2e.ts for the rule on parity).
// Their own file, so the Windows quirks job runs them with a spaced uploads folder.

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    // The chat's images: saved on the runner by `terminals.upload`, then pasted into the box
    // on their own before the words, each as the harness takes a pasted image file. A name with
    // a space makes the path one (the runner's folder may hold spaces too, on macOS and
    // Windows), which Codex and Antigravity take only quoted or escaped.
    for (const { what, images, words } of [
      {
        what: "an image with a space in its name",
        images: ["my shot.png"],
        words: "Read this one",
      },
      { what: "two images", images: ["one.png", "two shot.png"], words: "Compare these two" },
    ])
      gated(it, lacking(setup, "image"))(
        `gives its agent a prompt with ${what}, which the model receives with the words`,
        async ({ e2e: run }) => {
          run.model.use(replies(words, "Seen."))
          const t1 = await start(run, setup)
          const calls = run.model.mark()
          const mark = t1.mark()

          const settled = await prompted(
            t1,
            words,
            images.map((name) => ({ name, data: picture })),
          )
          await t1.until("Seen.")
          await settled()
          await through(t1, ["working", "settled"], { after: mark })

          const call = await run.model.waitFor(
            (each) =>
              !each.side &&
              each.turns.some((one) => one.role === "user" && one.text.includes(words)),
            { after: calls },
          )
          const user = call.turns.findLast((one) => one.role === "user" && one.text.includes(words))
          expect(
            user?.role === "user" ? (user.images ?? 0) : -1,
            "the images it passed to the model",
          ).toBe(images.length)
          // The record keeps each image's place in the words, or beside them.
          const record = await item(t1, "user", (text) => text.includes(words))
          if (setup.image!.inline) expect(record).toContain(`[Image #${images.length}]`)
        },
      )

    // The chat's images among the words: the words before one, the image, the words after, so
    // the model reads where each belongs. Claude Code and Codex show the placeholder at the
    // image's place themselves; Antigravity shows none, so the runner types it.
    for (const { what, images, words, at } of [
      {
        what: "an image among its words",
        images: ["one.png"],
        words: "See this:  and fix it",
        at: [10],
      },
      {
        what: "two images among its words, the last ending the text",
        images: ["one.png", "two shot.png"],
        words: "Compare  with  please ",
        at: [8, 15],
      },
      {
        what: "an image ahead of the words and another among them",
        images: ["one.png", "two.png"],
        words: "Look at  here",
        at: [0, 8],
      },
    ])
      gated(it, lacking(setup, "image"))(
        `gives its agent a prompt with ${what}, each where the person put it`,
        async ({ e2e: run }) => {
          run.model.use(replies(words.trim().split(/\s+/)[0]!, "Seen."))
          const t1 = await start(run, setup)
          const calls = run.model.mark()
          const mark = t1.mark()

          const settled = await prompted(
            t1,
            words,
            images.map((name) => ({ name, data: picture })),
            at,
          )
          await t1.until("Seen.")
          await settled()
          await through(t1, ["working", "settled"], { after: mark })

          // The words and the placeholders in the order they were put, as the model got them
          // and as the record keeps them, whichever harness's.
          const pieces = [...at, words.length].map((end, index) =>
            words.slice(index === 0 ? 0 : at[index - 1], end).trim(),
          )
          const placed = new RegExp(
            pieces
              .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
              .join("\\s*\\[Image #\\d+\\]\\s*"),
          )
          const call = await run.model.waitFor(
            (each) =>
              !each.side && each.turns.some((one) => one.role === "user" && placed.test(one.text)),
            { after: calls },
          )
          const user = call.turns.findLast((one) => one.role === "user" && placed.test(one.text))
          expect(
            user?.role === "user" ? (user.images ?? 0) : -1,
            "the images it passed to the model",
          ).toBe(images.length)
          expect(await item(t1, "user", (text) => placed.test(text))).toMatch(placed)
        },
      )

    it(
      setup.image?.alone === false
        ? "refuses images with no words, writing nothing, where Enter would send none"
        : "sends images with no words",
      async ({ e2e: run }) => {
        run.model.use(own(() => ({ text: "Seen." })))
        const t1 = await start(run, setup)
        const image = [{ name: "shot.png", data: picture }]
        if (setup.image?.alone === false) {
          await expect(t1.prompt("", image)).rejects.toMatchObject({ code: "PROMPT_REFUSED" })
          expect(await t1.screen()).not.toContain("media attached")
          return
        }
        // Followed like any prompt: its receipt settles on the record item of its placeholders.
        const settled = await prompted(t1, "", image)
        await t1.until("Seen.")
        await settled()
      },
    )
  })
}
