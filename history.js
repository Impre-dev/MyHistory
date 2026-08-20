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
  dedup: new Map(), // clé normalisée → carte (fusion des URLs équivalentes)
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
    // www ET m retirés — même nettoyage que normalizeKey : mobile/desktop
    // d'un même site partagent couleur, favicon canon et identité
    return new URL(url).hostname.replace(/^(www|m)\./, '');
  } catch {
    return url;
  }
}

/** Clé de dédup — la même ressource sous plusieurs URLs exactes = une carte.
 *  YouTube : la vidéo est définie par v= (list/index/t/pp = contexte, ignorés).
 *  Générique : host sans www/m + path + params triés sans trackers. */
const TRACK_PARAMS = new Set([
  't',
  'si',
  'pp',
  'list',
  'index',
  'feature',
  'start',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
  'ref',
  'referrer',
]);

function normalizeKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if ((host === 'youtube.com' || host === 'youtu.be') && u.pathname === '/watch') {
      return 'yt:watch:' + (u.searchParams.get('v') || u.pathname);
    }
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACK_PARAMS.has(k))
      .sort()
      .map(([k, v]) => k + '=' + v)
      .join('&');
    return host + u.pathname + (params ? '?' + params : '');
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
      title: row.getResultByName('title'), // null possible — fallback domaine au rendu
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
  // Groupe de dédup : toutes les URLs exactes fusionnées dans cette carte
  const group = { urls: [entry.url], hasRealTitle: !!entry.title, visits: entry.visits, badgeEl: null, titleEl: null };
  card.__hy = group;
  card.dataset.urls = JSON.stringify(group.urls);

  /* ── Vignette + cascade de fallbacks ── */
  const thumb = el('div', 'hy-thumb');
  const fallback = el('div', 'hy-fallback');
  // Alpha 0.5 : la couleur du domaine laisse passer le wallpaper derrière (glass)
  fallback.style.background = `linear-gradient(135deg, hsl(${hue} 42% 22% / 0.5), hsl(${(hue + 40) % 360} 38% 14% / 0.5))`;
  thumb.append(fallback);

  if (entry.visits > 1) {
    group.badgeEl = el('span', 'hy-visits', '×' + entry.visits);
    thumb.append(group.badgeEl);
  }

  // 1. Thumbnail PageThumbs si présent (onerror = fallback, event-driven)
  const shot = el('img', 'hy-shot');
  shot.src = 'moz-page-thumb://thumbnail/?url=' + encodeURIComponent(entry.url);
  shot.onload = () => shot.classList.add('is-loaded');
  shot.onerror = () => shot.remove();
  thumb.prepend(shot);

  // 2. Favicon : canon CustomFavicon → Places → Google S2 → tuile lettre
  //    (chaînage onerror = event-driven, chaque échec tente le suivant)
  decorateFallback(fallback, entry.url, domain);

  /* ── Poubelle (hover, haut-gauche) — seule action : le clic ouvre déjà ── */
  const forget = el('button', 'hy-forget');
  forget.title = 'Oublier cette entrée';
  forget.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  forget.addEventListener('click', (e) => {
    e.stopPropagation();
    // La page n'écrit JAMAIS dans Places → délégation au .uc.js via obs
    // Suppression GROUPÉE : toutes les URLs exactes fusionnées dans la carte
    Services.obs.notifyObservers(null, 'myhistory-delete', JSON.stringify(group.urls));
    toast('Entrée retirée de l’historique');
  });
  thumb.append(forget);

  /* ── Meta ── */
  const meta = el('div', 'hy-meta');
  const metaTxt = el('div', 'hy-meta-txt');
  const title = el('div', 'hy-title', entry.title || domain); // fallback domaine, jamais l'URL brute
  group.titleEl = title;
  const sub = el('div', 'hy-sub', domain + ' · ' + timeFmt.format(date));
  metaTxt.append(title, sub);
  meta.append(metaTxt);

  card.addEventListener('click', () => openInTab(entry.url));
  card.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') openInTab(entry.url);
  });
  card.tabIndex = 0;

  card.append(thumb, meta);
  return card;
}

/** Fusionne un doublon normalisé dans sa carte existante (visites + titre + badge) */
function mergeDuplicate(prevCard, r) {
  const g = prevCard.__hy;
  g.urls.push(r.url);
  prevCard.dataset.urls = JSON.stringify(g.urls);
  g.visits += r.visits;
  if (r.title && !g.hasRealTitle) {
    g.hasRealTitle = true;
    g.titleEl.textContent = r.title;
  }
  if (g.visits > 1) {
    if (!g.badgeEl) {
      g.badgeEl = el('span', 'hy-visits');
      prevCard.querySelector('.hy-thumb').prepend(g.badgeEl);
    }
    g.badgeEl.textContent = '×' + g.visits;
  }
}

async function decorateFallback(fallback, url, domain) {
  // Cascade de candidats — CustomFavicon prioritaire, Google S2 en filet de secours réseau
  const candidates = [];
  const canon = Favicon.canonFor(domain);
  if (canon) candidates.push(canon);
  const places = await Favicon.placesFor(url);
  if (places) candidates.push(places);
  candidates.push('https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=64');

  let i = 0;
  const img = el('img');
  img.addEventListener('error', () => {
    i++;
    if (i < candidates.length) img.src = candidates[i];
    else img.replaceWith(el('span', 'hy-letter', (domain[0] || '?').toUpperCase()));
  });
  img.src = candidates[i];
  fallback.append(img);
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
  state.dedup.clear();
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

    // Dédup : URL équivalente déjà affichée → fusion dans la carte existante
    const key = normalizeKey(r.url);
    const prev = state.dedup.get(key);
    if (prev) {
      mergeDuplicate(prev, r);
      day.visits += r.visits; // visites comptées sur leur jour réel
      refreshDayStats(day);
      continue;
    }

    const card = buildCard(r);
    state.dedup.set(key, card);
    day.grid.append(card);
    day.sites++;
    day.visits += r.visits;
    refreshDayStats(day);
    added++;
  }

  // Page entière de doublons fusionnés : enchaîner (sinon l'IO ne re-fire pas)
  if (added === 0 && rows.length > 0) {
    state.busy = false;
    return loadMore();
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
          // Match par groupe : toute URL exacte fusionnée dans la carte la retire
          let group = [];
          try {
            group = JSON.parse(card.dataset.urls || '[]');
          } catch {}
          if (set.has(card.dataset.url) || group.some((u) => set.has(u))) card.remove();
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
