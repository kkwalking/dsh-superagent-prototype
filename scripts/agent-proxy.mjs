#!/usr/bin/env node
/**
 * Loopback reverse proxy in front of the dsh-superagent panel behind a Cloudflare tunnel.
 *
 * Why it exists: the superagent plugin's sameOrigin check (src/app/http.ts:75) accepts only the loopback authority
 * `127.0.0.1:<port>`, so requests under /orchestrator keep the public Host on the wire but must reach the panel as
 * loopback. Every other request — including the DSH WebSocket at /api/remote.mux and the /plugins/events stream — is
 * forwarded untouched so the host's own --trusted-host and cookie checks apply. This proxy adds no authentication;
 * Cloudflare Access belongs in front of the tunnel.
 */
import http from 'node:http'
import net from 'node:net'

const LISTEN = Number(process.env.PROXY_PORT ?? 3083)
const UPSTREAM_HOST = '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 3082)
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://agent.kkrunning.win'
const AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`

/** Only the plugin's management API must see the loopback authority; everything else keeps the public one. */
const isManagement = (url) => (url ?? '').startsWith('/orchestrator')

/** Rewrites the loopback-facing headers for a management request, and leaves a pass-through request unchanged. */
function upstreamHeaders(req) {
  const headers = { ...req.headers }
  if (isManagement(req.url)) {
    headers.host = AUTHORITY
    if (headers.origin === PUBLIC_ORIGIN) headers.origin = `http://${AUTHORITY}`
    if (typeof headers.referer === 'string' && headers.referer.startsWith(PUBLIC_ORIGIN)) headers.referer = `http://${AUTHORITY}/`
  }
  return headers
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: upstreamHeaders(req) },
    (up) => {
      const out = { ...up.headers }
      if (out.location) out.location = out.location.replaceAll(`http://${AUTHORITY}`, PUBLIC_ORIGIN)
      res.writeHead(up.statusCode ?? 502, out)
      up.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`upstream error: ${error.message}`)
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
})

/**
 * WebSocket and other Upgrade traffic. A raw TCP tunnel is used rather than http.request because a client-side
 * ClientRequest does not emit 'upgrade' when the server answers 101; the request line and headers are replayed onto a
 * plain socket, the 101 is relayed with the upstream's own headers, then both directions are piped and each side tears
 * the other down on close so neither leaks.
 */
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy())
  const upSocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST)
  upSocket.on('error', () => { upSocket.destroy(); socket.destroy() })
  upSocket.on('connect', () => {
    const headers = upstreamHeaders(req)
    // Force connection semantics the origin expects for a hand-rolled upgrade request.
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`)
    upSocket.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) upSocket.write(head)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    const close = () => { upSocket.destroy(); socket.destroy() }
    upSocket.on('close', close)
    socket.on('close', close)
  })
})

server.on('clientError', (_err, socket) => socket.destroy())
server.listen(LISTEN, '127.0.0.1', () => console.log(`agent-proxy 127.0.0.1:${LISTEN} -> ${AUTHORITY} (public ${PUBLIC_ORIGIN})`))
