// Ponte v2: login pela conta, sessão, máquinas conectadas, relay web<->app e interface servida pelo app.
process.env.LIMITE_MULT = '1000'
process.env.SESSION_SECRET = 'segredo-de-teste'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const WebSocket = require('ws')

let acesso, ponte, urlPonte, portaPonte
const esqueceu = [] // e-mails que chegaram em /v1/auth/forgot do llm-access de mentira
const SENHA = 'senha-forte-123'
const CHAVE = 'sk-chave-da-maquina-0001'

test.before(async () => {
  // llm-access de mentira
  acesso = http.createServer((req, res) => {
    let t = ''
    req.on('data', (d) => (t += d))
    req.on('end', () => {
      const out = (st, o) => (res.writeHead(st, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)))
      if (req.url === '/v1/auth/verify') {
        const b = JSON.parse(t || '{}')
        if (b.email === 'ana@x.com' && b.password === SENHA) return out(200, { account_id: 7, email: 'ana@x.com', name: 'Ana' })
        if (b.email === 'inativa@x.com') return out(403, { error: { message: 'sua assinatura nao esta ativa' } })
        return out(401, { error: { message: 'e-mail ou senha incorretos' } })
      }
      if (req.url === '/v1/auth/forgot') return (esqueceu.push(JSON.parse(t || '{}').email), out(200, { ok: true }))
      if (req.url === '/v1/auth/whoami') {
        const k = req.headers.authorization
        if (k === 'Bearer ' + CHAVE) return out(200, { account_id: 7, email: 'ana@x.com', name: 'Ana' })
        if (k === 'Bearer sk-chave-de-outra-conta') return out(200, { account_id: 9, email: 'bia@x.com', name: 'Bia' })
        return out(401, { error: { message: 'invalida' } })
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

const post = (rota, corpo, cookie) => fetch(urlPonte + rota, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(corpo) })
const get = (rota, cookie) => fetch(urlPonte + rota, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' })
async function entrar(email = 'ana@x.com', senha = SENHA) {
  const r = await post('/api/entrar', { email, senha })
  const c = (r.headers.get('set-cookie') || '').split(';')[0]
  return { r, cookie: c }
}
// guarda as mensagens desde a abertura (a ponte manda "estado" assim que conecta, antes do teste começar a escutar)
const abrir = (rota, opts) => new Promise((res, rej) => {
  const w = new WebSocket('ws://127.0.0.1:' + portaPonte + rota, opts)
  w.fila = []
  w.on('message', (d) => w.fila.push(JSON.parse(String(d))))
  w.once('open', () => res(w))
  w.once('error', rej)
  w.once('unexpected-response', (_q, p) => rej(new Error('http ' + p.statusCode)))
})
const proxima = (w, filtro = () => true) => new Promise((res) => {
  const achar = () => { const i = w.fila.findIndex(filtro); if (i < 0) return false; res(w.fila.splice(i, 1)[0]); return true }
  if (achar()) return
  const f = () => achar() && w.off('message', f)
  w.on('message', f)
})

// máquina de mentira: responde ao que a ponte pede
async function maquina(chave = CHAVE, id = 'pc-da-ana') {
  const w = await abrir('/ws/maquina', { headers: { Authorization: 'Bearer ' + chave } })
  const ok = proxima(w, (m) => m.t === 'ok')
  w.send(JSON.stringify({ t: 'hello', maquinaId: id, nome: 'PC da Ana', tipo: 'desktop', versao: '0.5.3' }))
  await ok
  w.on('message', (d) => {
    const m = JSON.parse(String(d))
    if (m.t === 'http') w.send(JSON.stringify({ t: 'http-r', rid: m.rid, status: m.caminho === 'web.html' ? 200 : 404, tipo: 'text/html', b64: Buffer.from('<h1>interface ' + m.caminho + '</h1>').toString('base64') }))
    if (m.t === 'inv') {
      w.send(JSON.stringify({ t: 'ret', para: m.de, id: m.id, ok: true, valor: { eco: m.canal, args: m.args } }))
      w.send(JSON.stringify({ t: 'ev', canal: 'chat:delta', dados: { texto: 'oi' }, para: m.de }))
    }
  })
  return w
}

test('login: senha errada, assinatura inativa e sucesso com cookie', async () => {
  assert.equal((await entrar('ana@x.com', 'errada-123')).r.status, 401)
  assert.equal((await entrar('inativa@x.com')).r.status, 403)
  const { r, cookie } = await entrar()
  assert.equal(r.status, 200)
  assert.match(r.headers.get('set-cookie'), /HttpOnly.*Secure.*SameSite=Strict/)
  const eu = await get('/api/eu', cookie)
  assert.equal(eu.status, 200)
  assert.equal((await eu.json()).email, 'ana@x.com')
  assert.equal((await get('/api/eu')).status, 401)
  assert.equal((await get('/api/eu', cookie.slice(0, -3) + 'xxx')).status, 401) // cookie adulterado
})

test('máquina com chave inválida não conecta; a da conta aparece só para a dona', async () => {
  await assert.rejects(() => abrir('/ws/maquina', { headers: { Authorization: 'Bearer chave-errada-1234' } }))
  const m = await maquina()
  const { cookie } = await entrar()
  const lista = (await (await get('/api/maquinas', cookie)).json()).lista
  assert.equal(lista.length, 1)
  assert.deepEqual([lista[0].id, lista[0].nome, lista[0].tipo], ['pc-da-ana', 'PC da Ana', 'desktop'])
  // outra conta não enxerga nem abre
  const outra = await maquina('sk-chave-de-outra-conta', 'pc-da-bia')
  assert.equal((await (await get('/api/maquinas', cookie)).json()).lista.length, 1)
  assert.equal((await get('/m/pc-da-bia/', cookie)).status, 404)
  m.close()
  outra.close()
})

test('a interface vem do app pelo túnel e exige login', async () => {
  const m = await maquina()
  const { cookie } = await entrar()
  assert.equal((await get('/m/pc-da-ana/')).status, 302) // sem login volta para a entrada
  assert.equal((await get('/m/pc-da-ana', cookie)).status, 302)
  const pagina = await get('/m/pc-da-ana/', cookie)
  assert.equal(pagina.status, 200)
  assert.equal(await pagina.text(), '<h1>interface web.html</h1>')
  assert.match(pagina.headers.get('content-security-policy'), /script-src 'self'/)
  assert.equal((await get('/m/pc-da-ana/nao-existe.js', cookie)).status, 404)
  m.close()
})

test('web <-> app: chamada, resposta e evento chegam só para quem pediu', async () => {
  const m = await maquina()
  const { cookie } = await entrar()
  const w1 = await abrir('/ws/web?m=pc-da-ana', { headers: { Cookie: cookie } })
  const w2 = await abrir('/ws/web?m=pc-da-ana', { headers: { Cookie: cookie } })
  await proxima(w1, (x) => x.t === 'estado')
  await proxima(w2, (x) => x.t === 'estado')
  const ret = proxima(w1, (x) => x.t === 'ret')
  const ev = proxima(w1, (x) => x.t === 'ev')
  let w2Recebeu = false
  w2.on('message', (d) => { const x = JSON.parse(String(d)); if (x.t === 'ret' || x.t === 'ev') w2Recebeu = true })
  w1.send(JSON.stringify({ t: 'inv', id: 1, canal: 'chats:get', args: ['a'] }))
  const r = await ret
  assert.deepEqual([r.id, r.ok, r.valor], [1, true, { eco: 'chats:get', args: ['a'] }])
  assert.equal((await ev).dados.texto, 'oi')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(w2Recebeu, false)
  w1.close(); w2.close(); m.close()
})

test('mensagem acima do teto (anexo enorme) fecha só aquela conexão; a ponte continua no ar', async () => {
  const m = await maquina()
  const { cookie } = await entrar()
  const w = await abrir('/ws/web?m=pc-da-ana', { headers: { Cookie: cookie } })
  await proxima(w, (x) => x.t === 'estado')
  const fechou = new Promise((r) => w.on('close', (c) => r(c)))
  w.on('error', () => {})
  w.send(Buffer.alloc(41 * 1024 * 1024, 97)) // 41 MB: acima do MAX_MSG padrão (40 MB)
  assert.equal(await fechou, 1009, 'fechou por tamanho')
  const r = await get('/')
  assert.equal(r.status, 200, 'a ponte segue respondendo')
  const w2 = await abrir('/ws/web?m=pc-da-ana', { headers: { Cookie: cookie } })
  assert.equal((await proxima(w2, (x) => x.t === 'estado')).online, true, 'outra pessoa continua conectando')
  w2.close(); m.close()
})

test('web sem sessão ou para máquina offline é recusado; máquina que cai avisa a web', async () => {
  await assert.rejects(() => abrir('/ws/web?m=pc-da-ana'))
  const { cookie } = await entrar()
  const off = await abrir('/ws/web?m=nao-existe', { headers: { Cookie: cookie } })
  assert.equal((await proxima(off, (x) => x.t === 'estado')).online, false)
  const m = await maquina()
  const w = await abrir('/ws/web?m=pc-da-ana', { headers: { Cookie: cookie } })
  await proxima(w, (x) => x.t === 'estado')
  const caiu = proxima(w, (x) => x.t === 'estado' && x.online === false)
  const fechou = new Promise((ok) => w.once('close', (codigo) => ok(codigo)))
  m.close()
  await caiu
  // o navegador é desconectado junto: assim ele reconecta e liga na máquina nova quando ela volta
  assert.equal(await fechou, 4004)
})

test('a página de entrada é servida', async () => {
  const r = await get('/')
  assert.equal(r.status, 200)
  assert.match(await r.text(), /Segundo Cérebro/)
  assert.equal((await get('/health')).status, 200)
})

test('arquivos da interface vêm do cache da ponte e o navegador revalida por ETag', async () => {
  require('../server').estaticos.clear()
  const m = await maquina()
  let pedidos = 0
  m.on('message', (d) => { if (JSON.parse(String(d)).t === 'http') pedidos++ })
  const { cookie } = await entrar()
  const a = await get('/m/pc-da-ana/app.js', cookie)
  assert.equal(a.status, 404) // 404 não entra no cache
  const p1 = await get('/m/pc-da-ana/', cookie)
  const etag = p1.headers.get('etag')
  assert.ok(etag)
  const p2 = await get('/m/pc-da-ana/', cookie)
  assert.equal(await p2.text(), '<h1>interface web.html</h1>')
  const p3 = await fetch(urlPonte + '/m/pc-da-ana/', { headers: { Cookie: cookie, 'If-None-Match': etag } })
  assert.equal(p3.status, 304)
  assert.equal(pedidos, 2) // 1 do app.js (404) + 1 da página; as outras vieram do cache
  m.close()
})

test('Esqueci a senha: pede o link ao servidor, responde igual e valida o e-mail', async () => {
  const post = (corpo) => fetch(urlPonte + '/api/esqueci', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
  esqueceu.length = 0
  const ok = await post({ email: 'ana@x.com' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true })
  assert.deepEqual(esqueceu, ['ana@x.com'])
  const quemNao = await post({ email: 'ninguem@x.com' })
  assert.equal(quemNao.status, 200) // não revela se a conta existe
  assert.equal((await post({ email: 'sem-arroba' })).status, 400)
  assert.equal((await post({})).status, 400)
  assert.equal(esqueceu.length, 2)
})
