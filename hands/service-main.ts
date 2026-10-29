/**
 * ZhiYi Hands — service CLI entry (HANDS-02).
 *
 * Runs HandsService in a dedicated process so crash-recovery tests can kill it
 * for real. Reads a JSON config file; prints one `READY {json}` line on stdout
 * once listening (the test harness parses host/port from it); `--port 0` asks
 * for an ephemeral port.
 *
 *   tsx hands/service-main.ts --config path/to/config.json
 *
 * Config shape (all paths absolute or relative to the config file):
 *   {
 *     "workspaceRoot": "...",
 *     "credentialsFile": "...",   // {credentials:[{credentialId,secret}]}
 *     "grantsFile": "...",        // {grants:[...]} — server-side, hot-reloaded
 *     "dataDir": "...",           // ledger.jsonl lives here
 *     "host": "127.0.0.1",
 *     "port": 0,
 *     "confinement": "none" | "acl",
 *     "faults": { "afterClaim": false, "afterStarted": false }   // TEST ONLY
 *   }
 *
 * Secrets live only in the credentials file; they are never echoed, logged, or
 * returned in any response or receipt.
 */

import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { HandsService } from './service.ts'

interface ServiceMainConfig {
  workspaceRoot: string
  credentialsFile: string
  grantsFile: string
  dataDir: string
  host?: string
  port?: number
  confinement?: 'none' | 'acl'
  faults?: { afterClaim?: boolean; afterStarted?: boolean }
}

function fail(message: string): never {
  process.stderr.write(`hands-service: ${message}\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
const configIndex = args.indexOf('--config')
if (configIndex === -1 || args[configIndex + 1] === undefined) {
  fail('usage: tsx hands/service-main.ts --config <service-config.json>')
}
const configPath = resolve(args[configIndex + 1]!)

let parsed: ServiceMainConfig
try {
  parsed = JSON.parse(readFileSync(configPath, 'utf8')) as ServiceMainConfig
} catch (error) {
  fail(`cannot read config: ${error instanceof Error ? error.message : String(error)}`)
}
const baseDir = resolve(configPath, '..')
const absolutize = (p: string): string => resolve(baseDir, p)

for (const required of ['workspaceRoot', 'credentialsFile', 'grantsFile', 'dataDir'] as const) {
  if (typeof parsed[required] !== 'string' || parsed[required] === '') fail(`config field "${required}" is required`)
}

const service = new HandsService({
  workspaceRoot: absolutize(parsed.workspaceRoot),
  credentials: { file: absolutize(parsed.credentialsFile) },
  grants: { file: absolutize(parsed.grantsFile) },
  dataDir: absolutize(parsed.dataDir),
  ...(parsed.host === undefined ? {} : { host: parsed.host }),
  ...(parsed.port === undefined ? {} : { port: parsed.port }),
  ...(parsed.confinement === undefined ? {} : { confinement: parsed.confinement }),
  ...(parsed.faults === undefined ? {} : { faults: parsed.faults }),
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await service.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

const address = await service.start()
process.stdout.write(`READY ${JSON.stringify({ host: address.host, port: address.port })}\n`)
