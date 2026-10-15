/* Estante — leitor de livros em domínio público
 * Tudo roda no próprio celular: os livros baixados ficam guardados no
 * navegador (IndexedDB) e abrem sem internet. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const GUTENDEX = 'https://gutendex.com/books/';
const THIS_YEAR = new Date().getFullYear();

/* ---------------- Preferências (localStorage, com tolerância a falhas) ---------------- */
const prefs = {
  _d: { size: 19, theme: 'sepia', font: 'serif', lang: 'pt' },
  get(k) { try { const v = localStorage.getItem('estante.' + k); return v === null ? this._d[k] : JSON.parse(v); } catch { return this._d[k]; } },
  set(k, v) { try { localStorage.setItem('estante.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------------- Banco de dados local (IndexedDB) ---------------- */
// No iPhone o Safari às vezes fecha a conexão com o banco por conta própria
// (app em segundo plano, pouca memória). Por isso a conexão é reaberta sempre
// que cai, e cada operação tenta de novo uma vez antes de desistir.
const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      const r = indexedDB.open('estante', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts', { keyPath: 'id' });
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = () => { if (this._p === p) this._p = null; };
        d.onversionchange = () => { d.close(); if (this._p === p) this._p = null; };
        res(d);
      };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('blocked'));
    });
    const p = this._p;
    p.catch(() => { if (this._p === p) this._p = null; });
    return p;
  },
  async run(stores, mode, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        const d = await this.open();
        return await new Promise((res, rej) => {
          const t = d.transaction(stores, mode);
          const out = fn(t);
          t.oncomplete = () => res(out && typeof out === 'object' && 'result' in out ? out.result : out);
          t.onerror = () => rej(t.error);
          t.onabort = () => rej(t.error || new Error('abort'));
        });
      } catch (err) {
        // conexão fechada/inválida: descarta e tenta de novo com uma conexão nova
        try { (await this._p)?.close(); } catch {}
        this._p = null;
        if (attempt >= 1) throw friendlyDbError(err);
        await new Promise(r => setTimeout(r, 150));
      }
    }
  },
  allBooks() { return this.run('books', 'readonly', t => t.objectStore('books').getAll()); },
  getBook(id) { return this.run('books', 'readonly', t => t.objectStore('books').get(id)); },
  putBook(b) { return this.run('books', 'readwrite', t => t.objectStore('books').put(b)); },
  getText(id) { return this.run('texts', 'readonly', t => t.objectStore('texts').get(id)); },
  save(book, text) {
    return this.run(['books', 'texts'], 'readwrite', t => {
      t.objectStore('books').put(book);
      t.objectStore('texts').put({ id: book.id, text });
    });
  },
  remove(id) {
    return this.run(['books', 'texts'], 'readwrite', t => {
      t.objectStore('books').delete(id);
      t.objectStore('texts').delete(id);
    });
  },
};

function friendlyDbError(err) {
  const name = err?.name || '';
  const e = new Error(name === 'QuotaExceededError'
    ? 'Sem espaço para guardar o livro neste celular. Remova algum livro da estante e tente de novo.'
    : 'O navegador não deixou guardar o livro agora. Toque em "Tentar de novo". Se continuar, abra o app pelo Safari (ou pelo ícone na tela de início), não por dentro de outro aplicativo.');
  e.cause = err;
  return e;
}

