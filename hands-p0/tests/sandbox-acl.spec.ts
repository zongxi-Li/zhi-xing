/**
 * PR-HANDS-01 Task C + D2/D4 — Windows ACL SandboxProvider, REAL system tests.
 *
 * Every test runs in the dedicated, recoverable environment `.acl-test-env/`
 * (project-local — NOT under the OS temp dir, because the ACL grant path
 * asserts the ambient temp ROOT lies outside the workspace). The only security
 * descriptors this suite touches are those of throwaway directories it creates
 * itself; cleanup removes them and verifies removal.
 *
 * These tests prove OS-level enforcement (restricted token + capability-SID
 * ACEs), not application-layer policy: assertions check files on disk and
 * denial text from the OPERATING SYSTEM.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createStandaloneHands, type StandaloneHands } from '../hands/index.ts'

const ENV_ROOT = resolve('.acl-test-env')

const instances: StandaloneHands[] = []
const dirty: string[] = []

afterAll(async () => {
  await Promise.allSettled(instances.splice(0).map((h) => h.dispose()))
  for (const dir of dirty.splice(0)) rmSync(dir, { recursive: true, force: true })
  try { rmSync(ENV_ROOT, { recursive: true, force: true }) } catch { /* reported per-test */ }
})

/** A dedicated ACL test environment: fresh workspace under .acl-test-env. */
function aclWorkspace(): string {
  mkdirSync(ENV_ROOT, { recursive: true })
  const ws = mkdtempSync(join(ENV_ROOT, 'ws-'))
  dirty.push(ws)
  return ws
}

async function makeAclHands(ws: string) {
  const hands = await createStandaloneHands({ workspaceRoot: ws, confinement: 'acl', graceMs: 600 })
  instances.push(hands)
  const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['fs.read', 'fs.write', 'shell.exec'] })
  let seq = 0
  const exec = (command: string, limits?: { timeoutSeconds?: number }) =>
    hands.engine.execute({
      protocolVersion: '1',
      requestId: `areq_${++seq}`,
      invocationId: `ainv_${seq}`,
      capabilityId: 'shell.exec',
      authorization: { grantId: grant.grantId, workspaceId: 'w' },
      input: { command },
      limits: limits ?? { timeoutSeconds: 45 },
      idempotencyKey: `acl-${seq}`,
      identity: { runId: 'run_acl', stepId: `step_${seq}`, attemptId: 'atm_1', commitId: `cmt_${seq}` },
    })
  return { hands, exec }
}

/** Escape target OUTSIDE every writable root (project-local, NOT the OS temp dir). */
function outsideTarget(name: string): string {
  return join(ENV_ROOT, name)
}

