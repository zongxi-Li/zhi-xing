import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStandaloneHands } from '../hands/index.ts'

// 专用隔离测试环境：项目内 .acl-test-env（非 OS 临时目录——ACL 授权要求 ambient temp root 在工作区外）
const envRoot = resolve('evidence', '.acl-smoke') // dedicated, removed after
mkdirSync(envRoot, { recursive: true })
const ws = mkdtempSync(join(envRoot, 'ws-'))
console.log('workspace:', ws)
const hands = await createStandaloneHands({ workspaceRoot: ws, confinement: 'acl', graceMs: 800 })
try {
  const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['fs.read', 'fs.write', 'shell.exec'] })
  const call = (capabilityId: any, input: any) => hands.engine.execute({
    protocolVersion: '1', requestId: `r${Math.random()}`, invocationId: 'i', capabilityId,
    authorization: { grantId: grant.grantId, workspaceId: 'w' }, input,
    limits: { timeoutSeconds: 30 }, idempotencyKey: `k${Math.random()}`,
  })

  // 1. shell 写工作区内 → 应成功
  const inside = await call('shell.exec', { command: 'Set-Content -LiteralPath ./inside.txt -Value "in-ws"; Write-Output INSIDE_OK' })
  console.log('[inside ]', inside.status, JSON.stringify(inside.error ?? (inside.output as any)?.stdout?.text?.trim()))

  // 2. shell 写工作区外（项目根的探针文件）→ 应被 OS 拒绝
  const outsidePath = resolve(envRoot, 'escape-probe.txt')
  const outside = await call('shell.exec', { command: `Set-Content -LiteralPath '${outsidePath}' -Value "escaped"; Write-Output OUTSIDE_OK` })
  console.log('[outside]', outside.status, 'exitCode:', (outside.output as any)?.exitCode, 'stderr:', JSON.stringify((outside.output as any)?.stderr?.text?.trim()?.slice(0, 200)))
  console.log('[outside] file exists (must be false):', existsSync(outsidePath))

  // 3. 工作区内读回
  if (existsSync(join(ws, 'inside.txt'))) console.log('[readback]', JSON.stringify(readFileSync(join(ws, 'inside.txt'), 'utf8').trim()))
} finally {
  await hands.dispose()
  try { rmSync(envRoot, { recursive: true, force: true }); console.log('cleanup: OK') } catch (e) { console.log('cleanup FAILED:', String(e)) }
}
