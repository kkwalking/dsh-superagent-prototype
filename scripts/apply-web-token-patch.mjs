#!/usr/bin/env node
/**
 * Patch @deepseek-ai/dsh-client-connection so the DSH web launch token is stable and configurable.
 *
 * Stock behaviour: every process start mints a fresh random `?token=`, so a bookmarked URL breaks on each restart.
 * This patch makes `processLaunchToken` read a durable token from a file (default `~/.dsh/web-token`) and create that
 * file with a random token the first time. Rotate it by writing a new value to the file and restarting the web profile.
 *
 * Re-run after every `npm install -g @deepseek-ai/dsh` upgrade, which overwrites the patched file. Idempotent.
 * The browser-session cookie lifetime is raised through the plugin's own `cookieMaxAgeDays` config, not this patch.
 *
 * Usage: node apply-web-token-patch.mjs [path-to-dsh-client-connection]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const TOKEN_FILE = join(homedir(), '.dsh', 'web-token')
const MARKER = '/* dsh-web-token-patch */'

function resolveLib() {
  const explicit = process.argv[2]
  if (explicit) return join(explicit, 'lib/index.js')
  const bin = execSync('command -v dsh', { encoding: 'utf8' }).trim()
  // .../@deepseek-ai/dsh/lib/bin.js  → the package root is its dirname's parent.
  const real = execSync(`node -e 'console.log(require("fs").realpathSync(process.argv[1]))' ${JSON.stringify(bin)}`, { encoding: 'utf8' }).trim()
  const dshRoot = real.replace(/\/lib\/bin\.js$/, '')
  return join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')
}

function newToken() {
  return randomBytes(32).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function ensureTokenFile() {
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing) return existing
  }
  mkdirSync(join(homedir(), '.dsh'), { recursive: true })
  const token = newToken()
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
  return token
}

function main() {
  const file = resolveLib()
  if (!existsSync(file)) { console.error(`✗ not found: ${file}`); process.exit(1) }
  let source = readFileSync(file, 'utf8')

  if (source.includes(MARKER)) {
    console.log(`= already patched: ${file}`)
    console.log(`  token file: ${TOKEN_FILE}`)
    console.log(`  token: ${ensureTokenFile()}`)
    return
  }

  // 1) Add the fs imports the patched function needs, right after the existing node:crypto import.
  const importAnchor = 'import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";'
  const importPatch = importAnchor + `\n${MARKER} import { readFileSync as __readTok, writeFileSync as __writeTok, mkdirSync as __mkdirTok } from "node:fs";\nimport { homedir as __homedirTok } from "node:os";\nimport { join as __joinTok } from "node:path";`
  if (source.includes(importAnchor)) source = source.replace(importAnchor, importPatch)

  // 2) Replace the launch-token generator with a file-backed one.
  const original = `function processLaunchToken(owner) {
	const existing = PROCESS_LAUNCH_TOKENS.get(owner);
	if (existing !== void 0) return existing;
	const created = encodeBase64Url(randomBytes(SECRET_BYTES));
	PROCESS_LAUNCH_TOKENS.set(owner, created);
	return created;
}`
  const patched = `function processLaunchToken(owner) {
	${MARKER}
	// A durable, filesystem-configured launch token instead of a per-process random one, so a bookmarked URL survives a
	// restart. Write a new value to the token file, then restart, to rotate it.
	const existing = PROCESS_LAUNCH_TOKENS.get(owner);
	if (existing !== void 0) return existing;
	let created = "";
	try {
		const tokenFile = process.env.DSH_WEB_TOKEN_FILE || __joinTok(__homedirTok(), ".dsh", "web-token");
		try { created = __readTok(tokenFile, "utf8").trim(); } catch {}
		if (created === "") {
			__mkdirTok(__joinTok(__homedirTok(), ".dsh"), { recursive: true });
			created = encodeBase64Url(randomBytes(SECRET_BYTES));
			__writeTok(tokenFile, created + "\\n", { mode: 0o600 });
		}
	} catch {
		created = encodeBase64Url(randomBytes(SECRET_BYTES));
	}
	PROCESS_LAUNCH_TOKENS.set(owner, created);
	return created;
}`
  if (!source.includes(original)) {
    console.error('✗ the stock processLaunchToken body did not match this dsh version; adapt the patch by hand.')
    process.exit(1)
  }
  source = source.replace(original, patched)

  if (!existsSync(file + '.stock')) writeFileSync(file + '.stock', readFileSync(file, 'utf8'))
  writeFileSync(file, source)

  console.log(`✓ patched: ${file}`)
  console.log(`  token file: ${TOKEN_FILE}`)
  console.log(`  token: ${ensureTokenFile()}`)
}

main()