/* ---------------- Utilidades ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function authorName(raw) {
  if (!raw) return 'Autor desconhecido';
  const m = raw.match(/^([^,]+),\s*(.+)$/);
  let n = m ? `${m[2]} ${m[1]}` : raw;
  return n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}
function cleanTitle(t) { return String(t || 'Sem título').split(/\r?\n|\$/)[0].replace(/\s+/g, ' ').trim(); }

const COVER_COLORS = ['#7a2e2a', '#2f4a3a', '#2b3d5c', '#5c3b5e', '#6b4b1f', '#335656', '#4a3a2a', '#81492a', '#24434f', '#5a2a3a', '#3f4a2a', '#4b2f4f'];
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function coverHTML(b) {
  const c = COVER_COLORS[hash(b.title + b.author) % COVER_COLORS.length];
  return `<div class="cover" style="background:linear-gradient(160deg, ${c}, color-mix(in srgb, ${c} 70%, #000))">
    <span class="c-title">${esc(b.title)}</span><span class="c-author">${esc(b.author)}</span></div>`;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function fmtSize(chars) {
  if (!chars) return '';
  const pages = Math.max(1, Math.round(chars / 1800));
  return `~${pages} páginas`;
}

function repoInfo() {
  // usuario.github.io/repositorio → links para editar a lista de livros
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return null;
  const repo = location.pathname.split('/').filter(Boolean)[0] || `${m[1]}.github.io`;
  return { owner: m[1], repo };
}

function pdStatus(deathYear) {
  if (!deathYear) return { ok: null, text: 'Ano de falecimento do autor não informado. Confira a situação no Brasil.' };
  const free = deathYear + 71;
  if (THIS_YEAR >= free) return { ok: true, text: `Autor falecido em ${deathYear}: domínio público no Brasil desde 1º/1/${free}.` };
  return { ok: false, text: `Autor falecido em ${deathYear}: no Brasil, a obra só entra em domínio público em 1º/1/${free}.` };
}

/* ---------------- Navegação entre telas ---------------- */
function goto(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === view));
  window.scrollTo(0, 0);
  if (view === 'explore') explore.init();
  if (view === 'shelf') shelf.render();
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) goto(g.dataset.goto);
});

/* ---------------- Estante ---------------- */
const shelf = {
  books: [],
  async render() {
    try { this.books = await db.allBooks(); } catch { this.books = []; }
    this.books.sort((a, b) => (b.lastRead || b.addedAt || 0) - (a.lastRead || a.addedAt || 0));
    const grid = $('#shelfGrid'), cont = $('#continueCard');
    $('#shelfEmpty').hidden = this.books.length > 0;
    $('#shelfCount').textContent = this.books.length ? `${this.books.length} ${this.books.length === 1 ? 'livro' : 'livros'}` : '';

    const cur = this.books.find(b => b.lastRead && b.progress > 0 && b.progress < 0.995);
    cont.innerHTML = cur ? `
      <button class="continue" data-open="${esc(cur.id)}">
        ${coverHTML(cur)}
        <div class="info">
          <div class="k">Continuar lendo</div>
          <div class="t">${esc(cur.title)}</div>
          <div class="muted">${esc(cur.author)} · ${Math.round(cur.progress * 100)}%</div>
        </div>
      </button>` : '';

    grid.innerHTML = this.books.map(b => `
      <button class="book" data-open="${esc(b.id)}" aria-label="${esc(b.title)}, ${esc(b.author)}">
        ${coverHTML(b)}
        ${b.progress > 0 ? `<div class="bar"><i style="width:${Math.min(100, Math.round(b.progress * 100))}%"></i></div>` : ''}
        <span class="b-meta">${b.progress > 0.995 ? 'Lido' : b.progress > 0 ? Math.round(b.progress * 100) + '%' : 'Novo'}</span>
      </button>`).join('');
  },
};

// Toque abre o livro; toque longo abre as opções (remover etc.)
(function shelfPress() {
  let timer, longFired = false;
  const zone = $('#view-shelf');
  zone.addEventListener('pointerdown', e => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    longFired = false;
    timer = setTimeout(() => { longFired = true; bookSheet(b.dataset.open); }, 550);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => zone.addEventListener(ev, () => clearTimeout(timer)));
  zone.addEventListener('contextmenu', e => { if (e.target.closest('[data-open]')) e.preventDefault(); });
  zone.addEventListener('click', e => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    if (longFired) { longFired = false; return; }
    reader.open(b.dataset.open);
  });
})();

