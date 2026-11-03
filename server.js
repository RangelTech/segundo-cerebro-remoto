// Ponte do controle remoto do Segundo Cérebro (spec 20).
// O computador e o celular abrem WebSocket até aqui; a ponte só repassa mensagens e guarda os vínculos (hashes).
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const PORTA = +process.env.PORT || 8080
const DADOS = process.env.DATA_DIR || path.join(__dirname, 'data')
const PUBLICO = path.join(__dirname, 'public')
const VALIDADE_CODIGO_MS = +process.env.CODIGO_MS || 2 * 60 * 1000
const MAX_MSG = 256 * 1024
const COOKIE = 'sb_cel'
const DEZ_ANOS = 10 * 365 * 24 * 3600

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const aleatorio = (n = 32) => crypto.randomBytes(n).toString('base64url')
const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

// ---------- vínculos (arquivo JSON; poucos registros) ----------
fs.mkdirSync(DADOS, { recursive: true })
const ARQ = path.join(DADOS, 'vinculos.json')
let base = { computadores: {}, celulares: {} }
try {
  base = JSON.parse(fs.readFileSync(ARQ, 'utf8'))
} catch {}
let gravando = null
const salvar = () => {
  clearTimeout(gravando)
  gravando = setTimeout(() => {
    const tmp = ARQ + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(base))
    fs.renameSync(tmp, ARQ)
  }, 150)
}

const codigos = new Map() // codigo -> { computadorId, expira }
const socketsComputador = new Map() // computadorId -> ws
const socketsCelular = new Map() // celularId -> Set<ws>

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
setInterval(() => {
  const agora = Date.now()
  for (const [k, j] of janelas) if (agora > j.ate) janelas.delete(k)
  for (const [c, v] of codigos) if (agora > v.expira) codigos.delete(c)
}, 60000).unref()
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

// ---------- autenticação ----------
function computadorDe(req) {
  const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(req.headers.authorization || '')
  const c = m && base.computadores[m[1]]
  return c && igual(c.hash, hash(m[2])) ? m[1] : null
}
function celularDe(req) {
  const ck = Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).map((p) => p.split('=')).filter((p) => p.length === 2))
  const m = /^([\w-]+)\.([\w-]+)$/.exec(ck[COOKIE] || '')
  const c = m && base.celulares[m[1]]
  return c && igual(c.hash, hash(m[2])) ? { id: m[1], ...c } : null
}

// ---------- HTTP ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
const CABECALHOS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-ancestors 'none'" }

