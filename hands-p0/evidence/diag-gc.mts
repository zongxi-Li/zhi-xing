import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStandaloneHands } from '../hands/index.ts'

const BS = String.fromCharCode(92)
const ENV = resolve('.acl-test-env', 'diag-gc')
mkdirSync(ENV, { recursive: true })
const ws = mkdtempSync(join(ENV, 'ws-'))
const outside = join(ENV, 'gc-escape.txt').split(BS).join('/')
writeFileSync(join(ws, 'gc.ps1'), [
  `$outside = '${outside}'`,
  `Write-Output ("gc-outside=" + $outside)`,
  `try { Set-Content -LiteralPath $outside -Value x -ErrorAction Stop; 'GC-ESCAPED' } catch { ("GC-DENIED:" + $_.Exception.Message) }`,
  `try { Set-Content -LiteralPath ./gc-inside.txt -Value ok -ErrorAction Stop; 'GC-INSIDE-OK' } catch { 'GC-INSIDE-FAILED' }`,
].join('\n'))
const hands = await createStandaloneHands({ workspaceRoot: ws, confinement: 'acl', graceMs: 600 })
try {
  const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['shell.exec'] })
  const r = await hands.engine.execute({
    protocolVersion: '1', requestId: 'r', invocationId: 'i', capabilityId: 'shell.exec',
    authorization: { grantId: grant.grantId, workspaceId: 'w' },
    input: { command: '$p = Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","./gc.ps1") -PassThru -WindowStyle Hidden -Wait -RedirectStandardOutput ./gc-out.txt -RedirectStandardError ./gc-err.txt; Write-Output ("PARENT-DONE exit=" + $p.ExitCode)' },
    limits: { timeoutSeconds: 40 }, idempotencyKey: 'k',
  })
  console.log('status:', r.status)
  const o = r.output as { stdout?: { text: string }; stderr?: { text: string } } | undefined
  console.log('stdout:', JSON.stringify(o?.stdout?.text))
  console.log('stderr:', JSON.stringify(o?.stderr?.text?.slice(0, 400)))
  for (const f of ['gc-out.txt', 'gc-err.txt', 'gc-inside.txt']) {
    const p = join(ws, f)
    console.log(f, existsSync(p) ? JSON.stringify(readFileSync(p, 'utf8').slice(0, 300)) : 'ABSENT')
  }
  console.log('outside exists:', existsSync(outside))
} finally {
  await hands.dispose()
}