/* ---------------- Explorar ---------------- */
const explore = {
  started: false, catalog: [], lang: prefs.get('lang'), next: null, query: '', reqId: 0,
  async init() {
    if (this.started) { this.loadCatalog(); return; } // recarrega: pedidos feitos ao GitHub aparecem aqui
    this.started = true;
    $$('#langChips .chip').forEach(c => {
      const on = c.dataset.lang === this.lang;
      c.classList.toggle('active', on); c.setAttribute('aria-checked', on);
    });
    this.loadCatalog();
    this.search();
  },
  async loadCatalog() {
    try {
      const r = await fetch('catalog.json', { cache: 'no-cache' });
      this.catalog = r.ok ? await r.json() : [];
    } catch { this.catalog = []; }
    this.renderCatalog();
  },
  async renderCatalog() {
    const have = new Set((await db.allBooks().catch(() => [])).map(b => b.id));
    const list = $('#curatedList');
    if (!this.catalog.length) {
      list.innerHTML = `<div class="notice">A biblioteca pronta ainda está sendo montada pelo GitHub. Volte em alguns minutos.</div>`;
      return;
    }
    list.innerHTML = this.catalog.map(b => {
      const book = { id: 'g' + b.id, title: b.title, author: b.author };
      return `<button class="row" data-gid="${b.id}" data-src="catalog">
        ${coverHTML(book)}
        <div class="info"><div class="t">${esc(b.title)}</div><div class="a">${esc(b.author)}</div></div>
        <span class="state ${have.has(book.id) ? 'ok' : ''}">${have.has(book.id) ? 'Na estante' : fmtSize(b.chars)}</span>
      </button>`;
    }).join('');
  },
  async search(more = false) {
    const box = $('#searchResults');
    const id = ++this.reqId;
    let url;
    if (more && this.next) url = this.next.replace(/^http:/, 'https:');
    else {
      const p = new URLSearchParams();
      if (this.query) p.set('search', this.query);
      if (this.lang) p.set('languages', this.lang);
      url = GUTENDEX + '?' + p.toString();
      box.innerHTML = `<div class="section-head"><h2>${this.query ? 'Resultados' : 'Mais lidos'}</h2><span class="muted">${this.query ? '' : 'no Gutenberg'}</span></div><div class="spinner"></div>`;
    }
    const moreBtn = $('#moreBtn'); if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = 'Carregando…'; }
    try {
      // o catálogo de busca (Gutendex) às vezes fica lento: desiste depois de 25 s
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(to));
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      if (id !== this.reqId) return;
      this.next = data.next;
      const have = new Set((await db.allBooks().catch(() => [])).map(b => b.id));
      const rows = data.results.map(x => {
        this.cache.set(String(x.id), x);
        const book = { id: 'g' + x.id, title: cleanTitle(x.title), author: authorName(x.authors?.[0]?.name) };
        return `<button class="row" data-gid="${x.id}">
          ${coverHTML(book)}
          <div class="info"><div class="t">${esc(book.title)}</div><div class="a">${esc(book.author)}</div></div>
          <span class="state ${have.has(book.id) ? 'ok' : ''}">${have.has(book.id) ? 'Na estante' : ''}</span>
        </button>`;
      }).join('');
      if (!more) {
        box.innerHTML = `<div class="section-head"><h2>${this.query ? 'Resultados' : 'Mais lidos'}</h2><span class="muted">${this.query ? data.count + ' livros' : 'no Gutenberg'}</span></div>
          <div class="list" id="resultList">${rows || '<div class="notice">Nada encontrado. Tente outra grafia: livros antigos usam a ortografia da época (ex.: "Guarany", "Braz Cubas").</div>'}</div>`;
      } else {
        $('#resultList').insertAdjacentHTML('beforeend', rows);
      }
      $('#moreBtn')?.remove();
      if (this.next) $('#resultList').insertAdjacentHTML('afterend', `<button class="btn small" id="moreBtn" style="margin:14px auto 0;display:flex">Carregar mais</button>`);
    } catch (err) {
      if (id !== this.reqId) return;
      box.innerHTML = `<div class="notice">${navigator.onLine ? 'O catálogo do Gutenberg não respondeu agora (às vezes ele fica lento). Tente a busca de novo em instantes; a biblioteca pronta abaixo continua disponível.' : 'Você está sem internet. Os livros da estante e da biblioteca pronta continuam disponíveis.'}</div>`;
    }
  },
  cache: new Map(),
};

