// E2E da extensão do Chrome num Chrome real (Chrome for Testing 156 com --load-extension), contra a ponte local e um "app" simulado.
// Rodar: node test/e2e-extensao.js   (monta antes o dist-teste do repositório segundo-cerebro-extensao). Nada de produção.
process.env.LIMITE_MULT = '1000'
process.env.SESSION_SECRET = 'segredo-de-teste'
const http = require('http'), path = require('path'), fs = require('fs'), os = require('os')
const { execFileSync } = require('child_process')
const WebSocket = require('ws')
const { lancar, aba, sleep, getJson } = require('./cdp.js')

const EXT_REPO = path.join(__dirname, '..', '..', 'segundo-cerebro-extensao')
const falhas = []
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALHA ') + m); if (!c) falhas.push(m) }
const CHAVE = 'sk-chave-da-maquina-0001'

;(async () => {
  execFileSync('node', [path.join(EXT_REPO, 'scripts', 'montar.js'), '--teste'], { stdio: 'ignore' })
  const dist = path.join(EXT_REPO, 'dist-teste')
  // llm-access de mentira (login e conta)
  const acesso = http.createServer((req, res) => {
    let t = ''
    req.on('data', (d) => (t += d))
    req.on('end', () => {
      const out = (st, o) => (res.writeHead(st, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)))
      if (req.url === '/v1/auth/verify') { const b = JSON.parse(t || '{}'); return b.email === 'ana@x.com' && b.password === 'senha-forte-123' ? out(200, { account_id: 7, email: 'ana@x.com', name: 'Ana' }) : out(401, { error: { message: 'x' } }) }
      if (req.url === '/v1/auth/whoami') return req.headers.authorization === 'Bearer ' + CHAVE ? out(200, { account_id: 7 }) : out(401, {})
      out(404, {})
    })
  })
  await new Promise((r) => acesso.listen(0, '127.0.0.1', r))
  process.env.ACCESS_URL = 'http://127.0.0.1:' + acesso.address().port
  const ponte = require('../server').servidor
  await new Promise((r) => ponte.listen(0, '127.0.0.1', r))
  const PORTA = ponte.address().port
  // página de teste (formulário, botão, rolagem, redirecionamento de login)
  let capturado = null
  const pagina = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/login') { res.writeHead(302, { Location: 'http://localhost:8080/callback?code=CODIGO123&state=' + (u.searchParams.get('state') || '') }); return res.end() }
    if (u.pathname === '/dois.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<title>Dois</title><h1>Segunda página</h1>') }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<title>Página de teste</title><h1>Página de teste</h1>