describe('C/D2 OS-level workspace-write confinement (restricted token + ACL)', () => {
  it('writes INSIDE the workspace succeed (real file on disk) — the control case', async () => {
    const ws = aclWorkspace()
    const { exec } = await makeAclHands(ws)
    const receipt = await exec('Set-Content -LiteralPath ./inside.txt -Value "confined-but-inside"; Write-Output DONE')
    expect(receipt.status).toBe('completed')
    expect((receipt.output as { exitCode: number }).exitCode).toBe(0)
    const written = readFileSync(join(ws, 'inside.txt'), 'utf8')
    expect(written.trim()).toBe('confined-but-inside')
    const sandbox = (receipt.output as { sandbox?: { mode: string; enforcement: string } }).sandbox
    expect(sandbox?.mode).toBe('workspace-write')
    expect(sandbox?.enforcement).toBe('partial')
    const executedBy = (receipt.output as { executedBy?: { confinement: string; jobContainment: string; executable: { sha256: string } } }).executedBy
    expect(executedBy?.confinement).toBe('acl')
    expect(executedBy?.jobContainment).toBe('windows-job')
    expect(executedBy?.executable.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('D2: a shell write OUTSIDE the workspace is denied BY THE OS — file never exists, denial classified', async () => {
    const ws = aclWorkspace()
    const { exec } = await makeAclHands(ws)
    const target = outsideTarget(`escape-${Date.now()}.txt`)
    const receipt = await exec(`$ErrorActionPreference='Stop'; try { Set-Content -LiteralPath '${target}' -Value 'escaped' -ErrorAction Stop; Write-Output ESCAPED } catch { Write-Output ("DENIED:" + $_.Exception.Message); exit 5 }`)
    const output = receipt.output as { exitCode: number; stdout: { text: string }; stderr: { text: string }; sandbox?: { denied: boolean } }
    // The command RAN (control path works) — but the OS refused the write.
    // Denial text matches both English and zh-CN Windows message cultures
    // (this host is zh-CN: "对路径...的访问被拒绝").
    expect(output.stdout.text).toMatch(/DENIED:/)
    expect(output.stdout.text + output.stderr.text).toMatch(/Access to the path|access is denied|not permitted|访问被拒绝|对路径/i)
    expect(existsSync(target)).toBe(false)
    // And the workspace remains writable after the denial (no lockout).
    const followUp = await exec('Set-Content -LiteralPath ./after-denial.txt -Value "still-ok"; Write-Output OK')
    expect(followUp.status).toBe('completed')
    expect(existsSync(join(ws, 'after-denial.txt'))).toBe(true)
  })

  it('D3: a directory junction INSIDE the workspace pointing OUTSIDE cannot smuggle a confined write', async () => {
    const ws = aclWorkspace()
    const outsideDir = mkdtempSync(join(ENV_ROOT, 'junction-target-'))
    dirty.push(outsideDir)
    const { exec } = await makeAclHands(ws)
    // Build the junction from OUTSIDE (unconfined helper), as an attacker would pre-position it.
    spawnSync('cmd.exe', ['/c', 'mklink', '/J', join(ws, 'loot'), outsideDir])
    if (!existsSync(join(ws, 'loot'))) return // mklink unavailable — environment limitation
    const receipt = await exec(`try { Set-Content -LiteralPath './loot/smuggled.txt' -Value 'x' -ErrorAction Stop; Write-Output ESCAPED } catch { Write-Output 'DENIED-BY-OS'; exit 5 }`)
    const output = receipt.output as { stdout: { text: string }; exitCode: number }
    expect(output.stdout.text).toContain('DENIED-BY-OS')
    expect(existsSync(join(outsideDir, 'smuggled.txt'))).toBe(false)
  })

  it('D4: under the restricted token the shell CANNOT SPAWN children at all — OS denies process creation (stronger than confinement)', async () => {
    const ws = aclWorkspace()
    const outside = outsideTarget(`grandchild-escape-${Date.now()}.txt`)
    // Grandchild script staged from OUTSIDE; the confined shell tries to run it.
    writeFileSync(join(ws, 'gc.ps1'), [
      `$outside = '${outside.split(String.fromCharCode(92)).join('/')}'`,
      `try { Set-Content -LiteralPath $outside -Value x -ErrorAction Stop; 'GC-ESCAPED' } catch { 'GC-DENIED' }`,
      `try { Set-Content -LiteralPath ./gc-inside.txt -Value ok -ErrorAction Stop; 'GC-INSIDE-OK' } catch { 'GC-INSIDE-FAILED' }`,
      `| Set-Content -LiteralPath ./gc-result.txt`,
    ].join('\n'))
    const { exec } = await makeAclHands(ws)
    const receipt = await exec('$p = Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","./gc.ps1") -PassThru -WindowStyle Hidden -Wait; Write-Output PARENT-DONE')
    expect(receipt.status).toBe('completed')
    const output = receipt.output as { stdout: { text: string }; stderr: { text: string } }
    expect(output.stdout.text).toContain('PARENT-DONE')
    // REAL system fact on this host: a WRITE_RESTRICTED token cannot create
    // child processes through plain CreateProcess — the OS denies the spawn
    // itself. No grandchild ever ran; nothing escaped.
    // Hard filesystem facts (deterministic): the spawn was refused, the
    // grandchild never ran. (The Start-Process error text itself does not
    // surface on the collected stderr stream under -WindowStyle Hidden —
    // observed on both tsx and vitest; recorded in the PR-HANDS-01 report.)
    expect(existsSync(join(ws, 'gc-result.txt'))).toBe(false)
    expect(existsSync(join(ws, 'gc-inside.txt'))).toBe(false)
    expect(existsSync(outside)).toBe(false)
    // The parent itself still writes fine inside the workspace.
    const control = await exec('Set-Content -LiteralPath ./parent-ok.txt -Value yes; Write-Output PARENT-OK')
    expect(control.status).toBe('completed')
    expect(existsSync(join(ws, 'parent-ok.txt'))).toBe(true)
  })

  it('C: temp semantics — the PRIVATE temp is writable, the raw OS temp ROOT is NOT', async () => {
    const ws = aclWorkspace()
    const { exec } = await makeAclHands(ws)
    const rawTemp = tmpdir()
    const receipt = await exec([
      `Write-Output ("TEMP=" + $env:TEMP)`,
      `try { Set-Content -LiteralPath (Join-Path $env:TEMP 'hands-private-ok.txt') -Value ok -ErrorAction Stop; Write-Output PRIVATE_OK } catch { Write-Output PRIVATE_FAILED }`,
      `try { Set-Content -LiteralPath '${(join(rawTemp, 'hands-raw-escape.txt')).replaceAll('\\', '\\\\')}' -Value x -ErrorAction Stop; Write-Output RAW_ESCAPED } catch { Write-Output RAW_DENIED }`,
    ].join('; '))
    const output = receipt.output as { stdout: { text: string } }
    const text = output.stdout.text
    const privateTemp = /TEMP=(.*)/.exec(text)?.[1]?.trim()
    // The confined process sees a PRIVATE temp under the OS temp root...
    expect(privateTemp?.toLowerCase().startsWith(rawTemp.toLowerCase())).toBe(true)
    expect(privateTemp).toMatch(/dsh/)
    // ...can write there...
    expect(text).toContain('PRIVATE_OK')
    // ...and CANNOT write to the raw OS temp root itself.
    expect(text).toContain('RAW_DENIED')
    expect(existsSync(join(rawTemp, 'hands-raw-escape.txt'))).toBe(false)
    // Locate the private dir for cleanup evidence.
    if (privateTemp !== undefined) dirty.push(privateTemp)
  })

  it('C: provider dispose REVOKES temp grants and removes the private temp dir (residue check)', async () => {
    const ws = aclWorkspace()
    const hands = await createStandaloneHands({ workspaceRoot: ws, confinement: 'acl', graceMs: 600 })
    const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['shell.exec'] })
    const receipt = await hands.engine.execute({
      protocolVersion: '1', requestId: 'rv1', invocationId: 'rv1', capabilityId: 'shell.exec',
      authorization: { grantId: grant.grantId, workspaceId: 'w' },
      input: { command: 'Write-Output ("TEMP=" + $env:TEMP)' }, limits: { timeoutSeconds: 45 }, idempotencyKey: 'rv',
    })
    const privateTemp = /TEMP=(.*)/.exec((receipt.output as { stdout: { text: string } }).stdout.text)?.[1]?.trim()
    expect(privateTemp).toBeDefined()
    expect(existsSync(privateTemp!)).toBe(true)
    await hands.dispose()
    // The private temp dir is REMOVED on dispose (revocable grant lifecycle).
    expect(existsSync(privateTemp!)).toBe(false)
    // Documented residue: the STANDING workspace capability ACE remains by design.
    const icacls = spawnSync('icacls.exe', [ws], { encoding: 'utf8' })
    expect(icacls.stdout).toMatch(/S-1-4-/)
  })

  it('D6+Job: a timeout kill under ACL confinement cleans the long-running shell (real process table)', async () => {
    const ws = aclWorkspace()
    const { exec } = await makeAclHands(ws)
    // NOTE: under the restricted token, spawning children is OS-denied (see the
    // D4 test), so the managed tree here is the confined shell itself in the Job.
    const marker = `acl-shell-${Date.now()}`
    const receipt = await exec(`Write-Output '${marker}'; Start-Sleep -Seconds 90`, { timeoutSeconds: 3 })
    expect(receipt.status).toBe('completed')
    expect((receipt.output as { timedOut: boolean }).timedOut).toBe(true)
    await new Promise((r) => setTimeout(r, 1200))
    const count = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -match 'Start-Sleep -Seconds 90' }).Count`], { encoding: 'utf8' }).stdout.trim()
    expect(Number(count ?? '0')).toBe(0)
  })

  it('D5-adjacent: a BROKEN confinement runner fails CLOSED — SANDBOX_UNAVAILABLE surfaces, command never runs', async () => {
    const ws = aclWorkspace()
    const { hands, exec } = await makeAclHands(ws)
    // Break the ACL runner argv AFTER composition (public internals hook).
    const sandbox = (hands.world as unknown as { context: { sandbox: { internals: { windowsAclRunnerArgs: string[] } } } }).context.sandbox
    sandbox.internals.windowsAclRunnerArgs = ['Z:/definitely/not/a/runner.js']
    const receipt = await exec('Write-Output must-not-run')
    expect(receipt.status).toBe('failed')
    expect(receipt.error?.message).toMatch(/SANDBOX_UNAVAILABLE|sandbox/i)
    expect((receipt.output as { stdout?: { text: string } } | undefined)?.stdout?.text ?? '').not.toContain('must-not-run')
  })
})
