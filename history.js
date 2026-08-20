/* MyHistory — history.js
 * Page privilégiée (chrome://sine/content/MyHistory/history.html)
 * → accès direct à PlacesUtils (LECTURE SEULE), Services, IOUtils. Zéro bridge.
 *
 * ⚠️ RÉPARTITION DES RÔLES : cette page ne JAMAIS écrire dans Places
 * (instances ESM séparées page/browser — voir bug MyHub 2026-08-18).
 * Les suppressions passent par Services.obs 'myhistory-delete' →
 * my-history.uc.js (vraie instance PlacesUtils) → 'myhistory-deleted'.
 *
 * Event Driven Only : input (debounce autorisé), IntersectionObserver,
 * Services.obs. Zéro polling, zéro timer de vérification d'état.
 */

'use strict';

const TAG = '[MyHistory]';

const { PlacesUtils } = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');

const PAGE_SIZE = 120; // lignes SQL par page (agrégées par URL)

/* ═══════════════ État ═══════════════ */

const state = {
  query: '', // recherche titre/URL
  filter: 'all', // today | yesterday | week | month | all
  lastVisitDate: null, // keyset pagination (µs)
  lastRowId: null,
  busy: false,
  done: false,
  loadedUrls: new Set(), // anti-doublon entre pages SQL
  daySections: new Map(), // dayKey → { section, grid, sites, visits }
};

/* ═══════════════ Utilitaires ═══════════════ */

function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

let toastTimer = null;
function toast(msg, warn = false) {
  const t = document.getElementById('hy-toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.toggle('warn', warn);
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    toastTimer = setTimeout(() => (t.hidden = true), 350);
  }, 2200);
}

function escapeLike(q) {
  return q.replace(/[\\%_]/g, (c) => '\\' + c);
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/* Teinte stable par domaine — grid harmonisée même sans vignettes */
function hueOf(domain) {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return h % 360;
}

const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

function dayKeyOf(date) {
  return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
}

function dayLabel(date) {
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (dayKeyOf(date) === dayKeyOf(today)) return "Aujourd'hui";
  if (dayKeyOf(date) === dayKeyOf(yest)) return 'Hier';
  const s = dayFmt.format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Ouvre une URL dans un onglet de la fenêtre browser la plus récente */
function openInTab(url) {
  const win = Services.wm.getMostRecentWindow('navigator:browser');
  if (!win) return;
  win.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  win.focus();
}

/* ═══════════════ SQL Places (read-only) ═══════════════ */

function cutoffFor(filter) {
  const d = new Date();
  switch (filter) {
    case 'today':
      d.setHours(0, 0, 0, 0);
      break;
    case 'yesterday': {
      d.setDate(d.getDate() - 1);
      d.setHours(0, 0, 0, 0);
      break;
    }
    case 'week':
      d.setDate(d.getDate() - 7);
      break;
    case 'month':
      d.setDate(d.getDate() - 30);
      break;
    default:
      return null;
  }
  return d.getTime() * 1000; // µs
}

/** Une page SQL : URLs uniques agrégées, ordonnées par dernière visite DESC.
 *  Keyset pagination sur (visit_date, rowid) — jamais OFFSET (coût croissant). */
async function fetchPage() {
  const db = await PlacesUtils.promiseDBConnection();
  const clauses = ['p.hidden = 0'];
  const params = { limit: PAGE_SIZE };

  if (state.query) {
    clauses.push(`(p.title LIKE :q ESCAPE '\\' OR p.url LIKE :q ESCAPE '\\')`);
    params.q = '%' + escapeLike(state.query) + '%';
  }
  const cutoff = cutoffFor(state.filter);
  if (cutoff != null) {
    clauses.push('v.visit_date >= :cutoff');
    params.cutoff = cutoff;
  }
  if (state.lastVisitDate != null) {
    clauses.push('(v.visit_date < :bd OR (v.visit_date = :bd AND p.id < :bi))');
    params.bd = state.lastVisitDate;
    params.bi = state.lastRowId;
  }

  const sql = `
    SELECT p.id AS rowid, p.url, p.title, MAX(v.visit_date) AS lastVisit, COUNT(*) AS visits
    FROM moz_places p
    JOIN moz_historyvisits v ON v.place_id = p.id
    WHERE ${clauses.join(' AND ')}
    GROUP BY p.url
    ORDER BY lastVisit DESC, rowid DESC
    LIMIT :limit + 1`;

  const rows = await db.executeCached(sql, params);
  const out = [];
  for (const row of rows) {
    out.push({
      rowId: row.getResultByName('rowid'),
      url: row.getResultByName('url'),
      title: row.getResultByName('title') || row.getResultByName('url'),
      lastVisit: row.getResultByName('lastVisit'),
      visits: row.getResultByName('visits'),
    });
  }
  return out; // +1 row = signal "il reste"
}

/* ═══════════════ Favicons (canon CustomFavicon + Places) ═══════════════ */

/* Base64 par chunks — spread complet explosait sur les icônes > 64 Ko */
function toB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

const Favicon = {
  cache: {}, // clé → data:image/png;base64,...

  async loadCanon() {
    const dirs = [
      PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'CustomFavicon', 'icons'),
      PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'CustomFavicon', 'icons', 'Chatbots'),
    ];
    for (const dir of dirs) {
      try {
        if (!(await IOUtils.exists(dir))) continue;
        for (const filePath of await IOUtils.getChildren(dir)) {
          if (!filePath.toLowerCase().endsWith('.png')) continue;
          const key = filePath
            .split(/[/\\]/)
            .pop()
            .replace(/\.png$/i, '')
            .toLowerCase();
          if (!this.cache[key]) this.cache[key] = 'data:image/png;base64,' + toB64(await IOUtils.read(filePath));
        }
      } catch (e) {
        console.warn(TAG, 'canon favicons:', e);
      }
    }
  },

  canonFor(domain) {
    return this.cache[domain] || this.cache[domain.split('.')[0]] || null;
  },

  placesFor(url) {
    return new Promise((resolve) => {
      try {
        PlacesUtils.favicons.getFaviconURLForPage(Services.io.newURI(url), (iconURI) => resolve(iconURI ? iconURI.spec : null));
      } catch {
        resolve(null);
      }
    });
  },
};

