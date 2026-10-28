import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStandaloneHands } from '../hands/index.ts'

const BS = String.fromCharCode(92)
const ENV = resolve('.acl-test-env', 'diag-gc2')
mkdirSync(ENV, { recursive: true })
const ws = mkdtempSync(join(ENV, 'ws-'))
const outside = join(ENV, 'gc-escape.txt').split(BS).join('/')
writeFileSync(join(ws, 'gc.ps1'), [
  `$outside = '${outside}'`,
  `try { Set-Content -LiteralPath $outside -Value x -ErrorAction Stop; 'GC-ESCAPED' } catch { 'GC-DENIED' }`,
].join('\n'))
const hands = await createStandaloneHands({ workspaceRoot: ws, confinement: 'acl', graceMs: 600 })
try {
  const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['shell.exec'] })
  const r = await hands.engine.execute({
    protocolVersion: '1', requestId: 'r', invocationId: 'i', capabilityId: 'shell.exec',
    authorization: { grantId: grant.grantId, workspaceId: 'w' },
    // identical to the vitest D4 command (no redirects)
    input: { command: '$p = Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","./gc.ps1") -PassThru -WindowStyle Hidden -Wait; Write-Output PARENT-DONE' },
    limits: { timeoutSeconds: 40 }, idempotencyKey: 'k',
  })
  const o = r.output as { stdout?: { text: string }; stderr?: { text: string } } | undefined
  console.log('stdout:', JSON.stringify(o?.stdout?.text))
  console.log('stderr:', JSON.stringify(o?.stderr?.text?.slice(0, 500)))
  console.log('gc-escape exists:', existsSync(outside))
} finally {
  await hands.dispose()
}
