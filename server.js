// Ponte do controle remoto do Segundo Cérebro (spec 20).
// O computador e o celular abrem WebSocket até aqui; a ponte repassa mensagens, guarda os vínculos (hashes) em SQLite
// e carrega arquivos do celular até o computador (guardados só em trânsito e apagados depois).
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const banco = require('./db')

const PORTA = +process.env.PORT || 8080
const DADOS = process.env.DATA_DIR || path.join(__dirname, 'data')
const PUBLICO = path.join(__dirname, 'public')
const VALIDADE_CODIGO_MS = +process.env.CODIGO_MS || 2 * 60 * 1000
const MAX_ARQUIVO = (+process.env.MAX_ARQUIVO_MB || 25) * 1024 * 1024
const MAX_PENDENTES = +process.env.MAX_PENDENTES || 30
const MAX_BYTES_PENDENTES = (+process.env.MAX_PENDENTES_MB || 300) * 1024 * 1024
const ARQUIVO_TTL_MS = +process.env.ARQUIVO_TTL_MS || 24 * 3600 * 1000
const EVENTO_TTL_MS = 90 * 24 * 3600 * 1000
const MAX_MSG = 256 * 1024
const LIM = +process.env.LIMITE_MULT || 1 // multiplicador dos limites por IP (testes usam valores altos)
const COOKIE = 'sb_cel'
const DEZ_ANOS = 10 * 365 * 24 * 3600
const COMANDOS_CELULAR = new Set(['chats', 'abrir', 'novo', 'enviar', 'parar', 'permissao'])

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const aleatorio = (n = 32) => crypto.randomBytes(n).toString('base64url')
const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

fs.mkdirSync(path.join(DADOS, 'arquivos'), { recursive: true })
const db = banco.abrir(DADOS)
const migrados = db.migrarJson(path.join(DADOS, 'vinculos.json'))
if (migrados) console.log(`vínculos importados do formato antigo: ${migrados} computador(es)`)
const arqPath = (id) => path.join(DADOS, 'arquivos', id)
const apagarArquivo = (id) => fs.rm(arqPath(id), { force: true }, () => {})

const socketsComputador = new Map() // computadorId -> ws
const socketsCelular = new Map() // celularId -> Set<ws>

// ---------- limpeza periódica ----------
function limpar() {
  for (const id of db.limpar({ arquivoMs: ARQUIVO_TTL_MS, eventoMs: EVENTO_TTL_MS })) apagarArquivo(id)
  const agora = Date.now()
  for (const [k, j] of janelas) if (agora > j.ate) janelas.delete(k)
}
setInterval(limpar, 10 * 60 * 1000).unref()

// ---------- limite por IP ----------
const janelas = new Map()
function limite(ip, chave, max, ms) {
  const k = chave + '|' + ip
  const agora = Date.now()
  const j = janelas.get(k) || { n: 0, ate: agora + ms }
  if (agora > j.ate) {
    j.n = 0
    j.ate = agora + ms
  }
  j.n++
  janelas.set(k, j)
  return j.n <= max
}
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

// ---------- autenticação ----------
function computadorDe(req) {
  const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(req.headers.authorization || '')
  const c = m && db.computador(m[1])
  return c && igual(c.hash, hash(m[2])) ? m[1] : null
}
function celularDe(req) {
  const ck = Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).map((p) => p.split('=')).filter((p) => p.length === 2))
  const m = /^([\w-]+)\.([\w-]+)$/.exec(ck[COOKIE] || '')
  const c = m && db.celular(m[1])
  return c && igual(c.hash, hash(m[2])) ? c : null
}

// ---------- HTTP ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
const CABECALHOS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss: ws:; frame-ancestors 'none'" }

