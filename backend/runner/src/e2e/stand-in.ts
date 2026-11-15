import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { dirname, join } from "node:path"
import { TLSSocket } from "node:tls"

import { gitBash } from "@novadeck/sandbox"

/**
 * The openssl that makes a stand-in's certificates: the one on PATH, or on Windows Git for
 * Windows' own, beside its bash. Undefined where there is none.
 */
export const openssl = (): string | undefined => {
  if (spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0) return "openssl"
  const bash = process.platform === "win32" ? gitBash() : undefined
  const beside = bash && join(dirname(bash), "..", "usr", "bin", "openssl.exe")
  return beside && existsSync(beside) ? beside : undefined
}

export type StandIn = {
  /** The proxy's address, for a harness's `HTTPS_PROXY`. */
  readonly url: string
  /** The scratch authority's certificate, a PEM file, for `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE`. */
  readonly ca: string
  /** Each request it answered, as `<method> <host><path>`. */
  readonly hits: string[]
  readonly close: () => void
}

/**
 * A stand-in for a few of a harness's own hosts, on loopback, where a test needs an answer
 * the sandbox refuses, as Claude Code's connectivity check before its sign-in screen: a
 * proxy that tunnels to nothing but `hosts`, and answers every request to those with a 200
 * over TLS (`body` of its path, or `{}`), under a certificate a scratch authority made in
 * `folder` signs. Only a process told to trust that authority accepts it.
 */
export const standIn = async (
  folder: string,
  hosts: readonly string[],
  body: (path: string) => string = () => "{}",
): Promise<StandIn> => {
  const program = openssl()
  if (!program) throw new Error("A stand-in needs openssl, which isn't here")
  const dir = join(folder, "stand-in")
  mkdirSync(dir, { recursive: true })
  const ssl = (...args: string[]) => execFileSync(program, args, { cwd: dir, stdio: "ignore" })
  const key = ["-newkey", "rsa:2048", "-nodes", "-days", "2"]
  ssl("req", "-x509", ...key, "-subj", "/CN=stand-in", "-keyout", "ca.key", "-out", "ca.pem")
  ssl("req", ...key.slice(0, 3), "-subj", "/CN=stand-in", "-keyout", "leaf.key", "-out", "leaf.csr")
  writeFileSync(
    join(dir, "san.cnf"),
    `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`,
  )
  ssl(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    "san.cnf",
    "-out",
    "leaf.pem",
  )
  const hits: string[] = []
  const answer = createServer((incoming, outgoing) => {
    hits.push(`${incoming.method} ${incoming.headers.host ?? ""}${incoming.url ?? "/"}`)
    outgoing.writeHead(200, { "content-type": "application/json" }).end(body(incoming.url ?? "/"))
  })
  const context = {
    key: readFileSync(join(dir, "leaf.key")),
    cert: readFileSync(join(dir, "leaf.pem")),
  }
  const proxy = createServer((_incoming, outgoing) => outgoing.writeHead(403).end())
  proxy.on("connect", (incoming, socket: Socket) => {
    const host = (incoming.url ?? "").split(":")[0] ?? ""
    if (!hosts.includes(host)) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () =>
      answer.emit("connection", new TLSSocket(socket, { isServer: true, ...context })),
    )
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    ca: join(dir, "ca.pem"),
    hits,
    close: () => {
      proxy.close()
      answer.close()
    },
  }
}

/** Claude Code's connectivity check before its sign-in screen: a 200 from each of these. */
export const claudeHello = ["api.anthropic.com", "platform.claude.com"] as const
