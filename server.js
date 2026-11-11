// Ponte do acesso web remoto do Segundo Cérebro (spec 21 §12).
// O app (computador ou VM) abre um WebSocket de SAÍDA até aqui, identificado pela chave da conta. O navegador (celular ou
// computador) entra com e-mail e senha da mesma conta, escolhe a máquina e carrega a própria interface do app, que a ponte
// busca no app pelo túnel (assim a tela web é sempre da mesma versão do app instalado). A ponte não guarda nada em disco:
// sessões são cookies assinados e as máquinas conectadas ficam só em memória.
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')

const PORTA = +process.env.PORT || 8080
const ACCESS = (process.env.ACCESS_URL || 'https://qwen.rangeltech.net').replace(/\/+$/, '')
const SEGREDO = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex') // sem a variável, as sessões caem a cada reinício
const SESSAO_MS = (+process.env.SESSAO_DIAS || 7) * 24 * 3600 * 1000
const MAX_MSG = (+process.env.MAX_MSG_MB || 40) * 1024 * 1024
const LIM = +process.env.LIMITE_MULT || 1 // multiplicador dos limites por IP (testes usam valores altos)
const PUBLICO = path.join(__dirname, 'public')
const COOKIE = 'sb_web'
const TEMPO_HTTP_MS = 20000
const RECONFERIR_MS = +process.env.RECONFERIR_MS || 5 * 60 * 1000

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const aleatorio = (n = 12) => crypto.randomBytes(n).toString('base64url')
const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

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
}, 10 * 60 * 1000).unref()

// ---------- sessão (cookie assinado) ----------
const assinar = (p) => crypto.createHmac('sha256', SEGREDO).update(p).digest('base64url')
function criarSessao(conta) {
  const p = Buffer.from(JSON.stringify({ a: conta.account_id, e: conta.email, n: conta.name || '', x: Date.now() + SESSAO_MS })).toString('base64url')
  return p + '.' + assinar(p)
}
function sessaoDe(req) {
  const ck = Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).map((p) => p.split('=')).filter((p) => p.length === 2))
  const [p, s] = String(ck[COOKIE] || '').split('.')
  if (!p || !s || !igual(assinar(p), s)) return null
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString())
    return d.x > Date.now() ? { conta: String(d.a), email: d.e, nome: d.n } : null
  } catch {
    return null
  }
}
const cookieSessao = (valor, maxAge) => `${COOKIE}=${valor}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`

// ---------- conta (llm-access) ----------
async function acessoPost(rota, corpo) {
  const r = await fetch(ACCESS + rota, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000) })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const conferidas = new Map() // sha(chave) -> { conta, ate }
async function contaDaChave(chave) {
  const k = sha(chave)
  const c = conferidas.get(k)
  if (c && c.ate > Date.now()) return c.conta
  const r = await fetch(ACCESS + '/v1/auth/whoami', { headers: { Authorization: 'Bearer ' + chave }, signal: AbortSignal.timeout(15000) }).catch(() => null)
  if (r && r.status === 200) {
    const j = await r.json().catch(() => ({}))
    if (j.account_id != null) {
      conferidas.set(k, { conta: String(j.account_id), ate: Date.now() + RECONFERIR_MS })
      return String(j.account_id)
    }
  }
  conferidas.delete(k)
  return r && (r.status === 401 || r.status === 403) ? null : undefined // undefined = não deu para conferir agora
}

// ---------- máquinas conectadas ----------
const maquinas = new Map() // conta -> Map(maquinaId -> { ws, info, webs: Map(sid -> ws), pend: Map(rid -> fn), chave })
const daConta = (conta) => maquinas.get(conta) || new Map()
const publicas = (conta) => [...daConta(conta).values()].map((m) => m.info)
const enviar = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o))

