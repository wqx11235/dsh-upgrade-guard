// dsh-upgrade-guard — host half.
//
// 让"更新 DSH 本体"不再打崩插件：升级前做兼容盘点、升级后做契约扫描、切换端口前做启动冒烟。
// 全部判据都来自真实故障复盘（服务被移除 / 会话消息 v4 source 契约 / 宿主 primitives 改名 …），
// 每排一次新坑就往 lib/guard.mjs 的 KNOWN_RULES 加一条。
//
// 重活都在 lib/guard.mjs（与独立 CLI 同一份文件），这里以子进程方式带着 --json 调它，
// 两边永远不会分叉。本文件只做：路径推导 + 路由 + 结果摘要。
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'lib', 'guard.mjs')
const PKG = '@deepseek-ai/dsh'

function dshHome() {
  return (process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/[\\/]+$/, '')
}

function outDir() {
  return join(dshHome(), 'upgrade-guard')
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

/** 本插件所在的 profile 目录：从插件自身向上找带 dsh.profile 的 package.json */
function findProfile() {
  let dir = HERE
  for (let i = 0; i < 8; i += 1) {
    const pkg = readJsonSafe(join(dir, 'package.json'))
    if (pkg && pkg.dsh && pkg.dsh.profile) return dir
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return null
}

/** 运行中的宿主：入口 bin.js、安装根、宿主的 ui-primitives 目录（都从 process.argv[1] 推导） */
function findHost() {
  const entry = process.argv[1]
  if (!entry) return { bin: null, root: null, primitives: null }
  let dir
  try { dir = dirname(realpathSync(entry)) } catch { dir = dirname(resolve(entry)) }
  for (let i = 0; i < 10; i += 1) {
    const pkg = readJsonSafe(join(dir, 'package.json'))
    if (pkg && pkg.name === PKG) {
      const root = resolve(dir, '..', '..')
      const primitives = resolve(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives')
      return { bin: entry, root, primitives: existsSync(primitives) ? primitives : null }
    }
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return { bin: entry, root: null, primitives: null }
}

function runCli(args, envExtra, timeoutMs = 600000) {
  return new Promise((resolvePromise) => {
    let out = ''
    let settled = false
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dshHome(),
      windowsHide: true,
      env: { ...process.env, ...envExtra },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolvePromise({ ok: false, code: null, output: out + `\n[timeout after ${Math.round(timeoutMs / 1000)}s]` })
    }, timeoutMs)
    const push = (chunk) => {
      out += chunk.toString()
      if (out.length > 200000) out = out.slice(-200000)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, code: null, output: out + '\n' + String((e && e.message) || e) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, output: out })
    })
  })
}

function parseGuardJson(output) {
  const i = String(output || '').indexOf('---JSON---')
  if (i < 0) return null
  try { return JSON.parse(String(output).slice(i + '---JSON---'.length)) } catch { return null }
}

function summariseScan(json) {
  let criticalCount = 0
  let warnCount = 0
  const topFindings = []
  for (const p of (json && json.results) || []) {
    for (const f of p.findings || []) {
      if (f.severity === 'critical') {
        criticalCount += 1
        if (topFindings.length < 8) topFindings.push(`${p.name}: ${f.rule} ${f.file}:${f.line}`)
      } else warnCount += 1
    }
  }
  return { criticalCount, warnCount, scanned: (json && json.scanned) || 0, topFindings }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function runScan(reportPath) {
  const res = await runCli(['scan', '--json', '--report', reportPath], {}, 180000)
  const json = parseGuardJson(res.output)
  const out = { kind: 'scan', reportPath, ok: Boolean(json), ...(json ? summariseScan(json) : {}) }
  if (!json) out.error = `scan 未返回 JSON（exit ${res.code}）；输出末尾：${String(res.output).slice(-400)}`
  return out
}

async function runPreflight(target, reportPath) {
  const res = await runCli(['preflight', '--json', '--report', reportPath, '--target', target || 'latest'], {}, 300000)
  const json = parseGuardJson(res.output)
  const out = { kind: 'preflight', reportPath, ok: Boolean(json) }
  if (json) {
    out.target = json.target
    out.rows = (json.rows || []).map((r) => ({
      name: r.name, installed: r.installed, spec: r.spec, kind: r.kind, latest: r.latest, notes: r.notes || [],
    }))
    out.stale = out.rows.filter((r) => /有新版可升/.test((r.notes || []).join(' '))).map((r) => `${r.name} ${r.installed} → ${r.latest}`)
  } else {
    out.error = `preflight 未返回 JSON（exit ${res.code}）`
  }
  return out
}

async function runSmoke(opts, reportPath) {
  const env = {
    DSH_SMOKE_PORT: String(opts.port || 3099),
    DSH_SMOKE_TIMEOUT: String(opts.timeout || 120),
  }
  if (opts.bin) env.DSH_SMOKE_BIN = opts.bin
  if (opts.cwd) env.DSH_SMOKE_CWD = opts.cwd
  const res = await runCli(['smoke'], env, (Number(opts.timeout || 120) + 120) * 1000)
  const text = String(res.output || '')
  const verdict = /RESULT\s+(PASS|FAIL)/.exec(text)
  const summary = /booted=.*$/m.exec(text)
  return {
    kind: 'smoke',
    ok: Boolean(verdict && verdict[1] === 'PASS'),
    verdict: verdict ? verdict[1] : 'UNKNOWN',
    summary: summary ? summary[0].trim() : '',
    reportPath,
    tail: text.split(/\r?\n/).filter((l) => l.trim()).slice(-25),
  }
}

export default {
  name: 'dsh-upgrade-guard',
  inject: ['webServer'],
  async apply(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    const profile = findProfile()
    const host = findHost()

    const paths = {
      profile: profile || join(dshHome(), 'profiles', 'web'),
      cli: CLI,
      bin: host.bin,
      installRoot: host.root,
      primitives: host.primitives,
      reports: outDir(),
    }

    async function handle(body) {
      const action = String(body.action || 'status')
      if (action === 'status') return { ok: true, paths }
      if (action === 'scan') {
        const r = await runScan(join(outDir(), `scan-${stamp()}.md`))
        return { ok: r.ok, result: r, paths }
      }
      if (action === 'preflight') {
        const r = await runPreflight(String(body.target || 'latest'), join(outDir(), `preflight-${stamp()}.md`))
        return { ok: r.ok, result: r, paths }
      }
      if (action === 'smoke') {
        const r = await runSmoke({
          bin: body.bin || paths.bin,
          cwd: body.cwd || paths.profile,
          port: body.port || 3099,
          timeout: body.timeout || 120,
        }, join(outDir(), `smoke-${stamp()}.md`))
        return { ok: r.ok, result: r, paths }
      }
      return { ok: false, error: `unknown action: ${action}` }
    }

    function sendJson(res, status, obj) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    }

    function readBody(req) {
      return new Promise((resolvePromise) => {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          try { resolvePromise(JSON.parse(raw || '{}')) } catch { resolvePromise({}) }
        })
      })
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/dsh-upgrade-guard',
      handler: async (req, res) => {
        try {
          const body = req.method === 'GET' ? {} : await readBody(req)
          if (req.method === 'GET' && !body.action) body.action = 'status'
          return sendJson(res, 200, await handle(body))
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }))
  },
}
