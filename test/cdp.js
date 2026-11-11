// Ajudante mínimo de CDP: abre o Chrome for Testing, conecta e avalia JS nas páginas. Sem dependências além do ws do app.
const { spawn } = require('child_process')
const http = require('http')
const WebSocket = require('ws')
const CHROME = process.env.CHROME || 'C:/Users/lucas.rangel/.cache/puppeteer/chrome/win64-156.0.8078.47/chrome-win64/chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej))

async function lancar({ porta = 9333, args = [], perfil } = {}) {
  const dir = perfil || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cdp-'))
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${porta}`, `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,1000', ...args, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) { try { await getJson(`http://127.0.0.1:${porta}/json/version`); break } catch { await sleep(250) } }
  return { proc, porta, dir, fechar: () => { try { proc.kill() } catch {} } }
}

async function aba(porta, url) {
  const lista = await getJson(`http://127.0.0.1:${porta}/json/list`)
  const t = lista.find((x) => x.type === 'page' && x.url === 'about:blank') || lista.find((x) => x.type === 'page')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0; const pend = new Map(); const eventos = []
  ws.on('message', (m) => { const j = JSON.parse(m); if (j.id && pend.has(j.id)) { const { res, rej } = pend.get(j.id); pend.delete(j.id); j.error ? rej(new Error(j.error.message)) : res(j.result) } else if (j.method) eventos.push(j) })
  const cmd = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await cmd('Page.enable'); await cmd('Runtime.enable')
  const api = {
    cmd, eventos, id: t.id,
    ir: async (u) => { await cmd('Page.navigate', { url: u }); await sleep(600); await api.espera(() => 'document.readyState === "complete"', 15000) },
    js: async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails)); return r.result.value },
    espera: async (condFn, ms = 8000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { try { v = await api.js(condFn()) } catch {} if (v) return v; await sleep(200) } throw new Error('tempo esgotado esperando: ' + condFn()) },
    print: async () => (await cmd('Page.captureScreenshot', { format: 'png' })).data,
    fechar: () => { try { ws.close() } catch {} },
  }
  return api
}

module.exports = { lancar, aba, sleep, getJson }