// ---------- extensão do Chrome (spec 25 §7) ----------
// Pareamento sem login: um token de uso único (10 min) liga o Chrome à conta; ele vira um token de dispositivo (365 dias), assinado com o
// mesmo segredo das sessões, mas com prefixo próprio (nunca vale como cookie). O registro dos dispositivos fica em memória e, se DADOS_DIR
// existir, em arquivo (para a revogação sobreviver ao reinício). A ponte só repassa comandos entre o app e a extensão da MESMA conta e nunca guarda o
// conteúdo das páginas.
const EXT_PAREAR_MS = 10 * 60 * 1000
const EXT_DISP_MS = 365 * 24 * 3600 * 1000
const EXT_TEMPO_MS = +process.env.EXT_TEMPO_MS || 30000
const EXT_TEMPO_LONGO_MS = +process.env.EXT_TEMPO_LONGO_MS || 16 * 60 * 1000 // login de provedor (oauth_capturar): a pessoa leva alguns minutos
const DADOS_DIR = process.env.DADOS_DIR || ''
const origemExtensao = (o) => /^(chrome|moz)-extension:\/\//.test(String(o || ''))
function tokenAssinado(prefixo, obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url')
  return prefixo + '.' + p + '.' + assinar(prefixo + '.' + p)
}
function lerToken(prefixo, tok) {
  const [pre, p, sg] = String(tok || '').split('.')
  if (pre !== prefixo || !p || !sg || !igual(assinar(pre + '.' + p), sg)) return null
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString())
    return d.x > Date.now() ? d : null
  } catch {
    return null
  }
}
const usados = new Map() // nonce do pareamento -> expira
const dispositivos = new Map() // conta -> Map(id -> { id, nome, versao, criado, ultimo })
const revogados = new Set() // ids de dispositivos revogados
const extensoes = new Map() // conta -> Map(id -> { ws, info, pausada })
const extPend = new Map() // rid -> { maquina, ridApp, dev, timer }
const arquivoExt = () => (DADOS_DIR ? path.join(DADOS_DIR, 'extensao.json') : '')
function carregarExt() {
  try {
    const j = JSON.parse(fs.readFileSync(arquivoExt(), 'utf8'))
    for (const id of j.revogados || []) revogados.add(id)
    for (const [conta, lista] of Object.entries(j.dispositivos || {})) dispositivos.set(conta, new Map(lista.map((d) => [d.id, d])))
  } catch {}
}
let salvando = null
function salvarExt() {
  if (!arquivoExt()) return
  clearTimeout(salvando)
  salvando = setTimeout(() => {
    try {
      fs.mkdirSync(DADOS_DIR, { recursive: true })
      fs.writeFileSync(arquivoExt(), JSON.stringify({ revogados: [...revogados], dispositivos: Object.fromEntries([...dispositivos].map(([c, m]) => [c, [...m.values()]])) }))
    } catch {}
  }, 500)
  salvando.unref?.()
}
carregarExt()
setInterval(() => {
  const agora = Date.now()
  for (const [k, x] of usados) if (agora > x) usados.delete(k)
}, 60000).unref()
function extDaConta(conta) {
  const todas = [...(extensoes.get(conta)?.values() || [])]
  return { todas, ativa: todas.find((e) => !e.pausada) || null }
}
function estadoExt(conta) {
  const { todas, ativa } = extDaConta(conta)
  return { t: 'ext-estado', conectado: todas.length > 0, pausada: todas.length > 0 && !ativa, nome: (ativa || todas[0])?.info.nome || '', versao: (ativa || todas[0])?.info.versao || '' }
}
function avisarMaquinas(conta) {
  const e = estadoExt(conta)
  for (const m of daConta(conta).values()) enviar(m.ws, e)
}
function listaDispositivos(conta) {
  const on = extensoes.get(conta) || new Map()
  return [...(dispositivos.get(conta)?.values() || [])].filter((d) => !revogados.has(d.id)).map((d) => ({ id: d.id, nome: d.nome, versao: d.versao, criado: d.criado, ultimo: d.ultimo, conectado: on.has(d.id), pausada: !!on.get(d.id)?.pausada }))
}
function pareamento(conta) {
  const nonce = aleatorio(10)
  return { token: tokenAssinado('sbp', { a: conta, j: nonce, x: Date.now() + EXT_PAREAR_MS }), expira_em: EXT_PAREAR_MS / 1000 }
}
function falharPendentes(dev, codigo) {
  for (const [rid, p] of extPend) {
    if (p.dev !== dev) continue
    clearTimeout(p.timer)
    extPend.delete(rid)
    enviar(p.maquina, { t: 'ext-r', rid: p.ridApp, ok: false, codigo, erro: codigo === 'desconectada' ? 'O Chrome desconectou.' : 'A extensão foi revogada.' })
  }
}
// comando do app para a extensão da mesma conta; a resposta volta como ext-r (ou erro de transporte: sem_extensao, pausado, desconectada, timeout)
function comandoParaExtensao(conta, maquinaWs, msg) {
  const { todas, ativa } = extDaConta(conta)
  const falha = (codigo, erro) => enviar(maquinaWs, { t: 'ext-r', rid: msg.rid, ok: false, codigo, erro })
  if (!todas.length) return falha('sem_extensao', 'Nenhum Chrome conectado.')
  if (!ativa) return falha('pausado', 'A extensão está pausada.')
  const acao = String(msg.acao || '').slice(0, 40)
  const rid = aleatorio(9)
  const ms = acao === 'oauth_capturar' ? EXT_TEMPO_LONGO_MS : EXT_TEMPO_MS
  const timer = setTimeout(() => {
    extPend.delete(rid)
    falha('timeout', 'A extensão não respondeu a tempo.')
  }, ms)
  extPend.set(rid, { maquina: maquinaWs, ridApp: msg.rid, dev: ativa, timer })
  enviar(ativa.ws, { t: 'cmd', rid, acao, args: msg.args && typeof msg.args === 'object' ? msg.args : {} })
}