$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  explore.query = q; explore.search();
  $('#searchInput').blur();
});
$('#searchInput').addEventListener('search', () => { if (!$('#searchInput').value) { explore.query = ''; explore.search(); } });
$('#langChips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  $$('#langChips .chip').forEach(x => { x.classList.toggle('active', x === c); x.setAttribute('aria-checked', x === c); });
  explore.lang = c.dataset.lang; prefs.set('lang', explore.lang);
  explore.search();
});
$('#view-explore').addEventListener('click', e => {
  if (e.target.id === 'moreBtn') return explore.search(true);
  const r = e.target.closest('[data-gid]'); if (!r) return;
  gutenbergSheet(r.dataset.gid, r.dataset.src === 'catalog');
});

/* ---------------- Ficha do livro (bottom sheet) ---------------- */
function openSheet(html) {
  $('#sheetBody').innerHTML = html; $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });

function metaFromCatalog(gid) {
  const c = explore.catalog.find(b => String(b.id) === String(gid));
  if (c) return { gid: String(c.id), title: c.title, author: c.author, lang: c.lang, deathYear: c.death_year, chars: c.chars, local: c.file, formats: {} };
  const x = explore.cache.get(String(gid));
  if (!x) return null;
  const a = x.authors?.[0];
  return { gid: String(x.id), title: cleanTitle(x.title), author: authorName(a?.name), lang: x.languages?.[0] || '', deathYear: a?.death_year, formats: x.formats || {}, translators: (x.translators || []).map(t => authorName(t.name)) };
}

async function gutenbergSheet(gid, fromCatalog) {
  const m = metaFromCatalog(gid); if (!m) return;
  const id = 'g' + m.gid;
  const have = await db.getBook(id).catch(() => null);
  const pd = pdStatus(m.deathYear);
  openSheet(`
    <div class="sheet-top">
      ${coverHTML({ title: m.title, author: m.author })}
      <div>
        <h3 id="sheetTitle">${esc(m.title)}</h3>
        <div class="muted">${esc(m.author)}</div>
        ${m.translators?.length ? `<div class="muted">Tradução: ${esc(m.translators.join(', '))}</div>` : ''}
        <div class="muted" style="margin-top:8px">${pd.text}</div>
      </div>
    </div>
    <div class="sheet-actions">
      ${have
        ? `<button class="btn primary" id="sRead">Ler</button><button class="btn danger" id="sRemove">Remover da estante</button>`
        : `<button class="btn primary" id="sDownload">Baixar para a estante</button>`}
      <div id="sMsg"></div>
    </div>`);
  $('#sRead')?.addEventListener('click', () => { closeSheet(); reader.open(id); });
  $('#sRemove')?.addEventListener('click', async () => { await db.remove(id); closeSheet(); toast('Livro removido'); explore.renderCatalog(); shelf.render(); });
  $('#sDownload')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Baixando…';
    try {
      await downloadBook(m);
      btn.textContent = 'Ler agora'; btn.disabled = false;
      btn.onclick = () => { closeSheet(); reader.open(id); };
      toast('Livro salvo na estante. Já funciona sem internet.');
      explore.renderCatalog(); shelf.render();
      $$(`[data-gid="${m.gid}"] .state`).forEach(s => { s.textContent = 'Na estante'; s.classList.add('ok'); });
    } catch (err) {
      btn.textContent = 'Tentar de novo'; btn.disabled = false;
      const ri = repoInfo();
      if (err.blocked && ri) {
        const q = new URLSearchParams({ title: `Livro ${m.gid}`, body: `${m.title} — ${m.author}` });
        btn.hidden = true;
        $('#sMsg').innerHTML = `<div class="notice" style="margin-top:0">O Gutenberg não deixa baixar este livro direto pelo celular. O GitHub pode buscá-lo para você: toque abaixo e depois em <strong>Create</strong> (ou <strong>Submit</strong>). Em uns 2 minutos ele aparece na <strong>Biblioteca pronta</strong>.</div>
          <a class="btn primary" style="width:100%;text-decoration:none" href="https://github.com/${ri.owner}/${ri.repo}/issues/new?${q}" target="_blank" rel="noopener">Pedir ao GitHub</a>`;
      } else {
        $('#sMsg').innerHTML = `<div class="notice">${esc(err.message)}</div>`;
      }
    }
  });
}

