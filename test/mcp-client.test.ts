// agent-runner-mcp/test/mcp-client.test.ts —— 零依赖 MCP client 实测（EXP-1：协议层被 MCP client 调用）
// 判决：按 MCP 规范握手（initialize/tools-list/tools-call）→ 沙箱任务全链路 → EXIT 协议 → 尸检闭环
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts')

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) passed++
  else { failed++; console.log(`  ❌ ${name} ${detail}`) }
}

// 最小 MCP client：stdio JSON-RPC（Content-Length 帧发送 + newline 帧接收）
const child = spawn(process.execPath, ['--experimental-strip-types', SERVER], { stdio: ['pipe', 'pipe', 'inherit'] })
let rbuf = ''
const pending = new Map<number, (r: any) => void>()
let rid = 0
child.stdout.setEncoding('utf-8')
child.stdout.on('data', (d: string) => {
  rbuf += d
  for (;;) {
    const nl = rbuf.indexOf('\n')
    if (nl < 0) return
    const line = rbuf.slice(0, nl).trim()
    rbuf = rbuf.slice(nl + 1)
    if (line.length === 0) continue
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }
    const cb = pending.get(msg.id)
    if (cb !== undefined) { pending.delete(msg.id); cb(msg) }
  }
})
const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++rid
  pending.set(id, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n')
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 60000)
})

