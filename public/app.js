// Página do celular: controle remoto do Segundo Cérebro (spec 20).
;(() => {
  const $ = (id) => document.getElementById(id)
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  // chats: lista; aberta: id; cache: id -> { msgs, vivo }, vivo = resposta em curso { texto, ferrs, inicio } (uma por conversa)
  const S = { chats: [], aberta: null, cache: new Map(), pendentes: [], offline: false, semRede: false, ws: null, tentativas: 0, limiteMb: 25, gravador: null }
  const entrada = (id) => {
    if (!S.cache.has(id)) S.cache.set(id, { msgs: [], vivo: null, perms: [] })
    return S.cache.get(id)
  }
  const ocupado = (id) => !!S.cache.get(id)?.vivo || !!S.chats.find((c) => c.id === id)?.ocupado

  // markdown básico, seguro (escapa antes)
  function md(t) {
    const blocos = []
    let s = esc(t).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_m, c) => (blocos.push(c), `\u0000${blocos.length - 1}\u0000`))
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    s = s.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<pre><code>${blocos[+i].replace(/\n$/, '')}</code></pre>`)
  }
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const dur = (ms) => { const t = Math.max(1, Math.round(ms / 1000)); return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s` }
  const mil = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace('.', ',')} mil` : new Intl.NumberFormat('pt-BR').format(Math.round(n)))
  const tamanho = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB')
  const resumo = (m) => {
    if (!m.inicio || !m.fim) return ''
    const u = m.uso || {}
    const tok = u.totalTokens || (u.inputTokens || 0) + (u.outputTokens || 0)
    return [`Trabalhou por ${dur(m.fim - m.inicio)}`, `${hhmm(m.inicio)} às ${hhmm(m.fim)}`, tok ? `${mil(tok)} tokens` : ''].filter(Boolean).join(' · ')
  }

  // ---------- conexão ----------
  function enviarMsg(o) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o))
  }
  function faixa() {
    const f = $('faixa')
    f.hidden = !(S.offline || S.semRede)
    f.textContent = S.semRede ? 'Sem conexão. Reconectando…' : 'O computador está offline. Abra o Segundo Cérebro nele.'
  }
  function conectar() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/celular')
    S.ws = ws
    ws.onopen = () => {
      S.tentativas = 0
      S.semRede = false
      faixa()
      enviarMsg({ t: 'chats' })
      if (S.aberta) enviarMsg({ t: 'abrir', id: S.aberta })
    }
    ws.onmessage = (e) => receber(JSON.parse(e.data))
    ws.onclose = (e) => {
      if (e.code === 4001) return mostrar('vazio') // este celular foi desconectado no computador
      S.semRede = true
      faixa()
      S.tentativas++
      setTimeout(conectar, Math.min(15000, 800 * 2 ** Math.min(S.tentativas, 4)))
    }
  }

  function receber(m) {
    if (m.t === 'estado') {
      S.offline = !m.online
      faixa()
      if (m.online) enviarMsg({ t: 'chats' })
    } else if (m.t === 'chats') {
      S.chats = m.lista
      desenharLista()
    } else if (m.t === 'novo') {
      S.chats = m.lista
      abrirChat(m.id)
    } else if (m.t === 'historico') {
      const e = entrada(m.id)
      e.msgs = m.msgs
      e.vivo = m.ocupado ? { texto: m.parcial || '', ferrs: m.ferramentas || [], inicio: e.vivo?.inicio || Date.now() } : null
      if (m.id === S.aberta) desenharMsgs()
    } else if (m.t === 'comecou') {
      const e = entrada(m.id)
      e.vivo = e.vivo || { texto: '', ferrs: [], inicio: Date.now() }
      marcarOcupado(m.id, true)
      if (m.id === S.aberta) desenharMsgs()
    } else if (m.t === 'delta') {
      const e = entrada(m.id)
      if (!e.vivo) e.vivo = { texto: '', ferrs: [], inicio: Date.now() }
      if (m.texto) e.vivo.texto += m.texto
      if (m.ferramenta) {
        const f = e.vivo.ferrs.find((x) => x.id === m.ferramenta.id)
        f ? Object.assign(f, m.ferramenta) : e.vivo.ferrs.push({ ...m.ferramenta })
      }
      if (!S.chats.find((c) => c.id === m.id)?.ocupado) marcarOcupado(m.id, true)
      if (m.id === S.aberta) desenharMsgs()
    } else if (m.t === 'fim' || m.t === 'erro') {
      const e = entrada(m.id)
      const v = e.vivo
      e.msgs.push({ role: 'assistant', content: m.t === 'erro' ? `⚠ ${m.texto}` : m.texto || v?.texto || (e.parando ? '⚠ Interrompido.' : '(sem resposta)'), inicio: v?.inicio, fim: Date.now(), uso: m.uso })
      e.vivo = null
      e.parando = false
      e.perms = []
      marcarOcupado(m.id, false)
      if (m.id === S.aberta) desenharMsgs()
      enviarMsg({ t: 'chats' })
    } else if (m.t === 'pedir-permissao') {
      entrada(m.id).perms.push({ req: m.req, titulo: m.titulo })
      if (m.id === S.aberta) desenharPerms()
      else notificar(m.id)
    }
  }
  function marcarOcupado(id, sim) {
    const c = S.chats.find((x) => x.id === id)
    if (c) c.ocupado = sim
    desenharLista()
  }
  // aviso discreto quando outra conversa precisa de você (permissão)
  function notificar(id) {
    const c = S.chats.find((x) => x.id === id)
    c && (c.atencao = true)
    desenharLista()
  }

  // ---------- telas ----------
  function mostrar(qual) {
    for (const t of ['lista-tela', 'chat-tela', 'vazio']) $(t).hidden = t !== qual
  }
  function desenharLista() {
    const l = $('lista')
    l.innerHTML = S.chats.length
      ? S.chats.map((c) => `<button class="item ${c.ocupado ? 'ativo' : ''}" data-id="${esc(c.id)}"><b>${c.fixado ? '<span class="pin">★ </span>' : ''}${esc(c.titulo)}</b><small>${c.atencao ? '<span class="atencao">pede permissão</span>' : c.ocupado ? '<span class="vivo"></span>respondendo agora…' : esc(new Date(c.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</small></button>`).join('')
      : '<div class="vazio-lista">Nenhuma conversa ainda.<br>Toque em “Nova” para começar.</div>'
  }
  function abrirChat(id) {
    S.aberta = id
    const c = S.chats.find((x) => x.id === id)
    if (c) c.atencao = false
    $('titulo').textContent = c?.titulo || 'Conversa'
    S.pendentes = []
    desenharPendentes()
    mostrar('chat-tela')
    desenharMsgs()
    desenharPerms()
    enviarMsg({ t: 'abrir', id })
  }
  function desenharMsgs() {
    const el = $('msgs')
    const e = entrada(S.aberta)
    const perto = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    let h = ''
    for (const m of e.msgs) {
      const anexos = (m.anexos || []).map((n) => `<span class="anexo">📎 ${esc(n)}</span>`).join('')
      h += `<div class="m ${m.role === 'user' ? 'user' : 'assistant'}">${m.content ? md(m.content) : ''}${anexos}${m.em ? `<span class="hora">${hhmm(m.em)}</span>` : ''}</div>`
      if (m.role !== 'user' && resumo(m)) h += `<div class="resumo">${esc(resumo(m))}</div>`
    }
    if (e.vivo) {
      for (const f of e.vivo.ferrs) h += `<div class="ferr ${f.status === 'completed' ? 'ok' : ''}"><i></i>${esc(f.titulo || 'Usando ferramenta')}</div>`
      h += e.vivo.texto ? `<div class="m assistant">${md(e.vivo.texto)}</div>` : '<div class="pensando">Pensando…</div>'
    }
    el.innerHTML = h
    if (perto || e.vivo) el.scrollTop = el.scrollHeight
    const b = $('enviar')
    const parar = ocupado(S.aberta)
    b.textContent = parar ? '■' : '↑'
    b.classList.toggle('parar', parar)
    b.setAttribute('aria-label', parar ? 'Parar' : 'Enviar')
  }
  function desenharPerms() {
    const box = $('perms')
    box.innerHTML = ''
    for (const p of entrada(S.aberta).perms) {
      const d = document.createElement('div')
      d.className = 'perm'
      d.innerHTML = `<b>O agente pede permissão</b>${esc(p.titulo)}<div><button class="p" data-d="permitir">Permitir</button><button data-d="negar">Negar</button></div>`
      d.onclick = (ev) => {
        const dec = ev.target.dataset?.d
        if (!dec) return
        enviarMsg({ t: 'permissao', req: p.req, decisao: dec })
        entrada(S.aberta).perms = entrada(S.aberta).perms.filter((x) => x.req !== p.req)
        desenharPerms()
      }
      box.appendChild(d)
    }
  }

  // ---------- anexos e áudio ----------
  function desenharPendentes() {
    const el = $('pendentes')
    el.hidden = !S.pendentes.length
    el.innerHTML = S.pendentes.map((p, i) => `<span class="chip ${p.erro ? 'erro' : ''}">${p.audio ? '🎙' : '📎'} ${esc(p.nome)} <small>${p.erro ? esc(p.erro) : p.id ? tamanho(p.tamanho) : p.pct + '%'}</small><button data-rm="${i}" aria-label="Remover">✕</button></span>`).join('')
  }
  function subir(arquivo, nome, audio) {
    const p = { nome, audio, pct: 0, tamanho: arquivo.size }
    if (arquivo.size > S.limiteMb * 1048576) {
      p.erro = `acima de ${S.limiteMb} MB`
      S.pendentes.push(p)
      return desenharPendentes()
    }
    S.pendentes.push(p)
    desenharPendentes()
    const x = new XMLHttpRequest()
    x.open('POST', '/api/celular/arquivo?nome=' + encodeURIComponent(nome))
    x.setRequestHeader('Content-Type', arquivo.type || 'application/octet-stream')
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        p.pct = Math.round((e.loaded / e.total) * 100)
        desenharPendentes()
      }
    }
    x.onload = () => {
      let r = {}
      try { r = JSON.parse(x.responseText) } catch {}
      if (x.status === 200 && r.id) p.id = r.id
      else p.erro = r.erro || 'falhou'
      desenharPendentes()
    }
    x.onerror = () => { p.erro = 'sem conexão'; desenharPendentes() }
    x.send(arquivo)
  }
  $('anexar').onclick = () => $('arquivo').click()
  $('arquivo').onchange = (e) => {
    for (const f of e.target.files) subir(f, f.name, false)
    e.target.value = ''
  }
  $('pendentes').onclick = (e) => {
    const i = e.target.dataset?.rm
    if (i === undefined) return
    S.pendentes.splice(+i, 1)
    desenharPendentes()
  }

  let relogioGrav = null
  async function alternarGravacao() {
    const b = $('mic')
    if (S.gravador) return S.gravador.stop()
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return alerta('Este navegador não consegue gravar áudio.')
    try {
      const fluxo = await navigator.mediaDevices.getUserMedia({ audio: true })
      const tipo = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || ''
      const rec = new MediaRecorder(fluxo, tipo ? { mimeType: tipo } : undefined)
      const partes = []
      const t0 = Date.now()
      rec.ondataavailable = (e) => e.data.size && partes.push(e.data)
      rec.onstop = () => {
        fluxo.getTracks().forEach((t) => t.stop())
        clearInterval(relogioGrav)
        S.gravador = null
        b.classList.remove('gravando')
        b.textContent = '🎙'
        const mime = rec.mimeType || tipo || 'audio/webm'
        const ext = /mp4/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm'
        const blob = new Blob(partes, { type: mime })
        if (blob.size && Date.now() - t0 > 600) subir(blob, `audio-${hhmm(Date.now()).replace(':', 'h')}.${ext}`, true)
      }
      rec.start()
      S.gravador = rec
      b.classList.add('gravando')
      const tic = () => (b.textContent = '■ ' + dur(Date.now() - t0).replace(' s', 's'))
      tic()
      relogioGrav = setInterval(tic, 500)
    } catch (e) {
      alerta('Não consegui usar o microfone: ' + (e.message || 'permissão negada'))
    }
  }
  $('mic').onclick = alternarGravacao
  function alerta(t) {
    const f = $('toast')
    f.textContent = t
    f.hidden = false
    setTimeout(() => (f.hidden = true), 4500)
  }

  // ---------- ações ----------
  $('lista').onclick = (e) => {
    const b = e.target.closest('[data-id]')
    if (b) abrirChat(b.dataset.id)
  }
  $('novo').onclick = () => enviarMsg({ t: 'novo' })
  $('voltar').onclick = () => {
    S.aberta = null
    mostrar('lista-tela')
    enviarMsg({ t: 'chats' })
  }
  const ta = $('texto')
  ta.oninput = () => {
    ta.style.height = 'auto'
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px'
  }
  $('form').onsubmit = (e) => {
    e.preventDefault()
    if (ocupado(S.aberta)) {
      entrada(S.aberta).parando = true
      return enviarMsg({ t: 'parar', id: S.aberta })
    }
    const t = ta.value.trim()
    if (S.pendentes.some((p) => !p.id && !p.erro)) return alerta('Espere os anexos terminarem de subir.')
    const prontos = S.pendentes.filter((p) => p.id)
    if ((!t && !prontos.length) || !S.aberta) return
    const e1 = entrada(S.aberta)
    e1.msgs.push({ role: 'user', content: t, em: Date.now(), anexos: prontos.map((p) => p.nome) })
    e1.vivo = { texto: '', ferrs: [], inicio: Date.now() }
    marcarOcupado(S.aberta, true)
    enviarMsg({ t: 'enviar', id: S.aberta, texto: t, arquivos: prontos.map((p) => ({ id: p.id })) })
    ta.value = ''
    ta.style.height = 'auto'
    S.pendentes = []
    desenharPendentes()
    desenharMsgs()
  }

  // ---------- vínculo digitando o código do computador ----------
  const placaIn = $('placa')
  placaIn.addEventListener('input', () => {
    const v = placaIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    placaIn.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v
  })
  $('placa-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const erro = $('placa-erro')
    erro.hidden = true
    try {
      const r = await fetch('/api/parear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ placa: placaIn.value }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        erro.textContent = j.erro || 'Não consegui vincular.'
        erro.hidden = false
        return
      }
      location.href = '/app'
    } catch {
      erro.textContent = 'Sem conexão. Tente de novo.'
      erro.hidden = false
    }
  })

  // ---------- início ----------
  fetch('/api/eu', { cache: 'no-store' }).then(async (r) => {
    if (!r.ok) return mostrar('vazio')
    S.limiteMb = (await r.json()).limiteArquivoMb || 25
    mostrar('lista-tela')
    conectar()
  }).catch(() => { mostrar('lista-tela'); S.semRede = true; faixa(); conectar() })
})()