async function bookSheet(id) {
  const b = await db.getBook(id); if (!b) return;
  openSheet(`
    <div class="sheet-top">
      ${coverHTML(b)}
      <div><h3 id="sheetTitle">${esc(b.title)}</h3><div class="muted">${esc(b.author)}</div>
      <div class="muted" style="margin-top:8px">${Math.round((b.progress || 0) * 100)}% lido</div></div>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" id="sRead">Ler</button>
      ${b.progress > 0 ? `<button class="btn" id="sRestart">Recomeçar do início</button>` : ''}
      <button class="btn danger" id="sRemove">Remover da estante</button>
    </div>`);
  $('#sRead').onclick = () => { closeSheet(); reader.open(id); };
  $('#sRestart')?.addEventListener('click', async () => { b.progress = 0; await db.putBook(b); closeSheet(); reader.open(id); });
  $('#sRemove').onclick = async () => { await db.remove(id); closeSheet(); toast('Livro removido'); shelf.render(); };
}

/* ---------------- Download ---------------- */
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

async function downloadBook(m) {
  const urls = [];
  if (m.local) urls.push(m.local);
  const cat = explore.catalog.find(b => String(b.id) === m.gid);
  if (cat && !m.local) urls.push(cat.file);
  const fm = m.formats || {};
  const plain = Object.keys(fm).filter(k => k.startsWith('text/plain')).sort((a, b) => (b.includes('utf-8') ? 1 : 0) - (a.includes('utf-8') ? 1 : 0));
  plain.forEach(k => { if (!fm[k].endsWith('.zip')) urls.push(fm[k].replace(/^http:/, 'https:')); });
  urls.push(`https://www.gutenberg.org/cache/epub/${m.gid}/pg${m.gid}.txt`);

  let text = null, onlyRemote = !urls.some(u => !/^https?:/.test(u));
  for (const u of [...new Set(urls)]) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const t = decode(await r.arrayBuffer());
      if (t.length > 800) { text = t; break; }
    } catch { /* bloqueado ou sem rede: tenta a próxima fonte */ }
  }
  if (!text) {
    const e = new Error(navigator.onLine ? 'Não foi possível baixar este livro direto pelo celular.' : 'Sem internet. Conecte-se para baixar.');
    e.blocked = navigator.onLine && onlyRemote;
    throw e;
  }
  text = stripGutenberg(text);
  const book = { id: 'g' + m.gid, gid: m.gid, title: m.title, author: m.author, lang: m.lang, deathYear: m.deathYear || null, chars: text.length, addedAt: Date.now(), lastRead: 0, progress: 0 };
  try { navigator.storage?.persist?.(); } catch {}
  await db.save(book, text);
  return book;
}

/* Importar um .txt do próprio celular */
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const text = stripGutenberg(decode(await f.arrayBuffer()));
  const title = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  const book = { id: 'local-' + Date.now(), title, author: 'Arquivo importado', lang: 'pt', chars: text.length, addedAt: Date.now(), lastRead: 0, progress: 0 };
  await db.save(book, text);
  toast('Arquivo adicionado à estante'); goto('shelf');
});

