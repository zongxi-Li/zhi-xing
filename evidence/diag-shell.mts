import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandaloneHands } from '../hands/index.ts'

const ws = mkdtempSync(join(tmpdir(), 'hands-diag-'))
const hands = await createStandaloneHands({ workspaceRoot: ws, graceMs: 500 })
try {
  const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['shell.exec'] })
  const r = await hands.engine.execute({
    protocolVersion: '1', requestId: 'r1', invocationId: 'i1', capabilityId: 'shell.exec',
    authorization: { grantId: grant.grantId, workspaceId: 'w' },
    input: { command: 'Write-Output hello' }, limits: { timeoutSeconds: 20 }, idempotencyKey: 'k1',
  })
  console.log(JSON.stringify(r, null, 2))
} finally {
  await hands.dispose()
  rmSync(ws, { recursive: true, force: true })
}
