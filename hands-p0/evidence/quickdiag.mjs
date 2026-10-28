// quick: run one shell exec through the engine with error printing
process.chdir('C:/Users/LZX/Desktop/zhiyi Hands/hands-p0')
const { createStandaloneHands } = await import('../hands/index.ts')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const ws = mkdtempSync(join(tmpdir(), 'hands-qd-'))
const hands = await createStandaloneHands({ workspaceRoot: ws, graceMs: 500 })
try {
  const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['shell.exec'] })
  const r = await hands.engine.execute({
    protocolVersion: '1', requestId: 'r1', invocationId: 'i1', capabilityId: 'shell.exec',
    authorization: { grantId: grant.grantId, workspaceId: 'w' },
    input: { command: 'Write-Output hi' }, limits: { timeoutSeconds: 15 }, idempotencyKey: 'k',
  })
  console.log(JSON.stringify(r.error ?? r.output))
} finally { await hands.dispose() }