<input id="nome" placeholder="Seu nome" onkeydown="if(event.key==='Enter'){window.enter=event.isTrusted}">
<button id="b" onclick="window.cliques=(window.cliques||0)+1;window.confiavel=event.isTrusted;document.getElementById('r').textContent='clicou '+window.cliques">Enviar</button>
<div id="r"></div><a href="/dois.html">ir para dois</a><div style="height:3000px">espaço</div><button id="fim">Fim da página</button>`)
  })
  await new Promise((r) => pagina.listen(0, '127.0.0.1', r))
  const PP = pagina.address().port
  const PAG = `http://127.0.0.1:${PP}/`

  // app simulado
  let app, rid = 0
  const pend = new Map()
  const estados = []
  const conectarApp = async () => {
    app = new WebSocket(`ws://127.0.0.1:${PORTA}/ws/maquina`, { headers: { Authorization: 'Bearer ' + CHAVE } })
    await new Promise((r) => app.once('open', r))
    app.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'ext-r' && pend.has(m.rid)) { pend.get(m.rid)(m); pend.delete(m.rid) } if (m.t === 'ext-estado') estados.push(m) })
    app.send(JSON.stringify({ t: 'hello', maquinaId: 'pc-teste', nome: 'PC teste', tipo: 'desktop', versao: '0.6.57' }))
  }
  const cmd = (acao, args = {}, ms = 25000) => new Promise((res, rej) => { const id = 'c' + ++rid; const t = setTimeout(() => rej(new Error('sem resposta: ' + acao)), ms); pend.set(id, (m) => (clearTimeout(t), res(m))); app.send(JSON.stringify({ t: 'ext-cmd', rid: id, acao, args })) })

  let chrome
  try {
    chrome = await lancar({ porta: 9351, args: [`--load-extension=${dist}`, `--disable-extensions-except=${dist}`, '--allow-insecure-localhost'] })
    await sleep(1500)
    const alvos = await getJson(`http://127.0.0.1:9351/json/list`)
    const sw = alvos.find((x) => x.type === 'service_worker' && x.url.includes('cdhhngjakiihefobehjmpdhlpedlkanp'))
    ok(!!sw, 'extensão carregada (service worker ativo)')
    if (!sw) throw new Error('sem service worker: ' + JSON.stringify(alvos.map((a) => a.type + ' ' + a.url)))
    const extId = new URL(sw.url).host
    ok(extId === 'cdhhngjakiihefobehjmpdhlpedlkanp', 'ID fixo da extensão: ' + extId)
    // conecta ao service worker por CDP e aponta a base para a ponte local
    const swWs = new WebSocket(sw.webSocketDebuggerUrl)
    await new Promise((r) => swWs.once('open', r))
    let sid = 0; const sp = new Map()
    swWs.on('message', (m) => { const j = JSON.parse(String(m)); if (j.id && sp.has(j.id)) { sp.get(j.id)(j.result || j.error); sp.delete(j.id) } })
    const swJs = (expr) => new Promise((res) => { const i = ++sid; sp.set(i, res); swWs.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })) }).then((r) => r.result && r.result.value)
    let bs = null
    for (let i = 0; i < 12 && !(bs && bs.base && bs.base.includes(String(PORTA))); i++) {
      await swJs(`chrome.storage.local.set({ base: 'http://127.0.0.1:${PORTA}' })`)
      bs = await swJs('chrome.storage.local.get("base")')
      if (!(bs && bs.base && bs.base.includes(String(PORTA)))) await sleep(500)
    }
    ok(!!(bs && bs.base && bs.base.includes(String(PORTA))), 'base da ponte apontada para o teste')

    const p = await aba(9351)
    // 1. entrar no site do remoto => a extensão pareia sozinha (sem login na extensão)
    await p.ir(`http://127.0.0.1:${PORTA}/`)
    const login = await p.js(`fetch('/api/entrar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'ana@x.com',senha:'senha-forte-123'})}).then(r=>r.status)`)
    ok(login === 200, 'login na página do remoto')
    await p.ir(`http://127.0.0.1:${PORTA}/`)
    await p.espera(() => 'document.documentElement.getAttribute("data-sb-extensao")==="conectada"', 20000)
    ok(true, 'a página do remoto mostra a extensão como conectada (pareou pelo login da web)')
    await conectarApp()
    await sleep(800)
    ok(estados.some((e) => e.conectado), 'o app recebe o estado: Chrome conectado')

    // 2. ferramentas
    const r1 = await cmd('abrir', { url: PAG })
    ok(r1.ok && /Página de teste/.test(r1.dado.texto), 'abrir: ' + (r1.dado && r1.dado.texto || r1.erro))
    const r2 = await cmd('ler')
    ok(r2.ok && /Página de teste/.test(r2.dado.texto) && /\[1\] input/.test(r2.dado.texto) && /\[2\] button:submit "Enviar"/.test(r2.dado.texto) && /ir para dois/.test(r2.dado.texto), 'ler: texto e elementos numerados no formato do app')
    const pagCDP = async () => { const l = await getJson('http://127.0.0.1:9351/json/list'); const t = l.find((x) => x.type === 'page' && x.url.startsWith(PAG)); const q = await aba2(t); return q }
    const aba2 = async (t) => { const w = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => w.once('open', r)); let i = 0; const m = new Map(); w.on('message', (d) => { const j = JSON.parse(String(d)); if (j.id && m.has(j.id)) { m.get(j.id)(j.result); m.delete(j.id) } }); return { js: (e) => new Promise((res) => { const k = ++i; m.set(k, res); w.send(JSON.stringify({ id: k, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } })) }).then((r) => r.result && r.result.value), fechar: () => w.close() } }
    const r3 = await cmd('clicar', { id: 2 })
    const pg = await pagCDP()
    ok(r3.ok && (await pg.js('window.cliques')) === 1, 'clicar: o botão recebeu 1 clique')
    ok((await pg.js('window.confiavel')) === true, 'clicar: evento confiável (isTrusted=true), como um clique de verdade')
    const r4 = await cmd('digitar', { id: 1, texto: 'Maria Silva', enter: true })
    ok(r4.ok && (await pg.js('document.getElementById("nome").value')) === 'Maria Silva', 'digitar: texto escrito no campo')
    ok((await pg.js('window.enter')) === true, 'digitar: Enter confiável')
    const r5 = await cmd('rolar', { direcao: 'fim' })
    ok(r5.ok && /Rolagem em \d{3,}/.test(r5.dado.texto), 'rolar: ' + (r5.dado && r5.dado.texto))
    const r6 = await cmd('js', { codigo: 'return document.title + " / " + document.getElementById("r").textContent' })
    ok(r6.ok && /Página de teste \/ clicou 1/.test(r6.dado.texto), 'js: ' + (r6.dado && r6.dado.texto))
    const r7 = await cmd('print')
    ok(r7.ok && r7.dado.imagem && Buffer.from(r7.dado.imagem, 'base64').slice(1, 4).toString() === 'PNG', 'print: PNG válido (' + (r7.dado && r7.dado.largura) + 'x' + (r7.dado && r7.dado.altura) + ')')
    const r8 = await cmd('abrir', { url: `http://127.0.0.1:${PP}/dois.html` })
    ok(r8.ok && /Dois/.test(r8.dado.texto), 'abrir (2ª página na mesma aba)')
    const r9 = await cmd('voltar')
    ok(r9.ok && r9.dado.texto.includes(`:${PP}/`), 'voltar: ' + (r9.dado && r9.dado.texto))
    const rr = await cmd('abrir', { url: 'javascript:alert(1)' })
    ok(!rr.ok && /http/.test(rr.erro), 'abrir recusa javascript:')
    const rd = await cmd('acao_que_nao_existe')
    ok(!rd.ok && rd.codigo === 'desconhecida', 'ação desconhecida recusada')
    pg.fechar()
    // abas: tudo no grupo "Segundo Cérebro"
    const grupos = await swJs('chrome.tabGroups.query({}).then(g=>g.map(x=>x.title))')
    ok(grupos.includes('Segundo Cérebro'), 'abas do agente ficam no grupo "Segundo Cérebro"')

    // 3. login de provedor capturado pela extensão (retorno em localhost:8080 que nem existe)
    const o1 = await cmd('oauth_capturar', { authUrl: `http://127.0.0.1:${PP}/login?state=EST1`, retorno: 'http://localhost:8080/callback', state: 'EST1' }, 30000)
    ok(o1.ok && o1.dado.code === 'CODIGO123' && o1.dado.state === 'EST1', 'oauth_capturar: código pego do retorno em localhost:8080: ' + JSON.stringify(o1.dado || o1.erro))
    const o2 = await cmd('oauth_capturar', { authUrl: `http://127.0.0.1:${PP}/login?state=OUTRO`, retorno: 'http://localhost:8080/callback', state: 'EST2' }, 5000).catch((e) => ({ ok: false, erro: e.message }))
    ok(!o2.ok, 'oauth_capturar ignora retorno com state de outro pedido (não devolve código)')
    const abas = await getJson('http://127.0.0.1:9351/json/list')
    ok(!abas.some((a) => /\/login/.test(a.url)), 'aba do login foi fechada')

    // 4. pausa
    // pausa pelo popup de verdade (o botão "Pausar")
    await p.ir(`chrome-extension://${extId}/popup.html`)
    await p.espera(() => '!document.getElementById("pausar").hidden', 8000)
    await p.js('document.getElementById("pausar").click()')
    await sleep(700)
    ok(/Pausada/.test(await p.js('document.getElementById("titulo").textContent')), 'popup mostra "Pausada"')
    await p.ir(`http://127.0.0.1:${PORTA}/`)
    const pa = await cmd('ler')
    ok(!pa.ok && pa.codigo === 'pausado', 'pausada: o comando é recusado (' + (pa.codigo || pa.erro) + ')')
    await p.ir(`chrome-extension://${extId}/popup.html`)
    await p.espera(() => '!document.getElementById("pausar").hidden', 8000)
    await p.js('document.getElementById("pausar").click()')
    await sleep(700)
    const volta = await cmd('ler')
    ok(volta.ok, 'continuar: volta a atender')
    await p.ir(`http://127.0.0.1:${PORTA}/`)
    // 5. revogar pelo site derruba
    const lista = await p.js(`fetch('/api/extensao/dispositivos').then(r=>r.json())`)
    ok(lista.lista.length >= 1 && lista.conectado, 'o site lista o Chrome conectado')
    await p.js(`fetch('/api/extensao/dispositivos/${lista.lista[0].id}',{method:'DELETE'}).then(r=>r.status)`)
    await sleep(1500)
    const st = await swJs('chrome.storage.local.get("token")')
    ok(!st.token, 'revogar pelo site: a extensão perde o token e volta a "não conectada"')
    const semExt = await cmd('ler')
    ok(!semExt.ok && semExt.codigo === 'sem_extensao', 'sem extensão conectada o app recebe "sem_extensao" (e cai no navegador integrado)')
    // 6. pareamento pelo app (#sbp=token no endereço), SEM cookie nem login: é o que o botão "Conectar o Chrome" do app faz
    await p.cmd('Network.enable')
    await p.cmd('Network.clearBrowserCookies')
    const pApp = await (await fetch(`http://127.0.0.1:${PORTA}/api/extensao/parear-app`, { method: 'POST', headers: { Authorization: 'Bearer ' + CHAVE } })).json()
    await p.ir(`http://127.0.0.1:${PORTA}/#sbp=${encodeURIComponent(pApp.token)}`)
    await p.espera(() => 'document.documentElement.getAttribute("data-sb-extensao")==="conectada"', 20000)
    ok(true, 'pareou pelo token do app (#sbp), sem login na página')
    ok(!(await p.js('location.hash')), 'o token sai do endereço da página depois de usado')
    await sleep(1000)
    const volta2 = await cmd('abrir', { url: PAG })
    ok(volta2.ok, 'depois de parear pelo app o Chrome já obedece ao app')
  } catch (e) {
    console.log('ERRO', e.message); falhas.push(e.message)
  } finally {
    try { app && app.close() } catch {}
    try { chrome && chrome.fechar() } catch {}
    acesso.close(); pagina.close(); ponte.close(); ponte.closeAllConnections?.()
  }
  console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO CERTO')
  setImmediate(() => process.exit(falhas.length ? 1 : 0))
})()
