// Extensão do Chrome pela ponte: pareamento sem login, token de dispositivo, isolamento entre contas, revogação e roteamento de comandos.
process.env.LIMITE_MULT = '1000'
process.env.SESSION_SECRET = 'segredo-de-teste'
process.env.EXT_TEMPO_MS = '600' // comando sem resposta vira timeout rápido nos testes
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const WebSocket = require('ws')

let acesso, ponte, urlPonte, portaPonte
const SENHA = 'senha-forte-123'
const CHAVE_ANA = 'sk-chave-da-maquina-0001'
const CHAVE_BIA = 'sk-chave-de-outra-conta'
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

test.before(async () => {
  acesso = http.createServer((req, res) => {
    let t = ''
    req.on('data', (d) => (t += d))
    req.on('end', () => {
      const out = (st, o) => (res.writeHead(st, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)))
      if (req.url === '/v1/auth/verify') {
        const b = JSON.parse(t || '{}')
        if (b.email === 'ana@x.com' && b.password === SENHA) return out(200, { account_id: 7, email: 'ana@x.com', name: 'Ana' })
        if (b.email === 'bia@x.com' && b.password === SENHA) return out(200, { account_id: 9, email: 'bia@x.com', name: 'Bia' })
        return out(401, { error: { message: 'e-mail ou senha incorretos' } })
      }
      if (req.url === '/v1/auth/whoami') {
        const k = req.headers.authorization
        if (k === 'Bearer ' + CHAVE_ANA) return out(200, { account_id: 7 })
        if (k === 'Bearer ' + CHAVE_BIA) return out(200, { account_id: 9 })
        return out(401, {})
      }
      out(404, {})
    })
  })
  await new Promise((r) => acesso.listen(0, '127.0.0.1', r))
  process.env.ACCESS_URL = 'http://127.0.0.1:' + acesso.address().port
  ponte = require('../server').servidor
  await new Promise((r) => ponte.listen(0, '127.0.0.1', r))
  portaPonte = ponte.address().port
  urlPonte = 'http://127.0.0.1:' + portaPonte
})
test.after(() => {
  acesso.close()
  ponte.close()
  ponte.closeAllConnections?.()
  setImmediate(() => process.exit(0))
})

const post = (rota, corpo, h = {}) => fetch(urlPonte + rota, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(corpo || {}) })
async function entrar(email) {
  const r = await post('/api/entrar', { email, senha: SENHA })
  return (r.headers.get('set-cookie') || '').split(';')[0]
}
const abrir = (rota, opts) => new Promise((res, rej) => {
  const w = new WebSocket('ws://127.0.0.1:' + portaPonte + rota, opts)
  w.fila = []
  w.on('message', (d) => w.fila.push(JSON.parse(String(d))))
  w.once('open', () => res(w))
  w.once('error', rej)
  w.once('unexpected-response', (_q, p) => rej(new Error('http ' + p.statusCode)))
})
const proxima = (w, filtro = () => true, ms = 3000) => new Promise((res, rej) => {
  const achar = () => { const i = w.fila.findIndex(filtro); if (i < 0) return false; res(w.fila.splice(i, 1)[0]); return true }
  if (achar()) return
  const t = setTimeout(() => { w.off('message', f); rej(new Error('sem mensagem')) }, ms)
  const f = () => achar() && (clearTimeout(t), w.off('message', f))
  w.on('message', f)
})
const fechou = (w) => new Promise((res) => (w.readyState === 3 ? res(w._closeCode) : w.once('close', (c) => res(c))))

// pareia uma extensão de uma conta pelo cookie do remoto e devolve o token de dispositivo
async function parearPorCookie(cookie, nome = 'Chrome de teste') {
  const p = await (await post('/api/extensao/parear', {}, { Cookie: cookie })).json()
  assert.ok(p.token, 'token de pareamento')
  const reg = await post('/api/extensao/registrar', { token: p.token, nome, versao: '0.1.0' }, { Origin: EXT })
  assert.equal(reg.status, 200)
  return { ...(await reg.json()), pareamento: p.token }
}
const conectarExt = async (token, extra = {}) => {
  const w = await abrir('/ws/extensao', { headers: { Origin: EXT } })
  w.send(JSON.stringify({ t: 'ola', token, nome: 'Chrome de teste', versao: '0.1.0', ...extra }))
  await proxima(w, (m) => m.t === 'ok')
  return w
}
const conectarApp = async (chave, id) => {
  const w = await abrir('/ws/maquina', { headers: { Authorization: 'Bearer ' + chave } })
  w.send(JSON.stringify({ t: 'hello', maquinaId: id, nome: 'PC ' + id, tipo: 'desktop', versao: '0.6.57' }))
  await proxima(w, (m) => m.t === 'ok')
  return w
}