/* ---------------- Limpeza e formatação do texto ---------------- */
function stripGutenberg(t) {
  t = t.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const s = t.search(/\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG E-?BOOK[^\n]*/i);
  if (s >= 0) t = t.slice(t.indexOf('\n', s) + 1);
  let e = t.search(/\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG E-?BOOK/i);
  if (e < 0) e = t.search(/\n\s*End of (the )?Project Gutenberg/i);
  if (e >= 0) t = t.slice(0, e);
  // linhas de crédito de produção que costumam vir no topo
  t = t.replace(/^\s*(Produced by|E-text prepared by|Transcribed from)[^\n]*(\n[^\n]+)*\n/i, '');
  return t.trim();
}

const CHAP_RE = /^(cap[ií]tulo|chapter|canto|livro|parte|book|part|act|acto|ato|cena|scene)\b|^[IVXLCDM]{1,7}\.?$/i;
function isHeading(lines) {
  if (lines.length > 2) return false;
  const s = lines.join(' ');
  if (s.length > 70 || s.length < 1) return false;
  if (CHAP_RE.test(s)) return true;
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 3 || letters !== letters.toUpperCase()) return false;
  // linha longa toda em maiúsculas terminada em ponto costuma ser frase, não título
  return !(s.length > 40 && /[.;,]$/.test(s.trim()));
}
function inline(s) {
  return esc(s).replace(/_([^_]{1,200})_/g, '<em>$1</em>');
}

function buildBookHTML(book, text) {
  const blocks = text.split(/\n[ \t]*\n+/);
  const out = [`<div class="titlepage"><h1>${esc(book.title)}</h1><div class="by">${esc(book.author)}</div></div>`];
  const toc = [];
  let lastWasHeading = false, hCount = 0;

  for (const raw of blocks) {
    const lines = raw.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
    if (!lines.length) continue;
    const trimmed = lines.map(l => l.trim());
    const joined = trimmed.join(' ');

    if (/^[\s*·.•\-_=~]+$/.test(joined)) { out.push(`<p class="sep">⁂</p>`); lastWasHeading = false; continue; }

    // Subtítulo logo após "CAPÍTULO X" / "IV": uma linha curta (ex.: "Do titulo.") junta-se ao título
    const prev = toc[toc.length - 1];
    if (lastWasHeading && prev?.chap && !prev.merged && trimmed.length === 1 && joined.length <= 60 && !CHAP_RE.test(joined)) {
      const sub = joined.replace(/\.$/, '');
      prev.label += ' — ' + sub; prev.merged = true;
      out[out.length - 1] = out[out.length - 1].replace(/<\/h2>$/, `<br><small>${inline(sub)}</small></h2>`);
      lastWasHeading = false;
      continue;
    }

    if (isHeading(trimmed)) {
      const label = joined;
      const id = 'h' + (hCount++);
      const chap = CHAP_RE.test(label);
      out.push(`<h2 id="${id}" class="${chap ? 'chap' : ''}">${inline(label)}</h2>`);
      toc.push({ id, label, chap });
      lastWasHeading = true;
      continue;
    }
    lastWasHeading = false;

    const avg = trimmed.reduce((a, l) => a + l.length, 0) / trimmed.length;
    const indented = lines.filter(l => /^\s{2,}/.test(l)).length;
    if (trimmed.length >= 2 && (avg < 48 || indented >= trimmed.length - 1 && avg < 60)) {
      out.push(`<p class="verse">${trimmed.map(inline).join('<br>')}</p>`);
    } else {
      out.push(`<p>${inline(joined.replace(/\s{2,}/g, ' '))}</p>`);
    }
  }
  // Se há capítulos reconhecíveis, o sumário mostra só eles (sem folha de rosto, editora etc.)
  const chapters = toc.filter(t => t.chap);
  return { html: out.join('\n'), toc: chapters.length >= 3 ? chapters : toc };
}