function json(res, status, corpo, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CABECALHOS, ...extra })
  res.end(JSON.stringify(corpo))
}
const nomeDoAparelho = (ua = '') => {
  const so = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Celular'
  const nav = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : ''
  return nav ? `${so} · ${nav}` : so
}
const limparNome = (n) => String(n || 'arquivo').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'arquivo'
const publicoDe = (id) => db.celularesDe(id).map((c) => ({ ...c, online: socketsCelular.has(c.id) }))
const avisarComputador = (id) => socketsComputador.get(id)?.send(JSON.stringify({ t: 'celulares', lista: publicoDe(id) }))

function revogar(celularId) {
  db.celularApagar(celularId)
  for (const ws of socketsCelular.get(celularId) || []) ws.close(4001, 'revogado')
  socketsCelular.delete(celularId)
}

// recebe o corpo para um arquivo em disco, com teto de tamanho
function receberArquivo(req, res, destino, aoTerminar) {
  const tam = +req.headers['content-length']
  if (!tam || tam > MAX_ARQUIVO) {
    req.resume()
    return json(res, tam ? 413 : 411, { erro: tam ? `Arquivo grande demais (máximo ${MAX_ARQUIVO / 1024 / 1024} MB).` : 'Tamanho do arquivo não informado.' })
  }
  const saida = fs.createWriteStream(destino)
  let recebido = 0
  let estourou = false
  req.on('data', (d) => {
    recebido += d.length
    if (recebido > MAX_ARQUIVO && !estourou) {
      estourou = true
      req.unpipe(saida)
      saida.destroy()
      fs.rm(destino, { force: true }, () => {})
      json(res, 413, { erro: 'Arquivo grande demais.' })
    }
  })
  req.pipe(saida)
  saida.on('finish', () => !estourou && aoTerminar(recebido))
  saida.on('error', () => !res.headersSent && json(res, 500, { erro: 'Não consegui gravar o arquivo.' }))
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const ip = ipDe(req)
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true })

    if (req.method === 'POST' && url.pathname === '/api/registrar') {
      if (!limite(ip, 'reg', 10 * LIM, 3600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
      const id = aleatorio(9)
      const chave = aleatorio(32)
      db.computadorNovo(id, hash(chave))
      db.evento(id, null, 'computador-registrado', ip)
      return json(res, 200, { computadorId: id, chave })
    }

    if (req.method === 'POST' && url.pathname === '/api/vinculo') {
      const id = computadorDe(req)
      if (!id) return json(res, 401, { erro: 'Computador não reconhecido.' })
      if (!limite(ip, 'vin', 30 * LIM, 600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
      const codigo = aleatorio(18)
      db.codigoNovo(codigo, id, Date.now() + VALIDADE_CODIGO_MS)
      return json(res, 200, { codigo, expiraEm: VALIDADE_CODIGO_MS })
    }

    if (req.method === 'GET' && url.pathname === '/api/celulares') {
      const id = computadorDe(req)
      if (!id) return json(res, 401, { erro: 'Computador não reconhecido.' })
      return json(res, 200, { lista: publicoDe(id) })
    }

    if (req.method === 'GET' && url.pathname === '/api/eventos') {
      const id = computadorDe(req)
      if (!id) return json(res, 401, { erro: 'Computador não reconhecido.' })
      return json(res, 200, { lista: db.eventosDe(id, 50) })
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/celulares/')) {
      const id = computadorDe(req)
      if (!id) return json(res, 401, { erro: 'Computador não reconhecido.' })
      const cid = url.pathname.split('/').pop()
      const c = db.celular(cid)
      if (!c || c.computador_id !== id) return json(res, 404, { erro: 'Celular não encontrado.' })
      revogar(cid)
      db.evento(id, cid, 'celular-revogado', c.nome)
      avisarComputador(id)
      return json(res, 200, { ok: true })
    }

    // o celular lê o QR: consome o código, ganha o cookie e vai para o app
    if (req.method === 'GET' && url.pathname.startsWith('/v/')) {
      if (!limite(ip, 'v', 30 * LIM, 600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
      const v = db.codigoConsumir(url.pathname.slice(3))
      if (!v) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8', ...CABECALHOS })
        return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#16110d;color:#f3ece4;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><h2>Código expirado</h2><p>Volte ao Segundo Cérebro no computador e gere um novo QR code.</p></div>')
      }
      const celularId = aleatorio(9)
      const token = aleatorio(32)
      const nome = nomeDoAparelho(req.headers['user-agent'])
      db.celularNovo(celularId, v.computador_id, hash(token), nome)
      db.evento(v.computador_id, celularId, 'celular-vinculado', nome)
      avisarComputador(v.computador_id)
      res.writeHead(302, { Location: '/app', 'Set-Cookie': `${COOKIE}=${celularId}.${token}; Path=/; Max-Age=${DEZ_ANOS}; HttpOnly; Secure; SameSite=Strict`, 'Cache-Control': 'no-store', ...CABECALHOS })
      return res.end()
    }

    if (req.method === 'GET' && url.pathname === '/api/eu') {
      const c = celularDe(req)
      return json(res, c ? 200 : 401, c ? { ok: true, nome: c.nome, computadorOnline: socketsComputador.has(c.computador_id), limiteArquivoMb: MAX_ARQUIVO / 1024 / 1024 } : { erro: 'Não vinculado.' })
    }

    // celular envia um arquivo (anexo ou áudio) que o computador vai buscar
    if (req.method === 'POST' && url.pathname === '/api/celular/arquivo') {
      const c = celularDe(req)
      if (!c) {
        req.resume()
        return json(res, 401, { erro: 'Não vinculado.' })
      }
      if (!limite(ip, 'up', 60 * LIM, 600000)) {
        req.resume()
        return json(res, 429, { erro: 'Muitos envios. Espere um pouco.' })
      }
      const pend = db.arquivosDe(c.computador_id)
      if (pend.n >= MAX_PENDENTES || pend.bytes >= MAX_BYTES_PENDENTES) {
        req.resume()
        return json(res, 429, { erro: 'O computador ainda não buscou os arquivos anteriores.' })
      }
      const id = aleatorio(15)
      const nome = limparNome(url.searchParams.get('nome'))
      const tipo = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 80)
      return receberArquivo(req, res, arqPath(id), (tamanho) => {
        db.arquivoNovo({ id, computadorId: c.computador_id, celularId: c.id, nome, tipo, tamanho })
        db.evento(c.computador_id, c.id, 'arquivo-enviado', `${nome} (${tamanho} bytes)`)
        json(res, 200, { id, nome, tipo, tamanho })
      })
    }

    // o computador busca o arquivo; depois de baixar, a ponte apaga
    if (req.method === 'GET' && url.pathname.startsWith('/api/arquivos/')) {
      const pc = computadorDe(req)
      if (!pc) return json(res, 401, { erro: 'Computador não reconhecido.' })
      const a = db.arquivo(url.pathname.split('/').pop())
      if (!a || a.computador_id !== pc || !fs.existsSync(arqPath(a.id))) return json(res, 404, { erro: 'Arquivo não encontrado.' })
      res.writeHead(200, { 'Content-Type': a.tipo, 'Content-Length': a.tamanho, 'Cache-Control': 'no-store', 'X-Nome': encodeURIComponent(a.nome) })
      const s = fs.createReadStream(arqPath(a.id))
      s.pipe(res)
      res.on('finish', () => {
        db.arquivoApagar(a.id)
        apagarArquivo(a.id)
        db.evento(pc, a.celular_id, 'arquivo-entregue', a.nome)
      })
      return
    }

    // arquivos estáticos
    if (req.method === 'GET') {
      const rel = url.pathname === '/' || url.pathname === '/app' ? '/app.html' : url.pathname
      const arq = path.join(PUBLICO, path.normalize(rel))
      if (arq.startsWith(PUBLICO + path.sep) && fs.existsSync(arq) && fs.statSync(arq).isFile()) {
        res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...CABECALHOS })
        return fs.createReadStream(arq).pipe(res)
      }
    }
    json(res, 404, { erro: 'Não encontrado.' })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { erro: 'Erro interno.' })
  }
})

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG })

