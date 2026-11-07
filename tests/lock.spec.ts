import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lockStateDir } from '../src/app/runtime.ts'

describe('lockStateDir', () => {
  let dir: string
  let releases: (() => void)[]
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lock-')); releases = [] })
  afterEach(() => {
    for (const release of releases) { try { release() } catch { /* already released */ } }
    rmSync(dir, { recursive: true, force: true })
  })
  const compromise = (error: Error) => { throw error }

  it('locks an unlocked state directory, records its owner, and releases it', () => {
    const release = lockStateDir(dir, compromise)
    expect(statSync(`${dir}.lock`).isDirectory()).toBe(true)
    release()
    expect(() => statSync(`${dir}.lock`)).toThrow()
  })

  it('holds the lock while its owner runs, so a second process is refused', () => {
    releases.push(lockStateDir(dir, compromise))
    expect(() => lockStateDir(dir, compromise)).toThrow(/already being held/)
  })

  /**
   * Restarting straight after `kill -9`: the dead owner's lock is still fresh, so `proper-lockfile` would refuse it,
   * yet the pid recorded in it no longer runs.
   */
  it('reclaims the fresh lock of a process that no longer runs', () => {
    mkdirSync(`${dir}.lock`)
    // A pid no process can hold, so the check does not depend on what this machine happens to be running.
    writeFileSync(`${dir}.lock.owner`, String(2 ** 22 + 12345))
    releases.push(lockStateDir(dir, compromise))
    expect(statSync(`${dir}.lock`).isDirectory()).toBe(true)
  })

  it('leaves a fresh lock without an owner to its owner, so a starting process cannot steal it', () => {
    mkdirSync(`${dir}.lock`)
    expect(() => lockStateDir(dir, compromise)).toThrow(/already being held/)
  })
})