/* ---------------- Leitor paginado ---------------- */
const reader = {
  book: null, page: 0, pages: 1, stride: 1, toc: [], tocPages: [], saveTimer: null,
  el: $('#reader'), vp: $('#pageViewport'), flow: $('#flow'),

  async open(id) {
    const [book, t] = await Promise.all([db.getBook(id), db.getText(id)]);
    if (!book || !t) { toast('Não encontrei este livro na estante.'); return; }
    this.book = book;
    const { html, toc } = buildBookHTML(book, t.text);
    this.toc = toc;
    this.flow.lang = book.lang || 'pt';
    this.flow.innerHTML = html;
    $('#rTitle').textContent = book.title; $('#rAuthor').textContent = book.author;
    this.applyPrefs();
    this.el.hidden = false; $('#readerChrome').hidden = true; $('#tocPanel').hidden = true;
    document.body.style.overflow = 'hidden';
    history.pushState({ reader: id }, '');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    this.layout();
    this.goTo(Math.round((book.progress || 0) * this.pages), false);
    book.lastRead = Date.now(); db.putBook(book);
  },
  close() {
    this.saveNow();
    this.el.hidden = true; this.flow.innerHTML = ''; document.body.style.overflow = '';
    this.book = null; shelf.render();
  },
  applyPrefs() {
    const s = prefs.get('size'), th = prefs.get('theme'), f = prefs.get('font');
    this.el.style.setProperty('--r-size', s + 'px');
    this.el.classList.remove('t-light', 't-sepia', 't-dark'); this.el.classList.add('t-' + th);
    this.el.classList.toggle('f-sans', f === 'sans');
    $$('#readerChrome [data-theme]').forEach(b => b.classList.toggle('on', b.dataset.theme === th));
  },
  layout() {
    const w = this.vp.clientWidth, gap = 48;
    this.flow.style.columnWidth = w + 'px';
    this.flow.style.columnGap = gap + 'px';
    this.flow.style.width = w + 'px';
    this.stride = w + gap;
    this.pages = Math.max(1, Math.round((this.vp.scrollWidth + gap) / this.stride));
    const base = this.flow.getBoundingClientRect().left;
    this.tocPages = this.toc.map(t => {
      const el = document.getElementById(t.id);
      return el ? Math.max(0, Math.floor((el.getBoundingClientRect().left - base + 2) / this.stride)) : 0;
    });
    $('#progress').max = Math.max(1, this.pages - 1);
  },
  relayout() {
    if (!this.book) return;
    const frac = this.page / this.pages;
    this.vp.scrollLeft = 0;
    this.layout();
    this.goTo(Math.round(frac * this.pages), false);
  },
  goTo(p, save = true) {
    this.page = Math.max(0, Math.min(this.pages - 1, p));
    this.vp.scrollLeft = this.page * this.stride;
    this.updateFooter();
    if (save) this.scheduleSave();
  },
  next() { if (this.page < this.pages - 1) this.goTo(this.page + 1); else toast('Fim do livro'); },
  prev() { if (this.page > 0) this.goTo(this.page - 1); },
  currentChapter() {
    let idx = -1;
    for (let i = 0; i < this.tocPages.length; i++) if (this.tocPages[i] <= this.page) idx = i; else break;
    return idx;
  },
  updateFooter() {
    const pct = this.pages > 1 ? Math.round(this.page / (this.pages - 1) * 100) : 100;
    const ci = this.currentChapter();
    $('#footChapter').textContent = ci >= 0 ? this.toc[ci].label : '';
    $('#footPage').textContent = `${this.page + 1} de ${this.pages}`;
    $('#progress').value = this.page;
    $('#progressLabel').textContent = pct + '%';
  },
  scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveNow(), 600); },
  saveNow() {
    clearTimeout(this.saveTimer);
    if (!this.book) return;
    this.book.progress = this.pages > 1 ? this.page / (this.pages - 1) : 1;
    if (this.page >= this.pages - 1) this.book.progress = 1;
    this.book.lastRead = Date.now();
    db.putBook(this.book).catch(() => {});
  },
  toggleChrome(force) {
    const c = $('#readerChrome');
    c.hidden = force === undefined ? !c.hidden : !force;
  },
  showToc() {
    const ci = this.currentChapter();
    $('#tocList').innerHTML = this.toc.length
      ? this.toc.map((t, i) => `<li><button data-toc="${i}" class="${i === ci ? 'current' : ''}"><span>${esc(t.label)}</span><span class="pg">${this.tocPages[i] + 1}</span></button></li>`).join('')
      : `<li style="padding:20px" class="muted">Este livro não tem capítulos identificados. Use a barra de progresso para navegar.</li>`;
    $('#tocPanel').hidden = false;
    $('#tocList .current')?.scrollIntoView({ block: 'center' });
  },
};