servidor.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (!limite(ipDe(req), 'ws', 120 * LIM, 600000)) return socket.destroy()
  if (url.pathname === '/ws/computador') {
    const id = computadorDe(req)
    if (!id) return socket.destroy()
    return wss.handleUpgrade(req, socket, head, (ws) => ligarComputador(ws, id))
  }
  if (url.pathname === '/ws/celular') {
    const c = celularDe(req)
    if (!c) return socket.destroy()
    return wss.handleUpgrade(req, socket, head, (ws) => ligarCelular(ws, c))
  }
  socket.destroy()
})

const batida = (ws) => {
  ws.vivo = true
  ws.on('pong', () => (ws.vivo = true))
}
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.vivo) {
      ws.terminate()
      continue
    }
    ws.vivo = false
    ws.ping()
  }
}, 30000).unref()

const paraCelulares = (computadorId, so, fn) => {
  for (const c of db.celularesDe(computadorId)) if (!so || so === c.id) for (const s of socketsCelular.get(c.id) || []) fn(s)
}

function ligarComputador(ws, id) {
  batida(ws)
  socketsComputador.get(id)?.close(4002, 'outra conexão')
  socketsComputador.set(id, ws)
  db.computadorVisto(id)
  ws.send(JSON.stringify({ t: 'celulares', lista: publicoDe(id) }))
  paraCelulares(id, null, (s) => s.send(JSON.stringify({ t: 'estado', online: true })))
  ws.on('message', (dado) => {
    let m
    try {
      m = JSON.parse(String(dado))
    } catch {
      return
    }
    const { para, ...resto } = m
    paraCelulares(id, para, (s) => s.send(JSON.stringify(resto)))
  })
  ws.on('close', () => {
    if (socketsComputador.get(id) !== ws) return
    socketsComputador.delete(id)
    paraCelulares(id, null, (s) => s.send(JSON.stringify({ t: 'estado', online: false })))
  })
}

