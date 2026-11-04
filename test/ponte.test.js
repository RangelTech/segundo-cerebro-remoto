process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ponte-'))
process.env.CODIGO_MS = '1500'
process.env.LIMITE_MULT = '1000'
process.env.MAX_ARQUIVO_MB = '1'
process.env.MAX_PENDENTES = '3'
const test = require('node:test')
const assert = require('node:assert')
const WebSocket = require('ws')
const { servidor, db, limpar } = require('../server')
const fs = require('fs')
const path = require('path')

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

// ---------- arquivos, auditoria e banco ----------
const enviarArquivo = (cookie, nome, corpo, tipo = 'text/plain') => fetch(`${base}/api/celular/arquivo?nome=${encodeURIComponent(nome)}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': tipo }, body: corpo })

test('arquivo do celular: sobe, o computador baixa uma vez e a ponte apaga', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  const r = await enviarArquivo(v.cookie, '../../etc/passwd', 'conteudo do anexo')
  assert.equal(r.status, 200)
  const a = await r.json()
  assert.ok(!a.nome.includes('/') && !a.nome.startsWith('.'), 'nome saneado: ' + a.nome)
  const dl = await fetch(`${base}/api/arquivos/${a.id}`, { headers: { Authorization: 'Bearer ' + pc.auth } })
  assert.equal(dl.status, 200)
  assert.equal(await dl.text(), 'conteudo do anexo')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal((await fetch(`${base}/api/arquivos/${a.id}`, { headers: { Authorization: 'Bearer ' + pc.auth } })).status, 404)
  assert.equal(db.arquivo(a.id), undefined)
})

test('arquivo: outro computador não baixa, sem cookie não envia, acima do limite é recusado', async () => {
  const a = await registrar()
  const b = await registrar()
  const va = await vincular(a)
  assert.equal((await enviarArquivo('', 'x.txt', 'oi')).status, 401)
  const ok = await (await enviarArquivo(va.cookie, 'x.txt', 'oi')).json()
  assert.equal((await fetch(`${base}/api/arquivos/${ok.id}`, { headers: { Authorization: 'Bearer ' + b.auth } })).status, 404)
  const grande = await enviarArquivo(va.cookie, 'grande.bin', Buffer.alloc(1024 * 1024 + 10), 'application/octet-stream')
  assert.equal(grande.status, 413)
})

test('limite de arquivos pendentes por computador', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  for (let i = 0; i < 3; i++) assert.equal((await enviarArquivo(v.cookie, `a${i}.txt`, 'x')).status, 200)
  assert.equal((await enviarArquivo(v.cookie, 'a4.txt', 'x')).status, 429)
})

test('enviar com arquivos: a ponte só repassa o que o celular realmente enviou, com nome do registro', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  const outro = await vincular(pc)
  const meu = await (await enviarArquivo(v.cookie, 'meu.txt', 'a')).json()
  const alheio = await (await enviarArquivo(outro.cookie, 'alheio.txt', 'b')).json()
  const wpc = await abrir(base.replace('http', 'ws') + '/ws/computador', { Authorization: 'Bearer ' + pc.auth })
  const wcel = await abrir(base.replace('http', 'ws') + '/ws/celular', { Cookie: v.cookie })
  const chegou = proxima(wpc, (m) => m.t === 'enviar')
  wcel.send(JSON.stringify({ t: 'enviar', id: 'c1', texto: 'veja', arquivos: [{ id: meu.id, nome: 'FORJADO.exe' }, { id: alheio.id }, { id: 'inexistente' }] }))
  const m = await chegou
  assert.equal(m.arquivos.length, 1)
  assert.equal(m.arquivos[0].id, meu.id)
  assert.equal(m.arquivos[0].nome, 'meu.txt')
  wpc.close()
  wcel.close()
})

test('comando desconhecido do celular não é repassado', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  const wpc = await abrir(base.replace('http', 'ws') + '/ws/computador', { Authorization: 'Bearer ' + pc.auth })
  const wcel = await abrir(base.replace('http', 'ws') + '/ws/celular', { Cookie: v.cookie })
  const recebidos = []
  wpc.on('message', (d) => recebidos.push(JSON.parse(String(d))))
  wcel.send(JSON.stringify({ t: 'rm-rf' }))
  wcel.send(JSON.stringify({ t: 'chats' }))
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(recebidos.some((m) => m.t === 'chats'))
  assert.ok(!recebidos.some((m) => m.t === 'rm-rf'))
  wpc.close()
  wcel.close()
})

test('auditoria registra vínculo, envio e revogação', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  await enviarArquivo(v.cookie, 'audit.txt', 'x')
  const lista = (await (await fetch(`${base}/api/celulares`, { headers: { Authorization: 'Bearer ' + pc.auth } })).json()).lista
  await post('/api/celulares/' + lista[0].id, pc.auth, 'DELETE')
  const ev = (await (await fetch(`${base}/api/eventos`, { headers: { Authorization: 'Bearer ' + pc.auth } })).json()).lista.map((e) => e.tipo)
  for (const t of ['celular-vinculado', 'arquivo-enviado', 'celular-revogado']) assert.ok(ev.includes(t), t)
})

test('limpeza apaga arquivos vencidos do disco e do banco', async () => {
  const pc = await registrar()
  const v = await vincular(pc)
  const a = await (await enviarArquivo(v.cookie, 'velho.txt', 'x')).json()
  db.raw.prepare('UPDATE arquivos SET criado = ? WHERE id = ?').run(Date.now() - 48 * 3600 * 1000, a.id)
  limpar()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(db.arquivo(a.id), undefined)
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'arquivos', a.id)), false)
})

test('código de vínculo sobrevive a reinício (fica no banco)', async () => {
  const pc = await registrar()
  const v = await (await post('/api/vinculo', pc.auth)).json()
  assert.ok(db.raw.prepare('SELECT 1 AS x FROM codigos WHERE codigo = ?').get(v.codigo))
})

test('placa: computador recebe código curto e o celular vincula digitando (cookie de 10 anos)', async () => {
  const r = await (await post('/api/registrar')).json()
  assert.match(r.placa, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  const auth = `${r.computadorId}.${r.chave}`
  assert.strictEqual((await (await post('/api/placa', auth, 'GET')).json()).placa, r.placa)
  const pr = await fetch(base + '/api/parear', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Android) Chrome/120' }, body: JSON.stringify({ placa: r.placa.toLowerCase().replace('-', ' ') }) })
  assert.strictEqual(pr.status, 200)
  const ck = pr.headers.get('set-cookie')
  assert.match(ck, /Max-Age=315360000/)
  assert.match(ck, /HttpOnly/)
  const eu = await fetch(base + '/api/eu', { headers: { cookie: ck.split(';')[0] } })
  assert.strictEqual(eu.status, 200)
})

test('placa: código errado é recusado e trocar a placa invalida a antiga', async () => {
  const r = await (await post('/api/registrar')).json()
  const auth = `${r.computadorId}.${r.chave}`
  const tenta = (placa) => fetch(base + '/api/parear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ placa }) })
  assert.strictEqual((await tenta('AAAA-AAAA')).status, 404)
  assert.strictEqual((await tenta('')).status, 404)
  const nova = (await (await post('/api/placa/nova', auth)).json()).placa
  assert.notStrictEqual(nova, r.placa)
  assert.strictEqual((await tenta(r.placa)).status, 404)
  assert.strictEqual((await tenta(nova)).status, 200)
})
