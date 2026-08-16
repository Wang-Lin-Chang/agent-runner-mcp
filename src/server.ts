// agent-runner-mcp/src/server.ts —— 零依赖 MCP server（stdio JSON-RPC）
// 把三平台沙箱 runner 协议暴露为 MCP 工具：task_run / task_wait / task_output / task_autopsy / task_kill / task_adopt
// 传输层：双帧支持——LSP 风格 Content-Length 头（旧客户端）+ newline-delimited JSON（新客户端，2025-03-26+）
// 协议版本：回退协商 2024-11-05（Claude Code 兼容面）
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor')
const runnerName = () => process.platform === 'win32' ? 'detach-runner.cjs' : process.platform === 'darwin' ? 'detach-runner-macos.cjs' : 'detach-runner-linux.cjs'
const ROOT = path.join(os.tmpdir(), 'agent-runner-mcp-jobs')
fs.mkdirSync(ROOT, { recursive: true })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const readMaybe = (p: string) => { try { return fs.readFileSync(p, 'utf-8') } catch { return undefined } }

// ---------- 工具实现 ----------
function taskRun(args: any) {
  const jobDir = fs.mkdtempSync(path.join(ROOT, 'job-'))
  const outFile = path.join(jobDir, 'out.log')
  const exitFile = path.join(jobDir, 'exit.txt')
  const cmdB64 = Buffer.from(String(args.command ?? ''), 'utf-8').toString('base64')
  const runnerArgs = [path.join(VENDOR, runnerName()), jobDir, outFile, exitFile, cmdB64]
  if (process.platform === 'linux') runnerArgs.push('bwrap')
  const child = spawn(process.execPath, runnerArgs, { detached: true, stdio: 'ignore', windowsHide: true })
  return {
    content: [{ type: 'text', text: JSON.stringify({
      jobDir, outFile, exitFile, platform: process.platform, runner: runnerName(),
      note: 'runner writes lock=pid:startSec, sandboxes the task, and writes EXIT:<code> on completion',
    }) }],
  }
}

async function taskWait(args: any) {
  const exitFile = path.join(String(args.jobDir ?? ''), 'exit.txt')
  const timeout = Number(args.timeoutMs ?? 30000)
  const deadline = Date.now() + timeout
  for (;;) {
    const raw = readMaybe(exitFile)
    if (raw !== undefined && /^EXIT:/.test(raw.trim())) {
      return { content: [{ type: 'text', text: JSON.stringify({ exitRaw: raw.trim(), done: true }) }] }
    }
    if (Date.now() > deadline) return { content: [{ type: 'text', text: JSON.stringify({ done: false, reason: 'timeout', exitRaw: readMaybe(exitFile) ?? null }) }] }
    await sleep(100)
  }
}

function taskOutput(args: any) {
  const outFile = path.join(String(args.jobDir ?? ''), 'out.log')
  const offset = Number(args.offset ?? 0)
  const text = readMaybe(outFile) ?? ''
  return { content: [{ type: 'text', text: JSON.stringify({ content: text.slice(offset), totalBytes: Buffer.byteLength(text) }) }] }
}

function taskAutopsy(args: any) {
  const jobDir = String(args.jobDir ?? '')
  const exitRaw = readMaybe(path.join(jobDir, 'exit.txt'))
  const m = exitRaw !== undefined ? /^EXIT:(-?\d+)$/.exec(exitRaw.trim()) : null
  const code = m !== null ? Number(m[1]) : undefined
  const evidence: string[] = []
  for (const f of ['lock', 'exit.txt', 'out.log']) if (fs.existsSync(path.join(jobDir, f))) evidence.push(f)
  let deathCode: string, manner: string, verdict: string
  if (code === -999) { deathCode = 'D-06'; manner = 'evidence tampered by task'; verdict = 'tampered' }
  else if (code === -998) { deathCode = 'D-02'; manner = 'sandbox apply failed, runner failed closed'; verdict = 'failed' }
  else if (code === 0) { deathCode = 'D-01'; manner = 'completed normally'; verdict = 'completed' }
  else if (code === undefined) { deathCode = 'D-08'; manner = 'no exit file (crash before exit write)'; verdict = 'failed' }
  else { deathCode = 'D-02'; manner = 'exited non-zero'; verdict = 'failed' }
  // server 级最小尸检（对齐 autopsy-spec 分类学；registry 级完整尸检见 dsh-witness）
  // 报告落任务目录外的兄弟文件：任务目录受 runner ACL deny 保护（任务结束后仍有效——MCP 实测 EPERM 证据），
  // 观测方产物不得写入证据区（协议纪律：观测与证据分离）
  const report = { manner_of_death: manner, primary_evidence: evidence, verdict, death_code: deathCode, exit_code: code, at: Date.now() }
  const autopsyPath = `${jobDir}.autopsy.json`
  fs.writeFileSync(autopsyPath, JSON.stringify(report, null, 2))
  return { content: [{ type: 'text', text: JSON.stringify(report) }] }
}

