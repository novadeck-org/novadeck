import { X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:tls"

import { describe, expect, it } from "../test.js"
import { openssl, standIn, type StandIn } from "./stand-in.js"

/** A GET of `host` through the stand-in's proxy, trusting only its authority. */
const get = (hello: StandIn, host: string, path: string) =>
  new Promise<string>((resolve, reject) => {
    const proxy = new URL(hello.url)
    request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: `${host}:443` })
      .on("connect", (answer, socket) => {
        if (answer.statusCode !== 200) return reject(new Error(`CONNECT ${answer.statusCode}`))
        const tls = connect({ socket, servername: host, ca: readFileSync(hello.ca) }, () => {
          tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
        })
        let text = ""
        tls.on("data", (chunk: Buffer) => (text += chunk.toString()))
        tls.on("end", () => resolve(text))
        tls.on("error", reject)
      })
      .on("error", reject)
      .end()
  })

describe.skipIf(!openssl())("a stand-in", () => {
  // Every openssl must make a leaf that chains to its authority: OpenSSL 4 adds no key
  // identifiers by itself, so a leaf named as its issuer would read as self-signed.
  it("signs its leaf under an authority of another name", async ({ resources }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-stand-in-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const hello = await standIn(folder, ["api.anthropic.com"])
    resources.defer(hello.close)
    const ca = new X509Certificate(readFileSync(hello.ca))
    const leaf = new X509Certificate(readFileSync(join(folder, "stand-in", "leaf.pem")))
    expect(leaf.issuer).toBe(ca.subject)
    expect(leaf.issuer).not.toBe(leaf.subject)
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
  })

  it("answers its hosts over TLS a client trusting its authority accepts, and only them", async ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-stand-in-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const hello = await standIn(folder, ["api.anthropic.com"])
    resources.defer(hello.close)
    expect(await get(hello, "api.anthropic.com", "/api/hello")).toMatch(/^HTTP\/1\.1 200 /)
    expect(hello.hits).toEqual(["GET api.anthropic.com/api/hello"])
    await expect(get(hello, "example.com", "/")).rejects.toThrow("CONNECT 403")
  })
})
