// dsh-upgrade-guard — client half (lib/client.js)
//
// 设置 → 通用 里的一行「升级守卫」：升级前兼容盘点 / 升级后契约扫描 / 切换端口前启动冒烟。
// 数据来自宿主路由 POST /api/dsh-upgrade-guard（直挂 webServer，不受 0.1.2+ 会话认证影响）。
//
// 兼容要点（两代 DSH 都能跑）：
//   · 0.1.2 起 client 插件必须 `exports.inject = ['slots']`，否则访问 ctx.slots 会抛
//     `cannot get property "slots" without inject`，整棵插件树直接失败；
//   · 同一版本起 `ctx.get('slots')` 不再返回服务（静默 undefined），必须走 ctx.slots；
//   · 只 require('react')——平台内置词，不占用任何包 factory，所以 0.1.2 的
//     client-modules 模块表收紧打不到这里。
window.__ModuleLoader__.load({
  id: 'dsh-upgrade-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var h = React.createElement
    var MUTED = 'var(--dsw-text-tertiary, #999)'
    var SUB = 'var(--dsw-text-secondary, #aaa)'
    var BORDER = 'var(--dsw-border, rgba(128,128,128,0.25))'
    var DANGER = 'var(--dsw-danger, #e06c6c)'
    var OK = 'var(--dsw-success, #4caf72)'
    var WARN = 'var(--dsw-warning, #d9a441)'

    function post(action, payload) {
      return fetch('/api/dsh-upgrade-guard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      }).then(function (r) { return r.json() })
    }

    function Btn(props) {
      return h('button', {
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
        style: {
          padding: '4px 12px', borderRadius: 6, fontSize: 12, marginRight: 6, marginBottom: 4, whiteSpace: 'nowrap',
          cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? 0.5 : 1,
          border: '1px solid ' + BORDER,
          background: props.primary ? 'rgba(90,150,255,0.18)' : 'var(--dsw-surface, rgba(255,255,255,0.04))',
          color: 'inherit',
        },
      }, props.children)
    }

    function Line(props) {
      return h('div', { style: { fontSize: 11, color: props.color || MUTED, marginTop: 3, wordBreak: 'break-all' } }, props.children)
    }

    function secs(ms) { return Math.round(ms / 1000) + 's' }

    function GuardRow() {
      var st = React.useState({ phase: 'idle', kind: null, result: null, paths: null, host: null, error: null, t0: 0 })
      var s = st[0]
      var set = st[1]
      var tick = React.useState(0)
      var setTick = tick[1]
      var copied = React.useState(false)

      React.useEffect(function () {
        post('status').then(function (d) {
          set(function (prev) {
            return Object.assign({}, prev, {
              paths: (d && d.paths) || null,
              host: (d && d.host) || null,
              error: d && d.error ? String(d.error) : prev.error,
            })
          })
        }).catch(function (e) {
          set(function (prev) { return Object.assign({}, prev, { error: '无法连接宿主路由：' + String(e) }) })
        })
      }, [])

      // 长任务计时：冒烟 30–90 秒、盘点 10–40 秒，不给反馈会让人以为卡死
      React.useEffect(function () {
        if (s.phase !== 'busy') return undefined
        var iv = setInterval(function () { setTick(function (n) { return n + 1 }) }, 1000)
        return function () { clearInterval(iv) }
      }, [s.phase])

      function run(kind) {
        var payload = {}
        if (kind === 'smoke') { payload.port = 3099; payload.timeout = 120 }
        set({ phase: 'busy', kind: kind, result: null, paths: s.paths, host: s.host, error: null, t0: Date.now() })
        post(kind, payload).then(function (d) {
          var r = (d && d.result) || null
          set({
            phase: 'ready', kind: kind, result: r,
            paths: (d && d.paths) || s.paths,
            host: (d && d.host) || s.host,
            error: (r && r.error) || (d && d.error) || null,
            t0: 0,
          })
        }).catch(function (e) {
          set({ phase: 'error', kind: kind, result: null, paths: s.paths, host: s.host, error: String(e), t0: 0 })
        })
      }

      function copy(text) {
        try {
          navigator.clipboard.writeText(text)
          copied[1](true)
          setTimeout(function () { copied[1](false) }, 1500)
        } catch (e) { /* 剪贴板不可用就算了 */ }
      }

      var busy = s.phase === 'busy'
      var paths = s.paths || {}
      var host = s.host || {}
      var r = s.result

      var body = []

      if (r && r.kind === 'scan') {
        body.push(h(Line, { key: 'b1', color: r.criticalCount > 0 ? DANGER : OK },
          (r.criticalCount > 0 ? '⚠ 契约扫描：' : '✅ 契约扫描：') + 'critical ' + (r.criticalCount || 0) +
          ' / warn ' + (r.warnCount || 0) + '（扫了 ' + (r.scanned || 0) + ' 个插件）'))
        for (var i = 0; i < (r.topFindings || []).length; i++) body.push(h(Line, { key: 'f' + i }, '· ' + r.topFindings[i]))
        if (r.criticalCount > 0) {
          body.push(h(Line, { key: 'b2' }, '建议：高风险插件先在 设置→插件 停用，或升级到适配版，再更新本体。'))
        }
      }

      if (r && r.kind === 'preflight') {
        var stale = r.stale || []
        body.push(h(Line, { key: 'p1', color: stale.length ? SUB : OK },
          '📋 联网盘点（目标 ' + (r.target || 'latest') + '）：' + (r.rows || []).length + ' 个插件，' + stale.length + ' 个有新版'))
        for (var j = 0; j < Math.min(stale.length, 12); j++) body.push(h(Line, { key: 's' + j }, '· ' + stale[j]))
      }

      if (r && r.kind === 'smoke') {
        var pass = r.verdict === 'PASS'
        var color = pass ? OK : (r.verdict === 'UNSUPPORTED' ? WARN : DANGER)
        body.push(h(Line, { key: 'm1', color: color },
          (pass ? '✅ 启动冒烟：PASS' : (r.verdict === 'UNSUPPORTED' ? '⚠ 启动冒烟：当前运行时不可用' : '❌ 启动冒烟：' + r.verdict)) +
          (r.summary ? '  ·  ' + r.summary : '')))
        var tail = r.tail || []
        for (var k = 0; k < tail.length; k++) {
          var t = String(tail[k])
          var isBad = /(FAIL|ROOT\?|SKIPPED|DEGRADED|BADBUNDLE|PENDING)/.test(t)
          body.push(h(Line, { key: 't' + k, color: isBad ? DANGER : MUTED }, t.slice(0, 190)))
        }
        if (pass) body.push(h(Line, { key: 'm2' }, '可以切换端口/重启生效；FAIL 时不要切，先按提示处理。'))
        else if (r.verdict !== 'UNSUPPORTED') {
          body.push(h(Line, { key: 'm3' }, '不要切换：上面 ROOT?/PENDING/SKIPPED 就是原因；契约类问题用「契约扫描」定位。'))
        }
      }

      if (s.error) body.push(h(Line, { key: 'err', color: DANGER }, '出错：' + s.error))
      if (busy) {
        var what = s.kind === 'smoke' ? '启动冒烟中（会先在测试端口起一个宿主，约 30–90 秒）'
          : s.kind === 'preflight' ? '联网盘点中（逐个查 npm，约 10–40 秒）' : '扫描中'
        body.push(h(Line, { key: 'busy' }, what + '… 已用 ' + secs(Date.now() - s.t0)))
      }

      // 诚实标注：扫出来的"宿主导出表"来自哪一份 primitives——桌面端打包运行时只能拿到共享树那份，
      // 与真正在跑的宿主版本可能不同，这时结论要打折看。
      var primMismatch = host.primitivesVersion && host.version && host.primitivesVersion !== host.version
      var footer = []
      if (host.version || host.bin) {
        footer.push(h(Line, { key: 'h1' },
          '宿主 ' + (host.version || '?') + '  ·  运行时 ' + (host.runtime || '?') + '  ·  插件 0.2.0'))
      }
      if (paths.profile) {
        footer.push(h(Line, { key: 'h2' },
          'profile ' + paths.profileName + ' (' + paths.profileSource + ')  ·  primitives ' +
          (host.primitivesSource || 'none') + (host.primitivesVersion ? ' ' + host.primitivesVersion : '')))
      }
      if (primMismatch) {
        footer.push(h(Line, { key: 'h3', color: WARN },
          '注意：primitives 导出表来自 ' + host.primitivesVersion + '，与在跑的宿主 ' + host.version +
          ' 不同；「引用了不存在的导出」这类结论请以真实宿主为准。'))
      }
      if (host.packaged) {
        footer.push(h(Line, { key: 'h4', color: MUTED }, '打包桌面运行时：启动冒烟不可用（入口在 app.asar 内）。'))
      }

      return h('div', { style: { padding: '10px 0' } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, '升级守卫'),
        h('div', { style: { fontSize: 12, color: MUTED, marginTop: 3 } },
          '升级 DSH 本体前先检查插件兼容性，升级后自检契约，切换端口前先冒烟。'),
        h('div', { style: { marginTop: 8 } },
          h(Btn, { onClick: function () { run('scan') }, disabled: busy }, s.kind === 'scan' && busy ? '扫描中…' : '契约扫描'),
          h(Btn, { onClick: function () { run('preflight') }, disabled: busy }, s.kind === 'preflight' && busy ? '盘点中…' : '联网盘点'),
          h(Btn, {
            primary: true,
            onClick: function () { run('smoke') },
            disabled: busy,
            title: host.packaged ? '打包桌面运行时不可用' : '会在测试端口起一个临时宿主，结束必杀',
          }, s.kind === 'smoke' && busy ? '冒烟中…' : '启动冒烟'),
          r && r.reportPath ? h(Btn, { onClick: function () { copy(r.reportPath) } }, copied[0] ? '已复制' : '复制报告路径') : null,
        ),
        body.length ? h('div', { style: { marginTop: 6 } }, body) : null,
        footer.length ? h('div', { style: { marginTop: 8, paddingTop: 6, borderTop: '1px solid ' + BORDER } }, footer) : null,
      )
    }

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      var slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots) return
      slots.inject('settings.general.item', function () {
        return slots.register(
          { name: 'settings.general.item', id: 'upgrade-guard', order: 31 },
          function () { return h(GuardRow, null) },
        )
      })
    }
    return module.exports
  },
})
