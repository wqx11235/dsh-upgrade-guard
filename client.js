// dsh-upgrade-guard — client bundle (classic script, factory-form CJS).
//
// 设置 → 通用 里的一行「升级守卫」：升级前兼容盘点、升级后契约扫描、切换端口前启动冒烟。
// 数据来自宿主路由 POST /api/dsh-upgrade-guard。
window.__ModuleLoader__.load({
  id: 'dsh-upgrade-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var h = React.createElement
    var MUTED = 'var(--dsw-text-tertiary, #999)'
    var BORDER = 'var(--dsw-border, rgba(128,128,128,0.25))'
    var DANGER = 'var(--dsw-danger, #e06c6c)'
    var OK = 'var(--dsw-success, #4caf72)'

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
        style: {
          padding: '4px 12px', borderRadius: 6, fontSize: 12, marginRight: 6, whiteSpace: 'nowrap',
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

    function GuardRow() {
      var st = React.useState({ phase: 'idle', kind: null, result: null, paths: null, error: null })
      var s = st[0]
      var set = st[1]

      React.useEffect(function () {
        post('status').then(function (d) {
          set(function (prev) { return Object.assign({}, prev, { paths: d && d.paths ? d.paths : null }) })
        }).catch(function () { /* 忽略：status 失败不阻塞 */ })
      }, [])

      function run(kind) {
        set({ phase: 'busy', kind: kind, result: null, paths: s.paths, error: null })
        var payload = {}
        if (kind === 'smoke') { payload.port = 3099; payload.timeout = 120 }
        post(kind, payload).then(function (d) {
          var r = d && d.result ? d.result : null
          set({ phase: 'ready', kind: kind, result: r, paths: d && d.paths ? d.paths : s.paths, error: r && r.error ? r.error : (d && d.error ? d.error : null) })
        }).catch(function (e) {
          set({ phase: 'error', kind: kind, result: null, paths: s.paths, error: String(e) })
        })
      }

      var busy = s.phase === 'busy'
      var paths = s.paths || {}
      var r = s.result

      var header = '升级守卫'
      var sub = '升级 DSH 本体前先检查插件兼容性，升级后自检契约，切换端口前先冒烟。'

      var body = []
      if (r && r.kind === 'scan') {
        body.push(h(Line, { key: 'b1', color: r.criticalCount > 0 ? DANGER : OK },
          (r.criticalCount > 0 ? '⚠ 契约扫描：' : '✅ 契约扫描：') + 'critical ' + (r.criticalCount || 0) + ' / warn ' + (r.warnCount || 0) + '（扫了 ' + (r.scanned || 0) + ' 个插件）'))
        for (var i = 0; i < (r.topFindings || []).length; i++) body.push(h(Line, { key: 'f' + i }, '· ' + r.topFindings[i]))
        if (r.criticalCount > 0) body.push(h(Line, { key: 'b2' }, '建议：高风险插件先在 设置→插件 停用，或升级到适配版，再更新本体。'))
      }
      if (r && r.kind === 'preflight') {
        var stale = r.stale || []
        body.push(h(Line, { key: 'p1', color: stale.length ? 'var(--dsw-text-secondary, #aaa)' : OK },
          '📋 联网盘点（目标 ' + (r.target || 'latest') + '）：' + (r.rows || []).length + ' 个插件，' + stale.length + ' 个有新版'))
        for (var j = 0; j < Math.min(stale.length, 12); j++) body.push(h(Line, { key: 's' + j }, '· ' + stale[j]))
      }
      if (r && r.kind === 'smoke') {
        body.push(h(Line, { key: 'm1', color: r.verdict === 'PASS' ? OK : DANGER },
          (r.verdict === 'PASS' ? '✅ 启动冒烟：PASS' : '❌ 启动冒烟：' + r.verdict) + (r.summary ? '  ·  ' + r.summary : '')))
        var tail = r.tail || []
        for (var k = 0; k < tail.length; k++) {
          var t = String(tail[k])
          var isBad = /(FAIL|ROOT\?|SKIPPED|DEGRADED|BADBUNDLE|PENDING)/.test(t)
          body.push(h(Line, { key: 't' + k, color: isBad ? DANGER : MUTED }, t.slice(0, 190)))
        }
        if (r.verdict === 'PASS') body.push(h(Line, { key: 'm2' }, '可以切换端口/重启生效；FAIL 时不要切，先按提示处理。'))
        else body.push(h(Line, { key: 'm3' }, '不要切换：上面 ROOT?/PENDING/SKIPPED 就是原因；SCANNED 契约类问题用「契约扫描」定位。'))
      }
      if (s.error) body.push(h(Line, { key: 'err', color: DANGER }, '出错：' + s.error))
      if (busy) body.push(h(Line, { key: 'busy' }, (s.kind === 'smoke' ? '启动冒烟中（会先在 3099 起一个测试宿主，约 30–90 秒）…' : (s.kind === 'preflight' ? '联网盘点中（逐个查 npm，约 10–40 秒）…' : '扫描中…'))))

      return h('div', { style: { padding: '10px 0' } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, header),
        h('div', { style: { fontSize: 12, color: MUTED, marginTop: 3 } }, sub),
        h('div', { style: { marginTop: 8 } },
          h(Btn, { onClick: function () { run('scan') }, disabled: busy }, s.kind === 'scan' && busy ? '扫描中…' : '契约扫描'),
          h(Btn, { onClick: function () { run('preflight') }, disabled: busy }, s.kind === 'preflight' && busy ? '盘点中…' : '联网盘点'),
          h(Btn, { primary: true, onClick: function () { run('smoke') }, disabled: busy }, s.kind === 'smoke' && busy ? '冒烟中…' : '启动冒烟'),
          r && r.reportPath ? h(Btn, { onClick: function () { try { navigator.clipboard.writeText(r.reportPath) } catch (e) { /* ignore */ } } }, '复制报告路径') : null,
        ),
        body.length ? h('div', { style: { marginTop: 6 } }, body) : null,
        paths.profile ? h(Line, { key: 'paths' }, 'profile ' + paths.profile + '  ·  宿主 ' + (paths.installRoot || '?') + (paths.primitives ? '  ·  primitives ✓' : '  ·  primitives ✗')) : null,
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