test('parear exige login; o app pareia pela chave da conta, sem digitar nada', async () => {
  assert.equal((await post('/api/extensao/parear', {})).status, 401)
  assert.equal((await post('/api/extensao/parear-app', {}, { Authorization: 'Bearer chave-ruim-123456' })).status, 401)
  const r = await post('/api/extensao/parear-app', {}, { Authorization: 'Bearer ' + CHAVE_ANA })
  assert.equal(r.status, 200)
  assert.match((await r.json()).token, /^sbp\./)
})

test('token de pareamento serve uma vez só e não vale como cookie nem como token de dispositivo', async () => {
  const cookie = await entrar('ana@x.com')
  const p = (await (await post('/api/extensao/parear', {}, { Cookie: cookie })).json()).token
  assert.equal((await post('/api/extensao/registrar', { token: p, nome: 'A' }, { Origin: EXT })).status, 200)
  assert.equal((await post('/api/extensao/registrar', { token: p, nome: 'A' }, { Origin: EXT })).status, 400) // já usado
  assert.equal((await post('/api/extensao/registrar', { token: 'sbp.x.y' }, { Origin: EXT })).status, 400)
  assert.equal((await post('/api/extensao/registrar', { token: p }, { Origin: 'https://site-malicioso.com' })).status, 403)
  const ws = await abrir('/ws/extensao', { headers: { Origin: EXT } })
  ws.send(JSON.stringify({ t: 'ola', token: p })) // token de pareamento não é de dispositivo
  assert.equal(await fechou(ws), 4001)
})

test('o WebSocket da extensão só aceita Origin de extensão', async () => {
  await assert.rejects(abrir('/ws/extensao', { headers: { Origin: 'https://remoto.rangeltech.net' } }))
  await assert.rejects(abrir('/ws/extensao'))
})

test('comando do app chega à extensão da mesma conta e a resposta volta; o app vê o estado', async () => {
  const cookie = await entrar('ana@x.com')
  const { token } = await parearPorCookie(cookie)
  const app = await conectarApp(CHAVE_ANA, 'pc-ana-1')
  const estado0 = await proxima(app, (m) => m.t === 'ext-estado')
  assert.equal(estado0.conectado, false)
  const ext = await conectarExt(token)
  const estado1 = await proxima(app, (m) => m.t === 'ext-estado' && m.conectado)
  assert.equal(estado1.pausada, false)
  app.send(JSON.stringify({ t: 'ext-cmd', rid: 'r1', acao: 'abrir', args: { url: 'https://example.com' } }))
  const cmd = await proxima(ext, (m) => m.t === 'cmd')
  assert.deepEqual([cmd.acao, cmd.args.url], ['abrir', 'https://example.com'])
  ext.send(JSON.stringify({ t: 'r', rid: cmd.rid, ok: true, dado: { titulo: 'Exemplo' } }))
  const r = await proxima(app, (m) => m.t === 'ext-r')
  assert.deepEqual([r.rid, r.ok, r.dado.titulo], ['r1', true, 'Exemplo'])
  ext.send(JSON.stringify({ t: 'ping' }))
  await proxima(ext, (m) => m.t === 'pong')
  app.close(); ext.close()
})

test('contas diferentes não se enxergam', async () => {
  const ca = await entrar('ana@x.com'), cb = await entrar('bia@x.com')
  const ta = (await parearPorCookie(ca)).token
  const appBia = await conectarApp(CHAVE_BIA, 'pc-bia')
  const extAna = await conectarExt(ta)
  // a máquina da Bia não vê a extensão da Ana
  appBia.send(JSON.stringify({ t: 'ext-cmd', rid: 'x1', acao: 'ler', args: {} }))
  const r = await proxima(appBia, (m) => m.t === 'ext-r')
  assert.deepEqual([r.ok, r.codigo], [false, 'sem_extensao'])
  assert.equal(extAna.fila.filter((m) => m.t === 'cmd').length, 0)
  // a lista de dispositivos é só da própria conta
  const lb = await (await fetch(urlPonte + '/api/extensao/dispositivos', { headers: { Cookie: cb } })).json()
  assert.equal(lb.lista.length, 0)
  const la = await (await fetch(urlPonte + '/api/extensao/dispositivos', { headers: { Cookie: ca } })).json()
  assert.ok(la.lista.some((d) => d.conectado))
  // a Bia não revoga dispositivo da Ana
  const id = la.lista[0].id
  assert.equal((await fetch(urlPonte + '/api/extensao/dispositivos/' + id, { method: 'DELETE', headers: { Cookie: cb } })).status, 404)
  appBia.close(); extAna.close()
})

