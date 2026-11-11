(function () {
  var $ = function (id) { return document.getElementById(id) }
  var tela = function (qual) { $('login').hidden = qual !== 'login'; $('escolha').hidden = qual !== 'escolha' }
  var erro = function (t) { $('erro').textContent = t || ''; $('erro').hidden = !t }

  function api(metodo, rota, corpo) {
    return fetch(rota, { method: metodo, headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { status: r.status, json: j } }) })
  }

  function mostrarMaquinas(auto) {
    return api('GET', '/api/maquinas').then(function (r) {
      if (r.status === 401) return tela('login')
      var lista = r.json.lista || []
      // uma máquina só (caso da VM dedicada): entra direto
      if (auto && lista.length === 1) { location.replace('/m/' + encodeURIComponent(lista[0].id) + '/'); return }
      var grupos = $('grupos'); grupos.textContent = ''
      var secoes = [['desktop', 'Meus computadores'], ['vm', 'Minha máquina virtual']]
      secoes.forEach(function (s) {
        var itens = lista.filter(function (m) { return m.tipo === s[0] })
        if (!itens.length) return
        var tit = document.createElement('h2'); tit.textContent = s[1]; grupos.appendChild(tit)
        var ul = document.createElement('ul')
        itens.forEach(function (m) {
          var li = document.createElement('li'), a = document.createElement('a')
          a.href = '/m/' + encodeURIComponent(m.id) + '/'
          var ponto = document.createElement('span'); ponto.className = 'ponto'
          var box = document.createElement('span')
          var nome = document.createElement('span'); nome.className = 'nome'; nome.textContent = m.nome
          var det = document.createElement('span'); det.className = 'det'; det.textContent = (m.versao ? 'Versão ' + m.versao + ' · ' : '') + 'conectado'
          box.appendChild(nome); box.appendChild(det); a.appendChild(ponto); a.appendChild(box); li.appendChild(a); ul.appendChild(li)
        })
        grupos.appendChild(ul)
      })
      // quem já tem uma máquina virtual não precisa do convite
      $('contratar').hidden = lista.some(function (m) { return m.tipo === 'vm' })
      $('vazio').hidden = lista.length > 0
      tela('escolha')
      mostrarExtensao()
    })
  }

  // extensão do Chrome: estado e desconectar (o pareamento é feito sozinho pelo content script da extensão quando a pessoa está logada aqui)
  function mostrarExtensao() {
    api('GET', '/api/extensao/dispositivos').then(function (r) {
      if (r.status !== 200) return
      var lista = r.json.lista || []
      var ul = $('ext-lista'); ul.textContent = ''
      $('ext').hidden = false
      $('ext-txt').textContent = lista.length ? 'O Segundo Cérebro pode abrir e usar o Chrome abaixo, com as suas contas já abertas.' : 'Instale a extensão uma vez e o Segundo Cérebro passa a usar o seu Chrome, com as suas contas (WhatsApp, Instagram e outras) já abertas. Depois de instalar, volte aqui: ela se conecta sozinha.'
      $('ext-baixar').hidden = lista.length > 0
      lista.forEach(function (d) {
        var li = document.createElement('li'); li.style.cssText = 'display:flex;justify-content:space-between;gap:8px;align-items:center;margin:6px 0'
        var t = document.createElement('span'); t.textContent = d.nome + ' · ' + (d.pausada ? 'pausado' : d.conectado ? 'conectado' : 'desconectado')
        var b = document.createElement('button'); b.className = 'sec'; b.type = 'button'; b.textContent = 'Desconectar'
        b.addEventListener('click', function () { b.disabled = true; api('DELETE', '/api/extensao/dispositivos/' + encodeURIComponent(d.id)).then(mostrarExtensao) })
        li.appendChild(t); li.appendChild(b); ul.appendChild(li)
      })
    })
  }

  function iniciar() {
    if (/[?&]extensao=1/.test(location.search)) $('aviso-ext').hidden = false
    api('GET', '/api/eu').then(function (r) {
      if (r.status !== 200) return tela('login')
      $('quem').textContent = r.json.nome || r.json.email
      mostrarMaquinas(!/[?&]lista=1/.test(location.search))
    })
  }

  // Esqueci a senha: pede o link ao servidor (que manda por e-mail e responde igual exista ou não a conta)
  $('esqueci').addEventListener('click', function () {
    var msg = $('esqueci-msg'); msg.hidden = true; erro('')
    var email = $('email').value.trim()
    if (!email) return erro('Digite o seu e-mail acima e toque de novo em "Esqueci a senha".')
    var b = $('esqueci'); b.disabled = true
    api('POST', '/api/esqueci', { email: email }).then(function (r) {
      b.disabled = false
      if (r.status !== 200) return erro(r.json.erro || 'Não foi possível enviar agora.')
      msg.textContent = 'Se existir uma conta com esse e-mail, enviamos o link para criar uma nova senha. Olhe também a caixa de spam.'; msg.hidden = false
    }).catch(function () { b.disabled = false; erro('Sem conexão. Tente de novo.') })
  })

  $('form').addEventListener('submit', function (e) {
    e.preventDefault()
    erro('')
    var b = $('entrar'); b.disabled = true; b.textContent = 'Entrando…'
    api('POST', '/api/entrar', { email: $('email').value.trim(), senha: $('senha').value }).then(function (r) {
      b.disabled = false; b.textContent = 'Entrar'
      if (r.status !== 200) return erro(r.json.erro || 'Não foi possível entrar.')
      $('senha').value = ''
      $('quem').textContent = r.json.nome || r.json.email
      mostrarMaquinas(true)
    }).catch(function () { b.disabled = false; b.textContent = 'Entrar'; erro('Sem conexão. Tente de novo.') })
  })
  $('atualizar').addEventListener('click', function () { mostrarMaquinas(false) })
  $('sair').addEventListener('click', function () { api('POST', '/api/sair').then(function () { tela('login') }) })
  iniciar()
})()