/* ═══════════════ Rendu ═══════════════ */

function getDaySection(date) {
  const key = dayKeyOf(date);
  let day = state.daySections.get(key);
  if (day) return day;

  const timeline = document.getElementById('hy-timeline');
  const section = el('section', 'hy-day');
  const head = el('div', 'hy-day-head');
  head.append(el('h2', null, dayLabel(date)), el('span', 'hy-day-stats', '…'));
  const grid = el('div', 'hy-grid');
  section.append(head, grid);
  timeline.append(section); // ordre chronologique : les sections arrivent en DESC, append naturel

  day = { section, grid, head, sites: 0, visits: 0 };
  state.daySections.set(key, day);
  return day;
}

function refreshDayStats(day) {
  day.head.querySelector('.hy-day-stats').textContent =
    day.sites + (day.sites > 1 ? ' sites · ' : ' site · ') + day.visits + (day.visits > 1 ? ' visites' : ' visite');
}

function buildCard(entry) {
  const date = new Date(entry.lastVisit / 1000);
  const domain = domainOf(entry.url);
  const hue = hueOf(domain);

  const card = el('article', 'hy-card');
  card.dataset.url = entry.url;

  /* ── Vignette + cascade de fallbacks ── */
  const thumb = el('div', 'hy-thumb');
  const fallback = el('div', 'hy-fallback');
  // Alpha 0.5 : la couleur du domaine laisse passer le wallpaper derrière (glass)
  fallback.style.background = `linear-gradient(135deg, hsl(${hue} 42% 22% / 0.5), hsl(${(hue + 40) % 360} 38% 14% / 0.5))`;
  thumb.append(fallback);

  if (entry.visits > 1) thumb.append(el('span', 'hy-visits', '×' + entry.visits));

  // 1. Thumbnail PageThumbs si présent (onerror = fallback, event-driven)
  const shot = el('img', 'hy-shot');
  shot.src = 'moz-page-thumb://thumbnail/?url=' + encodeURIComponent(entry.url);
  shot.onload = () => shot.classList.add('is-loaded');
  shot.onerror = () => shot.remove();
  thumb.prepend(shot);

  // 2. Favicon : canon CustomFavicon → Places → tuile lettre (async, non bloquant)
  decorateFallback(fallback, entry.url, domain, hue);

  /* ── Barre d'actions hover ── */
  const actions = el('div', 'hy-actions');
  const bOpen = el('button', null, 'Ouvrir');
  const bCopy = el('button', null, 'Copier');
  const bForget = el('button', null, 'Oublier');
  bOpen.addEventListener('click', (e) => {
    e.stopPropagation();
    openInTab(entry.url);
  });
  bCopy.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(entry.url);
      toast('URL copiée');
    } catch {
      toast('Copie impossible', true);
    }
  });
  bForget.addEventListener('click', (e) => {
    e.stopPropagation();
    // La page n'écrit JAMAIS dans Places → délégation au .uc.js via obs
    Services.obs.notifyObservers(null, 'myhistory-delete', JSON.stringify([entry.url]));
    toast('Entrée retirée de l’historique');
  });
  actions.append(bOpen, bCopy, bForget);
  thumb.append(actions);

  /* ── Meta ── */
  const meta = el('div', 'hy-meta');
  const metaTxt = el('div', 'hy-meta-txt');
  const title = el('div', 'hy-title', entry.title);
  const sub = el('div', 'hy-sub', domain + ' · ' + timeFmt.format(date));
  metaTxt.append(title, sub);
  meta.append(el('span', 'hy-dot'), metaTxt);
  meta.querySelector('.hy-dot').style.background = `hsl(${hue} 55% 45%)`;
  decorateMetaIcon(meta, entry.url, domain, hue);

  card.addEventListener('click', () => openInTab(entry.url));
  card.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') openInTab(entry.url);
  });
  card.tabIndex = 0;

  card.append(thumb, meta);
  return card;
}