function ligarCelular(ws, c) {
  batida(ws)
  if (!socketsCelular.has(c.id)) socketsCelular.set(c.id, new Set())
  socketsCelular.get(c.id).add(ws)
  db.celularVisto(c.id)
  ws.send(JSON.stringify({ t: 'estado', online: socketsComputador.has(c.computador_id) }))
  avisarComputador(c.computador_id)
  ws.on('message', (dado) => {
    let m
    try {
      m = JSON.parse(String(dado))
    } catch {
      return
    }
    if (!COMANDOS_CELULAR.has(m.t) || !db.celular(c.id)) return
    // anexos: só vale o que este celular realmente enviou (nome e tipo vêm do registro, não do cliente)
    if (m.t === 'enviar') {
      const anexos = []
      for (const a of Array.isArray(m.arquivos) ? m.arquivos.slice(0, 10) : []) {
        const reg = db.arquivo(String(a?.id))
        if (reg && reg.celular_id === c.id) anexos.push({ id: reg.id, nome: reg.nome, tipo: reg.tipo, tamanho: reg.tamanho })
      }
      m = { t: 'enviar', id: m.id, texto: String(m.texto || '').slice(0, 8000), arquivos: anexos }
    }
    const pc = socketsComputador.get(c.computador_id)
    if (pc) pc.send(JSON.stringify({ ...m, de: c.id }))
    else ws.send(JSON.stringify({ t: 'estado', online: false }))
  })
  ws.on('close', () => {
    socketsCelular.get(c.id)?.delete(ws)
    if (!socketsCelular.get(c.id)?.size) socketsCelular.delete(c.id)
    avisarComputador(c.computador_id)
  })
}

if (require.main === module) servidor.listen(PORTA, () => console.log('ponte remota na porta', PORTA))
module.exports = { servidor, db, limpar }