function taskKill(args: any) {
  const jobDir = String(args.jobDir ?? '')
  const lock = readMaybe(path.join(jobDir, 'lock'))
  const m = lock !== undefined ? /^(\d+):(\d+)$/.exec(lock.trim()) : null
  if (m === null) return { content: [{ type: 'text', text: JSON.stringify({ killed: false, reason: 'no valid lock' }) }] }
  try { process.kill(Number(m[1]), 'SIGKILL') } catch { return { content: [{ type: 'text', text: JSON.stringify({ killed: false, reason: 'process already dead', pid: Number(m[1]) }) }] } }
  return { content: [{ type: 'text', text: JSON.stringify({ killed: true, pid: Number(m[1]), note: 'adoption evidence preserved: lock content + exit protocol' }) }] }
}

/** 进程启动时间（epoch 秒，三平台公式；失败返回 undefined——保守失败语义） */
function procStartSec(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `[int](Get-Date -Date (Get-Process -Id ${pid}).StartTime.ToUniversalTime() -UFormat %s)`], { timeout: 5000, windowsHide: true })
      const t = Number(r.stdout.toString('utf-8').trim())
      return Number.isFinite(t) && t > 0 ? t : undefined
    }
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const btime = Number(fs.readFileSync('/proc/stat', 'utf-8').match(/btime (\d+)/)?.[1] ?? 0)
      const t = Math.floor(btime + Number(after[19]) / 100)
      return Number.isFinite(t) && t > 0 ? t : undefined
    }
    const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 8000 })
    const m = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(r.stdout.toString('utf-8').trim())
    if (m === null) return undefined
    const t = Math.floor(new Date(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000)
    return Number.isFinite(t) && t > 0 ? t : undefined
  } catch { return undefined }
}

/** 僵尸进程判定：Linux /proc state=='Z'；macOS ps stat 含 'Z'；Windows 无僵尸态 */
function isZombie(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return after[0] === 'Z'
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 8000 })
      return /Z/.test(r.stdout.toString('utf-8'))
    }
  } catch { /* 进程已消失 */ }
  return false
}

function taskAdopt(args: any) {
  // 三证据收养判定（对齐 dsh-witness）：① lock 解析 ② 进程存活 ③ 启动时间比对（防僵尸/PID 复用）
  // 僵尸进程教训（macOS CI 实测）：SIGKILL 后父进程未回收，kill(pid,0) 对僵尸仍成功——第三证据判死
  const jobDir = String(args.jobDir ?? '')
  const lock = readMaybe(path.join(jobDir, 'lock'))
  const m = lock !== undefined ? /^(\d+):(\d+)$/.exec(lock.trim()) : null
  if (m === null) return { content: [{ type: 'text', text: JSON.stringify({ state: 'no-lock', note: 'already finalized or never started' }) }] }
  const pid = Number(m[1])
  const lockStart = Number(m[2])
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  if (alive && isZombie(pid)) alive = false   // 僵尸：SIGKILL 后父进程未回收，进程表项残留（启动时间不变）——状态位判死
  if (alive) {
    const cur = procStartSec(pid)
    if (cur === undefined || cur === lockStart) {
      return { content: [{ type: 'text', text: JSON.stringify({ state: 'running', pid, lock }) }] }
    }
    alive = false   // 启动时间不匹配：PID 复用 → 判死
  }
  const exitRaw = readMaybe(path.join(jobDir, 'exit.txt'))
  const verdict = exitRaw !== undefined ? `finalized-from-exit ${exitRaw.trim()}` : 'crashed-before-exit (orphaned, finalize failed)'
  return { content: [{ type: 'text', text: JSON.stringify({ state: exitRaw !== undefined ? 'done' : 'failed', pid, verdict, note: 'three-evidence adoption: lock pid dead + start-time match + exit protocol read' }) }] }
}

