/**
 * PR-HANDS-01 Task B — shell execution policy tests.
 * Real system assertions: the actual MSIX Store alias on this machine is
 * rejected; native candidates resolve and pin; receipts carry the identity.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createStandaloneHands,
  isMsixAlias,
  nativeShellCandidates,
  resolveShellExecutable,
  SHELL_POLICY_ERROR_CODES,
  ShellPolicyError,
  type StandaloneHands,
} from '../hands/index.ts'

const NATIVE_PS51 = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const STORE_ALIAS = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')

const instances: StandaloneHands[] = []
afterAll(async () => {
  await Promise.allSettled(instances.splice(0).map((h) => h.dispose()))
})

describe('B1/B6 shell executable resolution (real system state)', () => {
  it('implicit resolution pins a NATIVE PowerShell and never consults PATH', () => {
    const identity = resolveShellExecutable()
    expect([nativeShellCandidates()[0], nativeShellCandidates()[1]]).toContain(identity.path.replaceAll('/', '\\'))
    expect(identity.sha256).toMatch(/^[0-9a-f]{64}$/)
    // The digest is of the REAL file on disk.
    expect(createHash('sha256').update(readFileSync(identity.path)).digest('hex')).toBe(identity.sha256)
  })

  it('an explicit native PS 5.1 path verifies and pins', () => {
    const identity = resolveShellExecutable(NATIVE_PS51)
    expect(identity.source).toBe('explicit')
    expect(identity.path.toLowerCase()).toContain('windowspowershell\\v1.0')
  })

  it('the REAL Microsoft Store pwsh alias on this machine is REJECTED', () => {
    if (!existsSync(STORE_ALIAS)) return // machines without any Store pwsh
    expect(isMsixAlias(STORE_ALIAS)).toBe(true)
    expect(() => resolveShellExecutable(STORE_ALIAS)).toThrowError(ShellPolicyError)
    try {
      resolveShellExecutable(STORE_ALIAS)
    } catch (error) {
      expect((error as ShellPolicyError).code).toBe(SHELL_POLICY_ERROR_CODES.MSIX_ALIAS_REJECTED)
    }
  })

  it('a path that RESOLVES into the WindowsApps tree is rejected too (realpath check)', () => {
    if (!existsSync(STORE_ALIAS)) return
    // An alias whose spelling hides the WindowsApps segment still resolves there.
    const disguised = STORE_ALIAS.replaceAll('WindowsApps', 'WindowsApps')
    expect(() => resolveShellExecutable(disguised)).toThrowError(/MSIX|alias/i)
  })

  it('non-PowerShell executables are rejected by name', () => {
    expect(() => resolveShellExecutable('C:/Windows/System32/cmd.exe')).toThrowError(ShellPolicyError)
    try {
      resolveShellExecutable('C:/Windows/System32/cmd.exe')
    } catch (error) {
      expect((error as ShellPolicyError).code).toBe(SHELL_POLICY_ERROR_CODES.NOT_POWERSHELL)
    }
  })

  it('nonexistent executables fail closed', () => {
    try {
      resolveShellExecutable('C:/definitely/not/here/pwsh.exe')
      expect.unreachable()
    } catch (error) {
      expect((error as ShellPolicyError).code).toBe(SHELL_POLICY_ERROR_CODES.NOT_FOUND)
    }
  })

  it('a poisoned PATH cannot select the shell: resolution output is independent of PATH', () => {
    const before = resolveShellExecutable()
    const savedPath = process.env.PATH
    process.env.PATH = `Z:\\definitely\\not\\real;${savedPath}`
    try {
      const after = resolveShellExecutable()
      expect(after.path).toBe(before.path)
      expect(after.sha256).toBe(before.sha256)
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('B3 receipts record the actual executable identity', () => {
  it('shell.exec receipts carry executedBy with the pinned executable digest', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'hands-b3-'))
    const hands = await createStandaloneHands({ workspaceRoot: workspace })
    instances.push(hands)
    const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: hands.world.filesystem.workspaceRoot, allowedCapabilities: ['shell.exec'] })
    const receipt = await hands.engine.execute({
      protocolVersion: '1', requestId: 'r1', invocationId: 'i1', capabilityId: 'shell.exec',
      authorization: { grantId: grant.grantId, workspaceId: 'w' },
      input: { command: 'Write-Output pinned' }, limits: { timeoutSeconds: 30 }, idempotencyKey: 'k',
    })
    expect(receipt.status).toBe('completed')
    const executedBy = (receipt.output as { executedBy?: { executable: { path: string; sha256: string; sizeBytes: number }; confinement: string; jobContainment: string } }).executedBy
    expect(executedBy).toBeDefined()
    expect(executedBy!.executable.path.toLowerCase()).toContain('powershell')
    expect(executedBy!.executable.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(executedBy!.confinement).toBe('none')
    expect(executedBy!.jobContainment).toBe('windows-job')
  })
})

describe('B4 fail-closed composition guards', () => {
  it('refuses to create a world when the Job probe fails (no uncontrolled spawn path)', async () => {
    await expect(createStandaloneHands({ workspaceRoot: join(tmpdir(), 'x-'), jobProbe: () => false }))
      .rejects.toThrowError(/Job containment unavailable at composition/)
  })

  it('refuses confinement "acl" combined with danger-full-access', async () => {
    await expect(createStandaloneHands({ workspaceRoot: join(tmpdir(), 'x-'), confinement: 'acl', sandboxMode: 'danger-full-access' }))
      .rejects.toThrowError(/refuses sandboxMode/)
  })

  it('refuses confinement "acl" combined with the bash executor', async () => {
    await expect(createStandaloneHands({ workspaceRoot: join(tmpdir(), 'x-'), confinement: 'acl', shell: 'bash' }))
      .rejects.toThrowError(/pwsh executor only/)
  })
})