function json(res, status, corpo, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CABECALHOS, ...extra })
  res.end(JSON.stringify(corpo))
}
function lerCorpo(req) {
  return new Promise((resolve) => {
    let t = ''
    req.on('data', (d) => {
      t += d
      if (t.length > 8192) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(t || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}
const nomeDoAparelho = (ua = '') => {
  const so = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Celular'
  const nav = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : ''
  return nav ? `${so} · ${nav}` : so
}
const publicoDe = (id) => Object.entries(base.celulares).filter(([, c]) => c.computadorId === id).map(([cid, c]) => ({ id: cid, nome: c.nome, criado: c.criado, ultimo: c.ultimo || null, online: socketsCelular.has(cid) }))
const avisarComputador = (computadorId) => socketsComputador.get(computadorId)?.send(JSON.stringify({ t: 'celulares', lista: publicoDe(computadorId) }))

function revogar(celularId) {
  delete base.celulares[celularId]
  salvar()
  for (const ws of socketsCelular.get(celularId) || []) ws.close(4001, 'revogado')
  socketsCelular.delete(celularId)
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const ip = ipDe(req)
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true })

    if (req.method === 'POST' && url.pathname === '/api/registrar') {
      if (!limite(ip, 'reg', 10, 3600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
      const id = aleatorio(9)
      const chave = aleatorio(32)
      base.computadores[id] = { hash: hash(chave), criado: Date.now() }
      salvar()
      return json(res, 200, { computadorId: id, chave })
    }

    if (req.method === 'POST' && url.pathname === '/api/vinculo') {
      const id = computadorDe(req)
      if (!id) return json(res, 401, { erro: 'Computador não reconhecido.' })
      if (!limite(ip, 'vin', 30, 600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
      for (const [c, v] of codigos) if (v.computadorId === id) codigos.delete(c) // um código ativo por computador
      const codigo = aleatorio(18)
      codigos.set(codigo, { computadorId: id, expira: Date.now() + VALIDADE_CODIGO_MS })
      return json(res, 200, { codigo, expiraEm: VALIDADE_CODIGO_MS })
    }

    if (req.method === 'GET' && url.pathname === '/api/celulares') {
      const id = computadorDe(req)
      if (!id) return json(res, 401, { erro: 'Computador não reconhecido.' })
      return json(res, 200, { lista: publicoDe(id) })
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/celulares/')) {
      const id = computadorDe(req)
      if (!id) return json(res, 401, { erro: 'Computador não reconhecido.' })
      const cid = url.pathname.split('/').pop()
      if (base.celulares[cid]?.computadorId !== id) return json(res, 404, { erro: 'Celular não encontrado.' })
      revogar(cid)
      avisarComputador(id)
      return json(res, 200, { ok: true })
    }

    // o celular lê o QR: consome o código, ganha o cookie e vai para o app
    if (req.method === 'GET' && url.pathname.startsWith('/v/')) {
      if (!limite(ip, 'v', 30, 600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
      const codigo = url.pathname.slice(3)
      const v = codigos.get(codigo)
      codigos.delete(codigo)
      if (!v || Date.now() > v.expira) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8', ...CABECALHOS })
        return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#16110d;color:#f3ece4;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><h2>Código expirado</h2><p>Volte ao Segundo Cérebro no computador e gere um novo QR code.</p></div>')
      }
      const celularId = aleatorio(9)
      const token = aleatorio(32)
      base.celulares[celularId] = { computadorId: v.computadorId, hash: hash(token), nome: nomeDoAparelho(req.headers['user-agent']), criado: Date.now() }
      salvar()
      avisarComputador(v.computadorId)
      res.writeHead(302, { Location: '/app', 'Set-Cookie': `${COOKIE}=${celularId}.${token}; Path=/; Max-Age=${DEZ_ANOS}; HttpOnly; Secure; SameSite=Strict`, 'Cache-Control': 'no-store', ...CABECALHOS })
      return res.end()
    }

    if (req.method === 'GET' && url.pathname === '/api/eu') {
      const c = celularDe(req)
      return json(res, c ? 200 : 401, c ? { ok: true, nome: c.nome, computadorOnline: socketsComputador.has(c.computadorId) } : { erro: 'Não vinculado.' })
    }

    // arquivos estáticos
    if (req.method === 'GET') {
      let rel = url.pathname === '/' || url.pathname === '/app' ? '/app.html' : url.pathname
      const arq = path.join(PUBLICO, path.normalize(rel))
      if (arq.startsWith(PUBLICO + path.sep) && fs.existsSync(arq) && fs.statSync(arq).isFile()) {
        res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...CABECALHOS })
        return fs.createReadStream(arq).pipe(res)
      }
    }
    json(res, 404, { erro: 'Não encontrado.' })
  } catch (e) {
    json(res, 500, { erro: 'Erro interno.' })
  }
})

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG })

servidor.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  const ip = ipDe(req)
  if (!limite(ip, 'ws', 120, 600000)) return socket.destroy()
  if (url.pathname === '/ws/computador') {
    const id = computadorDe(req) || (url.searchParams.get('id') && base.computadores[url.searchParams.get('id')] && igual(base.computadores[url.searchParams.get('id')].hash, hash(url.searchParams.get('chave') || '')) ? url.searchParams.get('id') : null)
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

function ligarComputador(ws, id) {
  batida(ws)
  socketsComputador.get(id)?.close(4002, 'outra conexão')
  socketsComputador.set(id, ws)
  ws.send(JSON.stringify({ t: 'celulares', lista: publicoDe(id) }))
  for (const [cid, c] of Object.entries(base.celulares)) if (c.computadorId === id) for (const s of socketsCelular.get(cid) || []) s.send(JSON.stringify({ t: 'estado', online: true }))
  ws.on('message', (dado) => {
    let m
    try {
      m = JSON.parse(String(dado))
    } catch {
      return
    }
    const { para, ...resto } = m
    const alvo = para ? [para] : Object.entries(base.celulares).filter(([, c]) => c.computadorId === id).map(([cid]) => cid)
    for (const cid of alvo) if (base.celulares[cid]?.computadorId === id) for (const s of socketsCelular.get(cid) || []) s.send(JSON.stringify(resto))
  })
  ws.on('close', () => {
    if (socketsComputador.get(id) !== ws) return
    socketsComputador.delete(id)
    for (const [cid, c] of Object.entries(base.celulares)) if (c.computadorId === id) for (const s of socketsCelular.get(cid) || []) s.send(JSON.stringify({ t: 'estado', online: false }))
  })
}

function ligarCelular(ws, c) {
  batida(ws)
  if (!socketsCelular.has(c.id)) socketsCelular.set(c.id, new Set())
  socketsCelular.get(c.id).add(ws)
  base.celulares[c.id].ultimo = Date.now()
  salvar()
  ws.send(JSON.stringify({ t: 'estado', online: socketsComputador.has(c.computadorId) }))
  avisarComputador(c.computadorId)
  ws.on('message', (dado) => {
    let m
    try {
      m = JSON.parse(String(dado))
    } catch {
      return
    }
    if (!base.celulares[c.id]) return
    const pc = socketsComputador.get(c.computadorId)
    if (pc) pc.send(JSON.stringify({ ...m, de: c.id }))
    else ws.send(JSON.stringify({ t: 'estado', online: false }))
  })
  ws.on('close', () => {
    socketsCelular.get(c.id)?.delete(ws)
    if (!socketsCelular.get(c.id)?.size) socketsCelular.delete(c.id)
    avisarComputador(c.computadorId)
  })
}

if (require.main === module) servidor.listen(PORTA, () => console.log('ponte remota na porta', PORTA))
module.exports = { servidor }