// ---------- MCP 协议层（JSON-RPC 2.0 over stdio） ----------
const TOOLS = [
  { name: 'task_run', description: 'Run a command inside the evidence-protected sandbox runner (platform ACL/bwrap/sandbox-exec). Returns the job directory; the runner writes lock=pid:startSec and EXIT:<code> on completion.', inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'Command to execute (platform shell)' }, label: { type: 'string' } }, required: ['command'] } },
  { name: 'task_wait', description: 'Wait for a task to reach a terminal state (EXIT:<code> written).', inputSchema: { type: 'object', properties: { jobDir: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['jobDir'] } },
  { name: 'task_output', description: 'Read task output from out.log (with byte offset for incremental reads).', inputSchema: { type: 'object', properties: { jobDir: { type: 'string' }, offset: { type: 'number' } }, required: ['jobDir'] } },
  { name: 'task_autopsy', description: 'Generate an autopsy report (autopsy-spec format: manner/evidence/verdict/death-code D-01~D-09) for a task directory.', inputSchema: { type: 'object', properties: { jobDir: { type: 'string' } }, required: ['jobDir'] } },
  { name: 'task_kill', description: 'Kill a running task by its lock pid (SIGKILL) — for crash/adoption experiments.', inputSchema: { type: 'object', properties: { jobDir: { type: 'string' } }, required: ['jobDir'] } },
  { name: 'task_adopt', description: 'Three-evidence adoption check: lock pid:startSec parsing + process liveness + exit protocol read.', inputSchema: { type: 'object', properties: { jobDir: { type: 'string' } }, required: ['jobDir'] } },
]

let nextId = 1
function respond(msg: any, result?: unknown, error?: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...(error !== undefined ? { error } : { result }) }) + '\n')
}

async function handle(msg: any) {
  if (msg.method === 'initialize') {
    respond(msg, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-runner-mcp', version: '0.1.0' },
    })
  } else if (msg.method === 'notifications/initialized') {
    // no response
  } else if (msg.method === 'tools/list') {
    respond(msg, { tools: TOOLS })
  } else if (msg.method === 'tools/call') {
    const name = msg.params?.name
    const args = msg.params?.arguments ?? {}
    const fn = ({ task_run: taskRun, task_wait: taskWait, task_output: taskOutput, task_autopsy: taskAutopsy, task_kill: taskKill, task_adopt: taskAdopt } as any)[name]
    if (fn === undefined) { respond(msg, undefined, { code: -32601, message: `unknown tool ${name}` }); return }
    try { respond(msg, await fn(args)) } catch (e: any) { respond(msg, undefined, { code: -32603, message: String(e.message ?? e).slice(0, 200) }) }
  } else if (msg.method === 'ping') {
    respond(msg, {})
  } else if (msg.id !== undefined) {
    respond(msg, undefined, { code: -32601, message: `unknown method ${msg.method}` })
  }
}

// ---------- 帧读取：Content-Length 头 + newline JSON 双支持 ----------
let buf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk: string) => {
  buf += chunk
  for (;;) {
    // LSP 帧
    const clm = /^Content-Length: (\d+)\r?\n\r?\n/.exec(buf)
    if (clm !== null) {
      const len = Number(clm[1])
      if (Buffer.byteLength(buf.slice(clm[0].length)) < len) return
      const body = buf.slice(clm[0].length, clm[0].length + len)
      buf = buf.slice(clm[0].length + len)
      try { void handle(JSON.parse(body)) } catch { /* 坏帧跳过 */ }
      continue
    }
    // newline JSON 帧
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line.length === 0) continue
    try { void handle(JSON.parse(line)) } catch { /* 坏帧跳过 */ }
  }
})
process.stdin.on('end', () => process.exit(0))
