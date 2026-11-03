// Página do celular: controle remoto do Segundo Cérebro (spec 20).
;(() => {
  const $ = (id) => document.getElementById(id)
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const S = { chats: [], aberta: null, msgs: [], vivo: null, ocupado: false, offline: false, ws: null, tentativas: 0 }

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
    } else if (m.t === 'historico' && m.id === S.aberta) {
      S.msgs = m.msgs
      S.ocupado = !!m.ocupado
      S.vivo = m.ocupado ? { texto: '', ferrs: [], inicio: Date.now() } : null
      desenharMsgs()
    } else if (m.t === 'comecou' && m.id === S.aberta) {
      S.ocupado = true
      S.vivo = { texto: '', ferrs: [], inicio: Date.now() }
      desenharMsgs()
    } else if (m.t === 'delta' && m.id === S.aberta) {
      if (!S.vivo) S.vivo = { texto: '', ferrs: [], inicio: Date.now() }
      S.ocupado = true
      if (m.texto) S.vivo.texto += m.texto
      if (m.ferramenta) {
        const f = S.vivo.ferrs.find((x) => x.id === m.ferramenta.id)
        f ? Object.assign(f, m.ferramenta) : S.vivo.ferrs.push({ ...m.ferramenta })
      }
      desenharMsgs()
    } else if (m.t === 'fim' || m.t === 'erro') {
      if (m.id === S.aberta) {
        const v = S.vivo
        S.msgs.push({ role: 'assistant', content: m.t === 'erro' ? `⚠ ${m.texto}` : m.texto || v?.texto || '(sem resposta)', inicio: v?.inicio, fim: Date.now(), uso: m.uso })
        S.vivo = null
        S.ocupado = false
        desenharMsgs()
      }
      enviarMsg({ t: 'chats' })
    } else if (m.t === 'pedir-permissao' && m.id === S.aberta) {
      const d = document.createElement('div')
      d.className = 'perm'
      d.innerHTML = `<b>O agente pede permissão</b>${esc(m.titulo)}<div><button class="p" data-d="permitir">Permitir</button><button data-d="negar">Negar</button></div>`
      d.onclick = (e) => {
        const dec = e.target.dataset?.d
        if (!dec) return
        enviarMsg({ t: 'permissao', req: m.req, decisao: dec })
        d.remove()
      }
      $('perms').appendChild(d)
    }
  }

  // ---------- telas ----------
  function mostrar(qual) {
    for (const t of ['lista-tela', 'chat-tela', 'vazio']) $(t).hidden = t !== qual
  }
  function desenharLista() {
    const l = $('lista')
    l.innerHTML = S.chats.length
      ? S.chats.map((c) => `<button class="item" data-id="${esc(c.id)}"><b>${c.fixado ? '<span class="pin">★ </span>' : ''}${esc(c.titulo)}</b><small>${c.ocupado ? 'respondendo agora…' : esc(new Date(c.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</small></button>`).join('')
      : '<div class="vazio-lista">Nenhuma conversa ainda.<br>Toque em “Nova” para começar.</div>'
  }
  function abrirChat(id) {
    S.aberta = id
    S.msgs = []
    S.vivo = null
    S.ocupado = false
    $('titulo').textContent = (S.chats.find((c) => c.id === id) || {}).titulo || 'Conversa'
    mostrar('chat-tela')
    desenharMsgs()
    enviarMsg({ t: 'abrir', id })
  }
  function desenharMsgs() {
    const el = $('msgs')
    const perto = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    let h = ''
    for (const m of S.msgs) {
      h += `<div class="m ${m.role === 'user' ? 'user' : 'assistant'}">${md(m.content)}${m.em ? `<span class="hora">${hhmm(m.em)}</span>` : ''}</div>`
      if (m.role !== 'user' && resumo(m)) h += `<div class="resumo">${esc(resumo(m))}</div>`
    }
    if (S.vivo) {
      for (const f of S.vivo.ferrs) h += `<div class="ferr ${f.status === 'completed' ? 'ok' : ''}"><i></i>${esc(f.titulo || 'Usando ferramenta')}</div>`
      h += S.vivo.texto ? `<div class="m assistant">${md(S.vivo.texto)}</div>` : '<div class="pensando">Pensando…</div>'
    }
    el.innerHTML = h
    if (perto || S.vivo) el.scrollTop = el.scrollHeight
    const b = $('enviar')
    b.textContent = S.ocupado ? '■' : '↑'
    b.classList.toggle('parar', S.ocupado)
    b.setAttribute('aria-label', S.ocupado ? 'Parar' : 'Enviar')
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
    if (S.ocupado) return enviarMsg({ t: 'parar', id: S.aberta })
    const t = ta.value.trim()
    if (!t || !S.aberta) return
    S.msgs.push({ role: 'user', content: t, em: Date.now() })
    ta.value = ''
    ta.style.height = 'auto'
    S.vivo = { texto: '', ferrs: [], inicio: Date.now() }
    S.ocupado = true
    desenharMsgs()
    enviarMsg({ t: 'enviar', id: S.aberta, texto: t })
  }

  // ---------- início ----------
  fetch('/api/eu', { cache: 'no-store' }).then((r) => {
    if (!r.ok) return mostrar('vazio')
    mostrar('lista-tela')
    conectar()
  }).catch(() => { mostrar('lista-tela'); S.semRede = true; faixa(); conectar() })
})()