async function decorateFallback(fallback, url, domain, hue) {
  const icon = Favicon.canonFor(domain) || (await Favicon.placesFor(url));
  if (icon) {
    const img = el('img');
    img.src = icon;
    fallback.append(img);
  } else {
    fallback.append(el('span', 'hy-letter', (domain[0] || '?').toUpperCase()));
  }
}

async function decorateMetaIcon(meta, url, domain, hue) {
  const dot = meta.querySelector('.hy-dot');
  const icon = Favicon.canonFor(domain) || (await Favicon.placesFor(url));
  if (!icon) return; // le dot teinté reste
  dot.replaceWith(
    (() => {
      const img = el('img');
      img.src = icon;
      return img;
    })(),
  );
}

/* ═══════════════ Chargement ═══════════════ */

function renderSkeletons(n = 8) {
  const timeline = document.getElementById('hy-timeline');
  const day = getDaySection(new Date());
  for (let i = 0; i < n; i++) day.grid.append(el('article', 'hy-card skeleton'));
}

function clearAll() {
  document.getElementById('hy-timeline').replaceChildren();
  document.getElementById('hy-empty').hidden = true;
  document.getElementById('hy-end').hidden = true;
  state.daySections.clear();
  state.loadedUrls.clear();
  state.lastVisitDate = null;
  state.lastRowId = null;
  state.done = false;
}

async function loadMore() {
  if (state.busy || state.done) return;
  state.busy = true;
  document.getElementById('hy-sentinel').hidden = false;

  let rows;
  try {
    rows = await fetchPage();
  } catch (e) {
    console.error(TAG, 'SQL :', e);
    toast('Erreur de lecture de l’historique', true);
    state.busy = false;
    document.getElementById('hy-sentinel').hidden = true;
    return;
  }

  // retirer les squelettes éventuels de la section courante
  for (const day of state.daySections.values()) day.grid.querySelectorAll('.skeleton').forEach((s) => s.remove());

  const hasMore = rows.length > PAGE_SIZE;
  if (hasMore) rows.pop();

  let added = 0;
  for (const r of rows) {
    if (state.loadedUrls.has(r.url)) continue; // une URL déplacée de jour entre pages
    state.loadedUrls.add(r.url);
    const date = new Date(r.lastVisit / 1000);
    const day = getDaySection(date);
    day.grid.append(buildCard(r));
    day.sites++;
    day.visits += r.visits;
    refreshDayStats(day);
    added++;
  }

  const last = rows[rows.length - 1];
  if (last) {
    state.lastVisitDate = last.lastVisit;
    state.lastRowId = last.rowId;
  }

  const totalLoaded = state.daySections.size + ' jours · ' + state.loadedUrls.size + ' pages';
  const count = document.getElementById('hy-count');
  count.textContent = totalLoaded;
  count.hidden = false;

  if (!hasMore || added === 0) {
    state.done = true;
    document.getElementById('hy-sentinel').hidden = true;
    if (state.loadedUrls.size === 0) document.getElementById('hy-empty').hidden = false;
    else document.getElementById('hy-end').hidden = false;
  }
  state.busy = false;
}

/* ═══════════════ Événements (event-driven only) ═══════════════ */

function wireEvents() {
  // Recherche — debounce (répond à un événement, autorisé par le credo)
  let debTimer = null;
  document.getElementById('hy-search').addEventListener('input', (e) => {
    clearTimeout(debTimer);
    debTimer = setTimeout(() => {
      state.query = e.target.value.trim();
      clearAll();
      renderSkeletons();
      loadMore();
    }, 160);
  });

  // Chips de filtre temporel
  document.getElementById('hy-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.hy-chip');
    if (!chip) return;
    for (const c of document.querySelectorAll('.hy-chip')) c.classList.toggle('is-active', c === chip);
    state.filter = chip.dataset.filter;
    clearAll();
    renderSkeletons();
    loadMore();
  });

  // Infinite scroll — IntersectionObserver (zéro polling)
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) loadMore();
  }).observe(document.getElementById('hy-sentinel'));

  // Retours du .uc.js : suppressions effectives → retirer les cartes du DOM
  Services.obs.addObserver(
    {
      observe(_subject, _topic, data) {
        let urls = [];
        try {
          urls = JSON.parse(data || '[]');
        } catch {
          return;
        }
        const set = new Set(urls);
        for (const card of document.querySelectorAll('.hy-card')) {
          if (set.has(card.dataset.url)) card.remove();
        }
      },
    },
    'myhistory-deleted',
  );
}

/* ═══════════════ Boot ═══════════════ */

(async function boot() {
  console.log(TAG, 'page chargée — lecture read-only de places.sqlite');
  wireEvents();
  renderSkeletons();
  try {
    await Favicon.loadCanon();
  } catch (e) {
    console.warn(TAG, 'canon favicons indisponible :', e);
  }
  console.log(TAG, 'canon favicons :', Object.keys(Favicon.cache).length, 'icônes');
  await loadMore();
})();
