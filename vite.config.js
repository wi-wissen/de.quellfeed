import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'

const { version } = createRequire(import.meta.url)('./package.json')

const DEV_PROXY_PATH = '/__proxy'
const WEBDAV_PROXY_PATH = '/__dav'

const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'user-agent']
const FORWARDED_DAV_HEADERS = ['authorization', 'content-type', 'if-match', 'if-none-match', 'accept']

/**
 * Same-origin dev proxy. Replaces the standalone `cors-anywhere` server, which
 * needed a port of its own plus an origin whitelist pinned to a fixed Vite port —
 * both broke as soon as either port was already taken by another process.
 */
function devProxy() {
  return {
    name: 'quell-dev-proxy',
    configureServer(server) {
      server.middlewares.use(DEV_PROXY_PATH, async (req, res) => {
        const target = new URL(req.url, 'http://localhost').searchParams.get('url')

        if (!target) {
          res.statusCode = 400
          res.end('Missing ?url= parameter')
          return
        }

        let targetUrl
        try {
          targetUrl = new URL(target)
        } catch {
          res.statusCode = 400
          res.end(`Invalid URL: ${target}`)
          return
        }

        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
          res.statusCode = 400
          res.end(`Unsupported protocol: ${targetUrl.protocol}`)
          return
        }

        const headers = {}
        for (const name of FORWARDED_REQUEST_HEADERS) {
          if (req.headers[name]) headers[name] = req.headers[name]
        }

        try {
          const upstream = await fetch(targetUrl, { headers, redirect: 'follow' })
          const body = await upstream.text()

          res.statusCode = upstream.status
          res.setHeader('content-type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8')
          res.setHeader('x-quell-proxied-url', upstream.url)
          res.end(body)
        } catch (error) {
          server.config.logger.warn(`[quell-dev-proxy] ${targetUrl.href} → ${error.message}`)
          res.statusCode = 502
          res.end(`Upstream request failed: ${error.message}`)
        }
      })

      /**
       * WebDAV needs more than the article proxy above can give it: PUT (with a body),
       * an Authorization header, If-Match, and the ETag back out. Natively none of
       * this exists — CapacitorHttp talks to the server directly — but without it
       * WebDAV would be untestable in the browser, which is where we develop.
       */
      server.middlewares.use(WEBDAV_PROXY_PATH, async (req, res) => {
        const target = new URL(req.url, 'http://localhost').searchParams.get('url')

        let targetUrl
        try {
          targetUrl = new URL(target)
        } catch {
          res.statusCode = 400
          res.end(`Invalid URL: ${target}`)
          return
        }

        const headers = {}
        for (const name of FORWARDED_DAV_HEADERS) {
          if (req.headers[name]) headers[name] = req.headers[name]
        }

        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined

        try {
          const upstream = await fetch(targetUrl, { method: req.method, headers, body })

          res.statusCode = upstream.status
          // Without the ETag back, If-Match — and with it conflict detection — is dead.
          const etag = upstream.headers.get('etag')
          if (etag) res.setHeader('etag', etag)
          res.setHeader('access-control-expose-headers', 'etag')
          res.setHeader('content-type', upstream.headers.get('content-type') || 'application/octet-stream')
          res.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (error) {
          server.config.logger.warn(`[quell-dav-proxy] ${req.method} ${targetUrl.href} → ${error.message}`)
          res.statusCode = 502
          res.end(`Upstream request failed: ${error.message}`)
        }
      })
    },
  }
}

/**
 * The domain configs live in docs/ — the GitHub-Pages folder, together with the
 * website — NOT in public/, because public/ is packaged into the app and the app
 * never reads a bundled copy (domainConfig.js fetches remote only). In production
 * the app fetches them from quellfeed.de/configs; in dev this middleware serves the
 * same paths from docs/configs so .env.development can stay relative.
 */
function devConfigs() {
  const root = fileURLToPath(new URL('./docs/configs', import.meta.url))

  return {
    name: 'quell-dev-configs',
    configureServer(server) {
      server.middlewares.use('/configs', async (req, res, next) => {
        const relative = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
        const file = join(root, relative)
        if (!file.startsWith(root)) return next() // path traversal

        try {
          const body = await readFile(file)
          res.setHeader('content-type', 'application/json')
          res.end(body)
        } catch {
          res.statusCode = 404
          res.end('{}')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: tag => tag === 'ion-icon',
        },
      },
    }),
    devProxy(),
    devConfigs(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