/* Gestos: toque nas laterais vira a página, no centro abre o menu; deslizar também vira */
(function readerInput() {
  const R = reader.el;
  let sx = 0, sy = 0, st = 0, active = false;
  R.addEventListener('pointerdown', e => {
    if (e.target.closest('#readerChrome > *, #tocPanel')) return;
    active = true; sx = e.clientX; sy = e.clientY; st = Date.now();
  });
  R.addEventListener('pointerup', e => {
    if (!active) return; active = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!$('#readerChrome').hidden) { reader.toggleChrome(false); return; }
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { dx < 0 ? reader.next() : reader.prev(); return; }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || Date.now() - st > 800) return;
    const w = window.innerWidth;
    if (e.clientX < w * 0.3) reader.prev();
    else if (e.clientX > w * 0.7) reader.next();
    else reader.toggleChrome(true);
  });
  R.addEventListener('pointercancel', () => { active = false; });
  R.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (R.hidden) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); reader.next(); }
    if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); reader.prev(); }
    if (e.key === 'Escape') history.back();
  });
})();

$('#btnClose').addEventListener('click', () => history.back());
window.addEventListener('popstate', () => {
  if (!$('#tocPanel').hidden) { $('#tocPanel').hidden = true; history.pushState({ reader: reader.book?.id }, ''); return; }
  if (!reader.el.hidden) reader.close();
});
$('#progress').addEventListener('input', e => reader.goTo(+e.target.value));
$('#fontUp').addEventListener('click', () => { prefs.set('size', Math.min(30, prefs.get('size') + 1)); reader.applyPrefs(); reader.relayout(); });
$('#fontDown').addEventListener('click', () => { prefs.set('size', Math.max(14, prefs.get('size') - 1)); reader.applyPrefs(); reader.relayout(); });
$('#fontFamily').addEventListener('click', () => { prefs.set('font', prefs.get('font') === 'sans' ? 'serif' : 'sans'); reader.applyPrefs(); reader.relayout(); });
$$('#readerChrome [data-theme]').forEach(b => b.addEventListener('click', () => { prefs.set('theme', b.dataset.theme); reader.applyPrefs(); }));
$('#btnToc').addEventListener('click', () => reader.showToc());
$('#btnTocClose').addEventListener('click', () => { $('#tocPanel').hidden = true; });
$('#tocList').addEventListener('click', e => {
  const b = e.target.closest('[data-toc]'); if (!b) return;
  reader.goTo(reader.tocPages[+b.dataset.toc]);
  $('#tocPanel').hidden = true; reader.toggleChrome(false);
});

let rzTimer;
window.addEventListener('resize', () => { clearTimeout(rzTimer); rzTimer = setTimeout(() => reader.relayout(), 150); });
document.addEventListener('visibilitychange', () => { if (document.hidden) reader.saveNow(); });

/* ---------------- Início ---------------- */
shelf.render().then(() => { if (!shelf.books.length) goto('explore'); });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
