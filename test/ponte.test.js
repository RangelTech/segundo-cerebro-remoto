process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ponte-'))
process.env.CODIGO_MS = '1500'
const test = require('node:test')
const assert = require('node:assert')
const WebSocket = require('ws')
const { servidor } = require('../server')

let base
test.before(async () => {
  await new Promise((r) => servidor.listen(0, r))
  base = `http://127.0.0.1:${servidor.address().port}`
})
test.after(() => { servidor.closeAllConnections(); servidor.close(); setTimeout(() => process.exit(0), 200).unref() })

const post = (p, auth, metodo = 'POST') => fetch(base + p, { method: metodo, headers: auth ? { Authorization: 'Bearer ' + auth } : {} })
async function registrar() {
  const r = await (await post('/api/registrar')).json()
  return { id: r.computadorId, auth: `${r.computadorId}.${r.chave}`, chave: r.chave }
}
async function vincular(pc) {
  const v = await (await post('/api/vinculo', pc.auth)).json()
  const r = await fetch(`${base}/v/${v.codigo}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604' } })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], setcookie: r.headers.get('set-cookie') || '', codigo: v.codigo }
}
const abrir = (url, headers) => new Promise((res, rej) => { const w = new WebSocket(url, { headers }); w.once('open', () => res(w)); w.once('error', rej); w.once('unexpected-response', () => rej(new Error('recusado'))) })
const proxima = (w, filtro = () => true) => new Promise((res) => { const f = (d) => { const m = JSON.parse(String(d)); if (filtro(m)) { w.off('message', f); res(m) } }; w.on('message', f) })

test('computador sem credencial é recusado', async () => {
  assert.equal((await post('/api/vinculo')).status, 401)
  assert.equal((await post('/api/vinculo', 'x.y')).status, 401)
})

test('vínculo: cookie de 10 anos, HttpOnly, e o código só vale uma vez', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  assert.equal(v.status, 302)
  assert.match(v.setcookie, /HttpOnly/)
  assert.match(v.setcookie, /Secure/)
  assert.match(v.setcookie, /SameSite=Strict/)
  assert.match(v.setcookie, /Max-Age=315360000/)
  const de_novo = await fetch(`${base}/v/${v.codigo}`, { redirect: 'manual' })
  assert.equal(de_novo.status, 410)
})

test('código expira', async () => {
  const pc = await registrar()
  const v = await (await post('/api/vinculo', pc.auth)).json()
  await new Promise((r) => setTimeout(r, 1700))
  assert.equal((await fetch(`${base}/v/${v.codigo}`, { redirect: 'manual' })).status, 410)
})

test('um código ativo por computador: o novo invalida o anterior', async () => {
  const pc = await registrar()
  const a = await (await post('/api/vinculo', pc.auth)).json()
  await (await post('/api/vinculo', pc.auth)).json()
  assert.equal((await fetch(`${base}/v/${a.codigo}`, { redirect: 'manual' })).status, 410)
})

test('repasse nos dois sentidos e identificação do celular', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  const wpc = await abrir(base.replace('http', 'ws') + '/ws/computador', { Authorization: 'Bearer ' + pc.auth })
  const wcel = await abrir(base.replace('http', 'ws') + '/ws/celular', { Cookie: v.cookie })
  const recebidoNoPc = proxima(wpc, (m) => m.t === 'enviar')
  wcel.send(JSON.stringify({ t: 'enviar', id: 'c1', texto: 'oi' }))
  const m = await recebidoNoPc
  assert.equal(m.texto, 'oi')
  assert.ok(m.de)
  const recebidoNoCel = proxima(wcel, (x) => x.t === 'delta')
  wpc.send(JSON.stringify({ para: m.de, t: 'delta', id: 'c1', texto: 'olá' }))
  assert.equal((await recebidoNoCel).texto, 'olá')
  wpc.close()
  wcel.close()
})

test('celular não conecta sem cookie nem com cookie falso', async () => {
  await assert.rejects(abrir(base.replace('http', 'ws') + '/ws/celular', {}))
  await assert.rejects(abrir(base.replace('http', 'ws') + '/ws/celular', { Cookie: 'sb_cel=abc.def' }))
})

test('revogar derruba o celular na hora e o cookie deixa de valer', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  const wcel = await abrir(base.replace('http', 'ws') + '/ws/celular', { Cookie: v.cookie })
  const lista = (await (await post('/api/celulares', pc.auth, 'GET')).json()).lista
  assert.equal(lista.length, 1)
  assert.equal(lista[0].nome, 'iPhone · Safari')
  const fechou = new Promise((r) => wcel.once('close', (c) => r(c)))
  assert.equal((await post('/api/celulares/' + lista[0].id, pc.auth, 'DELETE')).status, 200)
  assert.equal(await fechou, 4001)
  assert.equal((await fetch(base + '/api/eu', { headers: { Cookie: v.cookie } })).status, 401)
  await assert.rejects(abrir(base.replace('http', 'ws') + '/ws/celular', { Cookie: v.cookie }))
})

test('um computador não revoga celular de outro', async () => {
  const a = await registrar()
  const b = await registrar()
  await vincular(a)
  const lista = (await (await post('/api/celulares', a.auth, 'GET')).json()).lista
  assert.equal((await post('/api/celulares/' + lista[0].id, b.auth, 'DELETE')).status, 404)
})

test('computador offline: celular é avisado', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  const wcel = new WebSocket(base.replace('http', 'ws') + '/ws/celular', { headers: { Cookie: v.cookie } })
  const e = await new Promise((res) => wcel.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'estado') res(m) }))
  assert.equal(e.online, false)
  wcel.close()
})