test('revogar derruba na hora, falha o comando pendente e o token não volta', async () => {
  const cookie = await entrar('ana@x.com')
  const { token, id } = await parearPorCookie(cookie, 'Para revogar')
  const app = await conectarApp(CHAVE_ANA, 'pc-ana-2')
  const ext = await conectarExt(token)
  await proxima(app, (m) => m.t === 'ext-estado' && m.conectado)
  app.send(JSON.stringify({ t: 'ext-cmd', rid: 'p1', acao: 'ler', args: {} }))
  await proxima(ext, (m) => m.t === 'cmd')
  const fecha = fechou(ext)
  assert.equal((await fetch(urlPonte + '/api/extensao/dispositivos/' + id, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200)
  assert.equal(await fecha, 4005)
  const r = await proxima(app, (m) => m.t === 'ext-r' && m.rid === 'p1')
  assert.equal(r.codigo, 'revogada')
  const de_novo = await abrir('/ws/extensao', { headers: { Origin: EXT } })
  de_novo.send(JSON.stringify({ t: 'ola', token }))
  assert.equal(await fechou(de_novo), 4001)
  app.close()
})

test('extensão pausada devolve "pausado" e cair devolve "desconectada" aos pendentes', async () => {
  const cookie = await entrar('ana@x.com')
  const { token } = await parearPorCookie(cookie)
  const app = await conectarApp(CHAVE_ANA, 'pc-ana-3')
  const ext = await conectarExt(token)
  await proxima(app, (m) => m.t === 'ext-estado' && m.conectado)
  ext.send(JSON.stringify({ t: 'estado', pausada: true }))
  const est = await proxima(app, (m) => m.t === 'ext-estado' && m.pausada)
  assert.equal(est.pausada, true)
  app.send(JSON.stringify({ t: 'ext-cmd', rid: 'q1', acao: 'ler', args: {} }))
  assert.equal((await proxima(app, (m) => m.t === 'ext-r')).codigo, 'pausado')
  ext.send(JSON.stringify({ t: 'estado', pausada: false }))
  await proxima(app, (m) => m.t === 'ext-estado' && !m.pausada)
  app.send(JSON.stringify({ t: 'ext-cmd', rid: 'q2', acao: 'ler', args: {} }))
  await proxima(ext, (m) => m.t === 'cmd')
  ext.terminate()
  assert.equal((await proxima(app, (m) => m.t === 'ext-r' && m.rid === 'q2')).codigo, 'desconectada')
  assert.equal((await proxima(app, (m) => m.t === 'ext-estado' && !m.conectado)).conectado, false)
  app.close()
})

test('comando sem resposta vira timeout', async () => {
  const cookie = await entrar('ana@x.com')
  const { token } = await parearPorCookie(cookie)
  const app = await conectarApp(CHAVE_ANA, 'pc-ana-4')
  const ext = await conectarExt(token)
  await proxima(app, (m) => m.t === 'ext-estado' && m.conectado)
  app.send(JSON.stringify({ t: 'ext-cmd', rid: 't1', acao: 'ler', args: {} }))
  const r = await proxima(app, (m) => m.t === 'ext-r', 3000)
  assert.deepEqual([r.rid, r.ok, r.codigo], ['t1', false, 'timeout'])
  app.close(); ext.close()
})

test('uma extensão não responde pedido de outra', async () => {
  const cookie = await entrar('ana@x.com')
  const a = await parearPorCookie(cookie, 'A'), b = await parearPorCookie(cookie, 'B')
  const app = await conectarApp(CHAVE_ANA, 'pc-ana-5')
  const extA = await conectarExt(a.token)
  await proxima(app, (m) => m.t === 'ext-estado' && m.conectado)
  app.send(JSON.stringify({ t: 'ext-cmd', rid: 'z1', acao: 'ler', args: {} }))
  const cmd = await proxima(extA, (m) => m.t === 'cmd')
  const extB = await conectarExt(b.token)
  extB.send(JSON.stringify({ t: 'r', rid: cmd.rid, ok: true, dado: 'intruso' })) // B tenta responder o que foi para A
  extA.send(JSON.stringify({ t: 'r', rid: cmd.rid, ok: true, dado: 'certo' }))
  const r = await proxima(app, (m) => m.t === 'ext-r' && m.rid === 'z1')
  assert.equal(r.dado, 'certo')
  app.close(); extA.close(); extB.close()
})