try {
  // 1) initialize 握手
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0.1.0' } })
  check('initialize 握手（协议版本协商）', init.result?.protocolVersion === '2024-11-05' && init.result?.capabilities?.tools !== undefined, JSON.stringify(init.result).slice(0, 80))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // 2) tools/list
  const tl = await rpc('tools/list')
  const names = (tl.result?.tools ?? []).map((t: any) => t.name)
  check('tools/list 六个工具', ['task_run', 'task_wait', 'task_output', 'task_autopsy', 'task_kill', 'task_adopt'].every(n => names.includes(n)), names.join(','))

  // 3) 全链路：task_run → task_wait → task_output → task_autopsy
  const runCmd = process.platform === 'win32' ? "Write-Output 'mcp-hello'; Start-Sleep -Milliseconds 300; Write-Output 'mcp-done'" : "echo mcp-hello; sleep 0.3; echo mcp-done"
  const run = await rpc('tools/call', { name: 'task_run', arguments: { command: runCmd, label: 'mcp-smoke' } })
  const runInfo = JSON.parse(run.result.content[0].text)
  check('task_run 返回 jobDir', typeof runInfo.jobDir === 'string' && runInfo.jobDir.includes('agent-runner-mcp-jobs'), runInfo.jobDir)
  check('task_run 平台 runner 匹配', runInfo.platform === process.platform, runInfo.runner)

  const wait = await rpc('tools/call', { name: 'task_wait', arguments: { jobDir: runInfo.jobDir, timeoutMs: 30000 } })
  const waitInfo = JSON.parse(wait.result.content[0].text)
  if (waitInfo.done === true && waitInfo.exitRaw === 'EXIT:-998') {
    // Windows CI 管理员环境：ACL 沙箱失效 → runner fail-closed（协议正确回应，witness 同款披露）
    check('Windows 管理员环境: runner fail-closed 协议生效', true, waitInfo.exitRaw)
  } else {
    check('task_wait 终态 EXIT:0', waitInfo.done === true && waitInfo.exitRaw === 'EXIT:0', JSON.stringify(waitInfo))
  }

  const out = await rpc('tools/call', { name: 'task_output', arguments: { jobDir: runInfo.jobDir } })
  const outInfo = JSON.parse(out.result.content[0].text)
  if (waitInfo.exitRaw === 'EXIT:-998') {
    check('fail-closed 环境: 输出保持空（runner 拒绝执行）', outInfo.content === '', JSON.stringify(outInfo.content.slice(0, 40)))
  } else {
    check('task_output 捕获输出', outInfo.content.includes('mcp-hello') && outInfo.content.includes('mcp-done'), JSON.stringify(outInfo.content.slice(0, 60)))
  }

  const ap = await rpc('tools/call', { name: 'task_autopsy', arguments: { jobDir: runInfo.jobDir } })
  const apInfo = JSON.parse(ap.result.content[0].text)
  if (waitInfo.exitRaw === 'EXIT:-998') {
    check('fail-closed 环境: 尸检 D-02（sandbox apply failed）', apInfo.death_code === 'D-02' && /sandbox apply failed/.test(apInfo.manner_of_death), JSON.stringify(apInfo))
  } else {
    check('task_autopsy 判决 completed/D-01', apInfo.verdict === 'completed' && apInfo.death_code === 'D-01', JSON.stringify(apInfo))
  }
  check('task_autopsy 证据列表', Array.isArray(apInfo.primary_evidence) && apInfo.primary_evidence.includes('exit.txt'), JSON.stringify(apInfo.primary_evidence))
  check('autopsy.json 落盘（任务目录外·观测方产物）', fs.existsSync(`${runInfo.jobDir}.autopsy.json`))

  // 4) 崩溃实验：task_run（长任务）→ task_kill（杀 runner=模拟 kill -9 崩溃）→ task_adopt → task_autopsy
  // 崩溃语义：runner 死了，exit.txt 没人写——收养方三证据判定 crashed-before-exit → D-08（autopsy-spec 分类学）
  const longCmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60'
  const run2 = await rpc('tools/call', { name: 'task_run', arguments: { command: longCmd, label: 'mcp-crash' } })
  const run2Info = JSON.parse(run2.result.content[0].text)
  // 等 lock 出现
  let lockReady = false
  for (let i = 0; i < 100; i++) {
    try {
      const lock = fs.readFileSync(path.join(run2Info.jobDir, 'lock'), 'utf-8').trim()
      if (/^\d+:\d+$/.test(lock)) { lockReady = true; break }
    } catch {}
    await new Promise(r => setTimeout(r, 50))
  }
  check('崩溃实验: lock 协议就位', lockReady)
  const kill = await rpc('tools/call', { name: 'task_kill', arguments: { jobDir: run2Info.jobDir } })
  const killInfo = JSON.parse(kill.result.content[0].text)
  check('task_kill 按 lock pid 击杀', killInfo.killed === true && killInfo.pid > 0, JSON.stringify(killInfo))

  const adopt = await rpc('tools/call', { name: 'task_adopt', arguments: { jobDir: run2Info.jobDir } })
  const adoptInfo = JSON.parse(adopt.result.content[0].text)
  check('task_adopt 三证据判定崩溃（无 exit）', adoptInfo.state === 'failed' && /crashed-before-exit/.test(adoptInfo.verdict), JSON.stringify(adoptInfo))

  const ap2 = await rpc('tools/call', { name: 'task_autopsy', arguments: { jobDir: run2Info.jobDir } })
  const ap2Info = JSON.parse(ap2.result.content[0].text)
  check('崩溃尸检 failed/D-08（exit 缺失）', ap2Info.verdict === 'failed' && ap2Info.death_code === 'D-08', JSON.stringify(ap2Info))

  // 5) 失败链路：命令 exit 1 → EXIT:1 → D-02（正常收尾的失败，与崩溃区分）
  const failCmd = process.platform === 'win32' ? 'Write-Output pre-line; exit 1' : 'echo pre-line; exit 1'
  const run3 = await rpc('tools/call', { name: 'task_run', arguments: { command: failCmd, label: 'mcp-fail' } })
  const run3Info = JSON.parse(run3.result.content[0].text)
  const wait3 = await rpc('tools/call', { name: 'task_wait', arguments: { jobDir: run3Info.jobDir, timeoutMs: 30000 } })
  const wait3Info = JSON.parse(wait3.result.content[0].text)
  if (wait3Info.exitRaw === 'EXIT:-998') {
    check('fail-closed 环境: 失败链路同样被拒执行（协议一致）', wait3Info.done === true, JSON.stringify(wait3Info))
  } else {
    check('失败任务 EXIT:1 协议', wait3Info.done === true && wait3Info.exitRaw === 'EXIT:1', JSON.stringify(wait3Info))
    const ap3 = await rpc('tools/call', { name: 'task_autopsy', arguments: { jobDir: run3Info.jobDir } })
    const ap3Info = JSON.parse(ap3.result.content[0].text)
    check('失败尸检 failed/D-02', ap3Info.verdict === 'failed' && ap3Info.death_code === 'D-02', JSON.stringify(ap3Info))
  }
} finally {
  child.kill()
}

console.log('='.repeat(66))
console.log(`  MCP client 实测（协议握手 + 沙箱全链路 + 崩溃收养）: ${passed} 通过 / ${failed} 失败`)
console.log('='.repeat(66))
process.exit(failed > 0 ? 1 : 0)