// ---------- HTTP ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
const CABECALHOS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }
const CSP_APP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval'; worker-src blob: 'self'; connect-src 'self' wss: ws: blob: data:; frame-ancestors 'none'"
const CSP_LOGIN = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"

function json(res, status, corpo, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CABECALHOS, ...extra })
  res.end(JSON.stringify(corpo))
}
function lerJson(req, max = 4096) {
  return new Promise((resolve) => {
    let t = ''
    req.on('data', (d) => {
      t += d
      if (t.length > max) {
        req.destroy()
        resolve(null)
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(t))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}
// cache dos arquivos da interface por versão do app (teto de memória; ao estourar, recomeça)
const estaticos = new Map()
let bytesEstaticos = 0
const TETO_ESTATICOS = (+process.env.CACHE_MB || 64) * 1024 * 1024
function guardarEstatico(chave, r) {
  if (bytesEstaticos + r.corpo.length > TETO_ESTATICOS) {
    estaticos.clear()
    bytesEstaticos = 0
  }
  estaticos.set(chave, r)
  bytesEstaticos += r.corpo.length
}
const pedirAoApp = (m, caminho) =>
  new Promise((resolve) => {
    const rid = aleatorio(8)
    const t = setTimeout(() => (m.pend.delete(rid), resolve(null)), TEMPO_HTTP_MS)
    m.pend.set(rid, (r) => (clearTimeout(t), m.pend.delete(rid), resolve(r)))
    enviar(m.ws, { t: 'http', rid, caminho })
  })

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const ip = ipDe(req)
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, maquinas: [...maquinas.values()].reduce((n, m) => n + m.size, 0) })

    if (req.method === 'POST' && url.pathname === '/api/entrar') {
      if (!limite(ip, 'login', 20 * LIM, 600000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' })
      const b = await lerJson(req)
      if (!b?.email || !b?.senha) return json(res, 400, { erro: 'Informe e-mail e senha.' })
      let r
      try {
        r = await acessoPost('/v1/auth/verify', { email: String(b.email).slice(0, 200), password: String(b.senha).slice(0, 200) })
      } catch {
        return json(res, 503, { erro: 'Não consegui falar com o servidor agora. Tente de novo em instantes.' })
      }
      if (r.status !== 200) return json(res, r.status === 429 ? 429 : r.status >= 500 ? 503 : r.status, { erro: r.json?.error?.message || 'Não foi possível entrar.' })
      return json(res, 200, { ok: true, email: r.json.email, nome: r.json.name }, { 'Set-Cookie': cookieSessao(criarSessao(r.json), SESSAO_MS / 1000) })
    }
    // "Esqueci a senha": o llm-access manda o link por e-mail e sempre responde igual (não revela se o e-mail existe)
    if (req.method === 'POST' && url.pathname === '/api/esqueci') {
      if (!limite(ip, 'esqueci', 5 * LIM, 3600000)) return json(res, 429, { erro: 'Muitas tentativas. Tente de novo mais tarde.' })
      const b = await lerJson(req)
      const email = String(b?.email || '').trim().slice(0, 200)
      if (!email.includes('@')) return json(res, 400, { erro: 'Digite o seu e-mail.' })
      try {
        await acessoPost('/v1/auth/forgot', { email })
      } catch {
        return json(res, 503, { erro: 'Não consegui falar com o servidor agora. Tente de novo em instantes.' })
      }
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/sair') return json(res, 200, { ok: true }, { 'Set-Cookie': cookieSessao('', 0) })

    if (req.method === 'GET' && url.pathname === '/api/eu') {
      const s = sessaoDe(req)
      return s ? json(res, 200, { email: s.email, nome: s.nome }) : json(res, 401, { erro: 'Faça login.' })
    }
    if (req.method === 'GET' && url.pathname === '/api/maquinas') {
      const s = sessaoDe(req)
      return s ? json(res, 200, { lista: publicas(s.conta) }) : json(res, 401, { erro: 'Faça login.' })
    }

    // ---- extensão do Chrome: pareamento, registro e dispositivos
    if (url.pathname.startsWith('/api/extensao/')) {
      const rota = url.pathname.slice('/api/extensao/'.length)
      const origem = req.headers.origin
      if (req.method === 'POST' && rota === 'parear') { // cookie de quem está logado no remoto (o content script roda na página do remoto)
        if (!limite(ip, 'ext-parear', 60 * LIM, 600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
        const s = sessaoDe(req)
        if (!s) return json(res, 401, { erro: 'Faça login.' })
        return json(res, 200, pareamento(s.conta))
      }
      if (req.method === 'POST' && rota === 'parear-app') { // o app já logado (chave da conta) pede o pareamento: sem digitar nada
        if (!limite(ip, 'ext-parear-app', 60 * LIM, 600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
        const chave = /^Bearer (\S{10,200})$/.exec(req.headers.authorization || '')?.[1]
        const conta = chave ? await contaDaChave(chave) : null
        if (!conta) return json(res, conta === undefined ? 503 : 401, { erro: 'Chave inválida.' })
        return json(res, 200, pareamento(conta))
      }
      if (req.method === 'POST' && rota === 'registrar') {
        if (!limite(ip, 'ext-reg', 30 * LIM, 600000)) return json(res, 429, { erro: 'Muitas tentativas.' })
        if (origem && !origemExtensao(origem)) return json(res, 403, { erro: 'Origem não permitida.' })
        const b = await lerJson(req)
        const d = lerToken('sbp', b?.token)
        if (!d || usados.has(d.j)) return json(res, 400, { erro: 'Pareamento inválido ou vencido.' })
        usados.set(d.j, d.x)
        const id = aleatorio(9)
        const info = { id, nome: String(b.nome || 'Chrome').slice(0, 60), versao: String(b.versao || '').slice(0, 20), criado: Date.now(), ultimo: Date.now() }
        if (!dispositivos.has(d.a)) dispositivos.set(d.a, new Map())
        dispositivos.get(d.a).set(id, info)
        salvarExt()
        return json(res, 200, { ok: true, token: tokenAssinado('sbd', { a: d.a, d: id, x: Date.now() + EXT_DISP_MS }), id })
      }
      if (req.method === 'GET' && rota === 'dispositivos') {
        const s = sessaoDe(req)
        return s ? json(res, 200, { lista: listaDispositivos(s.conta), ...estadoExt(s.conta) }) : json(res, 401, { erro: 'Faça login.' })
      }
      if (req.method === 'DELETE' && rota.startsWith('dispositivos/')) {
        const s = sessaoDe(req)
        if (!s) return json(res, 401, { erro: 'Faça login.' })
        const id = rota.slice('dispositivos/'.length)
        if (!dispositivos.get(s.conta)?.has(id)) return json(res, 404, { erro: 'Dispositivo não encontrado.' })
        revogados.add(id)
        dispositivos.get(s.conta).delete(id)
        salvarExt()
        const e = extensoes.get(s.conta)?.get(id)
        if (e) {
          falharPendentes(e, 'revogada')
          try { e.ws.close(4005, 'revogada') } catch {}
        }
        return json(res, 200, { ok: true })
      }
      return json(res, 404, { erro: 'Não encontrado.' })
    }

    // a interface do app, buscada no próprio app pelo túnel
    const mm = req.method === 'GET' && /^\/m\/([\w-]{4,64})(\/.*)?$/.exec(url.pathname)
    if (mm) {
      const s = sessaoDe(req)
      if (!s) {
        res.writeHead(302, { Location: '/', ...CABECALHOS })
        return res.end()
      }
      if (!mm[2]) {
        res.writeHead(302, { Location: `/m/${mm[1]}/`, ...CABECALHOS })
        return res.end()
      }
      const m = daConta(s.conta).get(mm[1])
      if (!m) return json(res, 404, { erro: 'Este computador não está conectado agora.' })
      const caminho = mm[2] === '/' ? 'web.html' : decodeURIComponent(mm[2].slice(1))
      // os arquivos de uma versão do app não mudam: a ponte guarda o que o app já mandou e serve da memória (e o navegador revalida por ETag)
      const chave = m.info.id + '|' + m.info.desde + '|' + caminho
      let r = estaticos.get(chave)
      if (!r) {
        const novo = await pedirAoApp(m, caminho)
        if (!novo) return json(res, 504, { erro: 'O computador não respondeu.' })
        r = { status: novo.status || 200, tipo: novo.tipo || 'application/octet-stream', corpo: Buffer.from(novo.b64 || '', 'base64') }
        r.etag = '"' + crypto.createHash('sha1').update(r.corpo).digest('hex') + '"'
        if (r.status === 200) guardarEstatico(chave, r)
      }
      if (r.status === 200 && req.headers['if-none-match'] === r.etag) {
        res.writeHead(304, { ETag: r.etag, 'Cache-Control': 'no-cache', ...CABECALHOS })
        return res.end()
      }
      res.writeHead(r.status, { 'Content-Type': r.tipo, 'Cache-Control': 'no-cache', ETag: r.etag, 'Content-Security-Policy': CSP_APP, ...CABECALHOS })
      return res.end(r.corpo)
    }

    // página de login e escolha da máquina
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? '/index.html' : url.pathname
      const arq = path.join(PUBLICO, path.normalize(rel))
      if (arq.startsWith(PUBLICO + path.sep) && fs.existsSync(arq) && fs.statSync(arq).isFile()) {
        res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP_LOGIN, ...CABECALHOS })
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

servidor.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (!limite(ipDe(req), 'ws', 240 * LIM, 600000)) return socket.destroy()
  socket.on('error', () => {})
  if (url.pathname === '/ws/maquina') {
    const chave = /^Bearer (\S{10,200})$/.exec(req.headers.authorization || '')?.[1]
    const conta = chave ? await contaDaChave(chave) : null
    if (!conta) return socket.destroy()
    return wss.handleUpgrade(req, socket, head, (ws) => ligarMaquina(ws, conta, chave))
  }
  if (url.pathname === '/ws/web') {
    const s = sessaoDe(req)
    const origem = req.headers.origin
    if (!s || (origem && new URL(origem).host !== req.headers.host)) return socket.destroy()
    const m = daConta(s.conta).get(String(url.searchParams.get('m') || ''))
    return wss.handleUpgrade(req, socket, head, (ws) => ligarWeb(ws, s, String(url.searchParams.get('m') || ''), m))
  }
  if (url.pathname === '/ws/extensao') {
    if (!origemExtensao(req.headers.origin)) return socket.destroy() // só a própria extensão (nem página web nem outro programa de navegador)
    return wss.handleUpgrade(req, socket, head, (ws) => ligarExtensao(ws))
  }
  socket.destroy()
})

function ligarExtensao(ws) {
  batida(ws)
  ws.on('error', () => {})
  let e = null, conta = null
  const aposta = setTimeout(() => !e && ws.close(4000, 'sem identificação'), 10000)
  ws.on('message', (dado) => {
    let msg
    try {
      msg = JSON.parse(String(dado))
    } catch {
      return
    }
    if (!e) {
      const d = msg.t === 'ola' ? lerToken('sbd', msg.token) : null
      if (!d || revogados.has(d.d)) return ws.close(4001, 'token inválido')
      clearTimeout(aposta)
      conta = String(d.a)
      if (!extensoes.has(conta)) extensoes.set(conta, new Map())
      const antiga = extensoes.get(conta).get(d.d)
      if (antiga) { falharPendentes(antiga, 'desconectada'); try { antiga.ws.close(4002, 'outra conexão') } catch {} }
      if (!dispositivos.has(conta)) dispositivos.set(conta, new Map())
      const reg = dispositivos.get(conta).get(d.d) || { id: d.d, criado: Date.now() }
      Object.assign(reg, { nome: String(msg.nome || reg.nome || 'Chrome').slice(0, 60), versao: String(msg.versao || '').slice(0, 20), ultimo: Date.now() })
      dispositivos.get(conta).set(d.d, reg)
      salvarExt()
      e = { ws, info: reg, pausada: !!msg.pausada, id: d.d }
      extensoes.get(conta).set(d.d, e)
      enviar(ws, { t: 'ok' })
      return avisarMaquinas(conta)
    }
    if (msg.t === 'ping') return enviar(ws, { t: 'pong' })
    if (msg.t === 'estado') {
      e.pausada = !!msg.pausada
      return avisarMaquinas(conta)
    }
    if (msg.t === 'r') {
      const p = extPend.get(msg.rid)
      if (!p || p.dev !== e) return
      clearTimeout(p.timer)
      extPend.delete(msg.rid)
      enviar(p.maquina, { t: 'ext-r', rid: p.ridApp, ok: !!msg.ok, dado: msg.dado, erro: msg.erro, codigo: msg.codigo })
    }
  })
  ws.on('close', () => {
    clearTimeout(aposta)
    if (!e) return
    if (extensoes.get(conta)?.get(e.id) === e) extensoes.get(conta).delete(e.id)
    if (!extensoes.get(conta)?.size) extensoes.delete(conta)
    falharPendentes(e, 'desconectada')
    avisarMaquinas(conta)
  })
}

function ligarMaquina(ws, conta, chave) {
  batida(ws)
  // mensagem acima do teto (ex.: anexo enorme) gera 'error' no socket; sem este ouvinte o processo da PONTE caía e derrubava todo mundo
  ws.on('error', () => {})
  let m = null
  const aposta = setTimeout(() => !m && ws.close(4000, 'sem identificação'), 10000)
  const reconferir = setInterval(async () => {
    if ((await contaDaChave(chave)) === null) ws.close(4004, 'assinatura inativa') // sem assinatura, perde o acesso web
  }, RECONFERIR_MS)
  reconferir.unref()
  ws.on('message', (dado) => {
    let msg
    try {
      msg = JSON.parse(String(dado))
    } catch {
      return
    }
    if (!m) {
      if (msg.t !== 'hello' || !/^[\w-]{4,64}$/.test(String(msg.maquinaId))) return ws.close(4000, 'identificação inválida')
      clearTimeout(aposta)
      const id = String(msg.maquinaId)
      if (!maquinas.has(conta)) maquinas.set(conta, new Map())
      maquinas.get(conta).get(id)?.ws.close(4002, 'outra conexão')
      m = { ws, chave, webs: new Map(), pend: new Map(), info: { id, nome: String(msg.nome || 'Computador').slice(0, 60), tipo: msg.tipo === 'vm' ? 'vm' : 'desktop', versao: String(msg.versao || '').slice(0, 20), desde: Date.now() } }
      maquinas.get(conta).set(id, m)
      enviar(ws, { t: 'ok' })
      return enviar(ws, estadoExt(conta))
    }
    if (msg.t === 'http-r') return m.pend.get(msg.rid)?.(msg)
    if (msg.t === 'ext-cmd') return comandoParaExtensao(conta, ws, msg)
    const alvo = msg.para ? [m.webs.get(msg.para)].filter(Boolean) : [...m.webs.values()]
    if (msg.t === 'ret' || msg.t === 'ev') for (const w of alvo) enviar(w, { ...msg, para: undefined })
  })
  ws.on('close', () => {
    clearTimeout(aposta)
    clearInterval(reconferir)
    if (!m) return
    if (maquinas.get(conta)?.get(m.info.id) === m) maquinas.get(conta).delete(m.info.id)
    if (!maquinas.get(conta)?.size) maquinas.delete(conta)
    // avisa e FECHA os sockets dos navegadores: eles estavam presos a esta máquina. Fechados, o navegador reconecta sozinho
    // e, quando a máquina volta, liga na nova conexão (sem isto ficava falando com um socket morto até o usuário recarregar).
    for (const w of m.webs.values()) {
      enviar(w, { t: 'estado', online: false })
      try {
        w.close(4004, 'computador reiniciou')
      } catch {}
    }
    m.webs.clear()
  })
}

function ligarWeb(ws, sessao, maquinaId, m) {
  batida(ws)
  ws.on('error', () => {}) // ver ligarMaquina: o erro fecha só esta conexão
  if (!m) {
    enviar(ws, { t: 'estado', online: false })
    return ws.close(4003, 'computador offline')
  }
  const sid = aleatorio(9)
  m.webs.set(sid, ws)
  enviar(ws, { t: 'estado', online: true, maquina: m.info })
  ws.on('message', (dado) => {
    let msg
    try {
      msg = JSON.parse(String(dado))
    } catch {
      return
    }
    if (msg.t !== 'inv' || typeof msg.canal !== 'string' || msg.canal.length > 80) return
    if (m.ws.readyState !== 1) return enviar(ws, { t: 'estado', online: false })
    enviar(m.ws, { t: 'inv', id: msg.id, canal: msg.canal, args: Array.isArray(msg.args) ? msg.args : [], de: sid })
  })
  ws.on('close', () => m.webs.delete(sid))
}

if (require.main === module) servidor.listen(PORTA, () => console.log('ponte remota (acesso web) na porta', PORTA))
module.exports = { servidor, maquinas, estaticos, extensoes }
