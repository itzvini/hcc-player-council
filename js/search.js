import { t } from './i18n.js';

// Site search — one box over every page on the site and everything in the archive.
//
// The archive already had a search, but it lived inside the Collections panel, so it
// went away the moment you left the tab, and it only knew about releases, items, traits,
// terms and Creature numbers. A member looking for the cash-out guide or the perks
// calculator had the nav and nothing else. So the matcher moved out here, gained the
// site's own pages, and got a second front door that is on every page: the magnifier in
// the nav, "/" or Ctrl/Cmd-K.
//
// Two rules carried over from the archive box, and they are the whole design:
//   Every result is a link to a real address, never a filter. The two boxes inside the
//   Collections grids narrow what you are already looking at; this one takes you
//   somewhere.
//   Nothing is fetched until someone types. The palette is wired at boot because it has
//   to answer a keystroke, but its data is not: the page index is a few KB and the
//   archive is 180, and a member who never searches should pay for neither.
//
// The archive groups come from codex.js, which owns that data and those addresses. This
// file owns the ranking, the rows, the keyboard and the pages.

const PER_GROUP = 6;

// Kinds whose rows can carry a picture. An item or a trait either has its art baked or
// it doesn't, so those groups keep the frame either way and their rows stay aligned; a
// page, a term, a release and a Creature number never have one, and an empty grey square
// on every row of those groups reads as art that failed rather than art that never was.
const FRAMED = new Set(['item', 'trait']);

/* ------------------------------------------------------------------ ranking */

// Something that starts with what you typed beats something that merely contains it, and
// a shorter name beats a longer one. That puts "Zedd" above "Zedd Plushie" when you type
// "zedd", which is what you meant. Lower is better; null means no match.
export function searchScore(name, q) {
  const n = String(name).toLowerCase();
  const at = n.indexOf(q);
  if (at < 0) return null;
  return (at === 0 ? 0 : 1000) + at + n.length / 100;
}

export function searchRow(href, label, meta, kind, art) {
  return { href, label, meta, kind, art };
}

// Escaping is this file's own: it renders into innerHTML and must not wait on the
// archive module to load to do it safely.
function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// t() with {placeholders} filled in. An unresolved key comes back untouched, which is
// what the shell already treats as "keep the markup's own label".
function tr(key, vars) {
  let s = t(key);
  if (s === key) return s;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}

/* -------------------------------------------------------------------- pages */

// The site's own pages, from the table the server already keeps for share cards and the
// sitemap. Serving that rather than a hand-kept copy is the point: a page added for a
// card is findable the same day, and there is no second list to fall out of step.
let pageDoc = null;
function pageIndex() {
  if (!pageDoc) pageDoc = fetch('/api/search/pages')
    .then(res => {
      if (!res.ok) throw new Error('pages');
      return res.json();
    })
    .then(doc => doc.pages || [])
    .catch(err => { pageDoc = null; throw err; });
  return pageDoc;
}

// Which part of the site a page belongs to, for the line under its name. The keys are
// the nav's own, so a page's section is labelled the same in the results as in the menu.
const SECTION_KEY = {
  club: 'nav.club',
  announcements: 'nav.announcements',
  council: 'nav.governance',
  polls: 'nav.polls',
  roadmap: 'nav.roadmap',
  collections: 'nav.collections',
  guides: 'nav.guides',
  perks: 'nav.perks',
  market: 'nav.data',
  trade: 'nav.marketplace',
  profile: 'trade.profile.h',
  changelog: 'nav.changelog',
  contribute: 'nav.contribute',
  terms: 'terms.h2',
  privacy: 'privacy.h2',
};

function sectionName(slug) {
  const key = SECTION_KEY[slug];
  const label = key ? t(key) : null;
  return label && label !== key ? label : null;
}

// A page's name in the reader's language. `tk` names an en.json key, so it follows the
// language switch; `t` is literal for the few routes no single key says well, and stays
// English exactly as their share cards do. `ttpl` wraps the keyed name, which is how the
// marketplace tour says which tour it is — "Cash out" alone reads as the marketplace's
// own button rather than a step in a guide about it.
function pageTitle(page) {
  const keyed = page.tk ? t(page.tk) : null;
  let name = keyed && keyed !== page.tk ? keyed : page.t;
  if (name && page.ttpl) name = page.ttpl.split('{k}').join(name);
  return name || null;
}

function pageSummary(page) {
  const keyed = page.dk ? t(page.dk) : null;
  return (keyed && keyed !== page.dk ? keyed : page.d) || '';
}

// A page matches on its name, and failing that on its summary or its address. The name
// is what people type, so it wins outright; the other two are there because four dozen
// terse titles do not cover the words a member reaches for. "fees" is in no page title and in
// two summaries; "cash-out" is in an address. A weak match is still the right answer,
// so it is offered — ranked below every name match, never above one.
const WEAK = 100000;

async function pageResults(q) {
  let pages;
  try { pages = await pageIndex(); } catch { return null; }

  const hits = [];
  for (const page of pages) {
    const name = pageTitle(page);
    if (!name) continue;
    let score = searchScore(name, q);
    if (score == null) {
      const weak = searchScore(pageSummary(page), q) ?? searchScore(page.p.replace(/[/-]/g, ' '), q);
      if (weak == null) continue;
      score = WEAK + weak;
    }
    hits.push({ score, page, name });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.score - b.score);
  return {
    key: 'page',
    total: hits.length,
    rows: hits.slice(0, PER_GROUP).map(({ page, name }) => searchRow(
      page.p, name, sectionName(page.s) || '', 'page', null)),
  };
}

/* ------------------------------------------------------------------ matching */

// The archive is a separate module and a separate 180KB, so it is imported the first
// time someone types rather than at boot. Failing to load it narrows the results to
// pages; it never takes the box down.
let archivePromise = null;
function archiveMatcher() {
  if (!archivePromise) archivePromise = import('./codex.js')
    .then(mod => mod.archiveResults)
    .catch(error => {
      console.error('[search] codex.js did not load — the archive is out of reach.', error);
      return null;
    });
  return archivePromise;
}

// Group order, and the reasoning behind it: a bare number is an exact answer, so the
// Creature it names comes first. Pages are next because there are only four dozen and a
// common word ("perks", "cash out", "polls") almost always means one — the archive groups
// run to thousands of rows and are reached by a distinctive name, not a common one.
const ORDER = ['creature', 'page', 'term', 'trait', 'item', 'release'];

function ordered(groups) {
  return groups.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

// null means "too short to search", which the boxes read as "close the list" rather than
// as "nothing matched". A single digit is enough, because it can name a Creature.
//
// `onPartial` is why this isn't one await: the page index is a few KB and the archive is
// 180, so on a phone the first keystroke would otherwise sit on a blank list until the
// whole archive had come down — to answer a query that, most of the time, a page answers.
// What is ready goes up, and the archive joins it a moment later.
export async function searchResults(raw, onPartial) {
  const q = raw.trim().toLowerCase();
  if (q.length < 2 && !/^\d+$/.test(q)) return null;

  const pages = pageResults(q);
  const archive = archiveMatcher().then(m => (m ? m(q).catch(() => []) : []));
  if (onPartial) pages.then(page => page && onPartial(ordered([page]))).catch(() => {});

  const [page, arch] = await Promise.all([pages, archive]);
  return ordered([...(arch || []), ...(page ? [page] : [])]);
}

/* ------------------------------------------------------------------ a box */

// Both front doors are the same three elements — an input, a listbox, and a highlighted
// row the arrow keys walk — so they are wired by one function rather than written twice.
// `navigate` takes a result's address and paints it in place; `onEscape` is how the
// palette closes itself, which the in-page box has no need of.
function wireBox({ input, list, navigate, onEscape, absolute = true }) {
  let rows = [];      // what is currently listed, in order, for the arrow keys
  let at = -1;        // which row is highlighted
  let seq = 0;
  let timer;

  function close() {
    list.innerHTML = '';
    if (absolute) list.hidden = true;
    rows = [];
    at = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function render(groups, q) {
    if (!groups) { close(); return; }
    rows = groups.flatMap(g => g.rows);
    at = -1;
    if (!rows.length) {
      list.innerHTML = `<p class="srch-none">${esc(tr('srch.none', { q }))}</p>`;
    } else {
      list.innerHTML = groups.map(g => `
        <div class="srch-group" role="group" aria-label="${esc(t(`srch.g.${g.key}`))}">
          <span class="srch-g-h">${esc(t(`srch.g.${g.key}`))}${
            g.total > g.rows.length ? `<i>${esc(tr('srch.more', { n: g.total - g.rows.length }))}</i>` : ''}</span>
          ${g.rows.map(r => `
            <a class="srch-row" role="option" aria-selected="false" href="${esc(r.href)}"
              id="${input.id}-r${rows.indexOf(r)}" data-kind="${esc(r.kind)}">
              ${r.art || FRAMED.has(r.kind) ? `<span class="srch-shot${r.art ? '' : ' is-empty'}">${r.art
                ? `<img src="${esc(r.art)}" alt="" loading="lazy" decoding="async">` : ''}</span>` : ''}
              <span class="srch-t">
                <span class="srch-n">${esc(r.label)}</span>
                <span class="srch-m">${esc(r.meta)}</span>
              </span>
            </a>`).join('')}
        </div>`).join('');
    }
    // Art that 404s (an item whose picture was never baked) leaves a broken-image glyph,
    // which reads as a fault rather than an absence. CSP forbids an inline onerror, so
    // the picture is dropped here and the empty frame stands in.
    list.querySelectorAll('.srch-shot img').forEach(img =>
      img.addEventListener('error', () => {
        img.parentElement?.classList.add('is-empty');
        img.remove();
      }, { once: true }));
    if (absolute) list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  // Arrow keys walk the flattened list, so they cross group boundaries without the
  // reader having to know there were groups.
  function move(delta) {
    if (!rows.length) return;
    at = (at + delta + rows.length) % rows.length;
    list.querySelectorAll('.srch-row').forEach((el, i) => {
      const on = i === at;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-selected', String(on));
      if (on) {
        el.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', el.id);
      }
    });
  }

  function run() {
    clearTimeout(timer);
    const value = input.value;
    timer = setTimeout(async () => {
      const mine = ++seq;
      // Two renders for one query, and the guard is the same both times: a keystroke that
      // landed while this one was still fetching wins, whichever half is answering.
      const groups = await searchResults(value, partial => {
        if (mine === seq) render(partial, value.trim());
      });
      if (mine === seq) render(groups, value.trim());
    }, 140);
  }

  input.addEventListener('input', run);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Escape') { close(); onEscape ? onEscape() : input.blur(); }
    else if (event.key === 'Enter' && at >= 0) {
      event.preventDefault();
      list.querySelectorAll('.srch-row')[at]?.click();
    }
  });

  // Following a result leaves the box holding a query for a page you are now looking at.
  //
  // The row is a real <a href>, which is the point — a middle or modified click opens a
  // new tab and a crawler sees an address — so a plain click has to be cancelled by hand
  // or the browser reloads the entire site on the way to a page the app paints in place.
  // That was the whole cost of the old box living inside Collections: its results were
  // three known path prefixes, and app.js caught those centrally. A result can now be
  // any address on the site, so the box that rendered it navigates it.
  list.addEventListener('click', event => {
    const link = event.target.closest?.('.srch-row');
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    input.value = '';
    close();
    if (onEscape) onEscape();
    navigate?.(link.getAttribute('href'));
  });

  return { close, rerun: () => { if (input.value.trim()) run(); } };
}

/* --------------------------------------------------------- the in-page box */

// The archive's box, above the Collections sub-nav. Its list floats over the page, so it
// closes on an outside click; the palette has a scrim for that.
let colBox = null;
export function initCollectionsSearch(navigate) {
  if (colBox) return;
  const input = document.getElementById('col-srch');
  const list = document.getElementById('col-srch-list');
  if (!input || !list) return;
  colBox = wireBox({ input, list, navigate });
  document.addEventListener('click', event => {
    if (!list.hidden && !event.target.closest('.srch')) colBox.close();
  });
}

/* ----------------------------------------------------------- the palette */

// The header search. Opened from the nav, by "/" from anywhere, or by Ctrl/Cmd-K.
let pal = null;

// A keystroke means "search" only when the reader is not already typing into something.
// Without this, "/" is unusable in the price filter, the transfer address and the
// application form, which is a worse bug than having no shortcut at all.
function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function initSearchPalette(navigate) {
  if (pal) return;
  const root = document.getElementById('srch-pal');
  const input = document.getElementById('srch-pal-in');
  const list = document.getElementById('srch-pal-list');
  const button = document.getElementById('nav-srch');
  if (!root || !input || !list) return;

  let opener = null;   // what to hand focus back to on close

  function open() {
    if (!root.hidden) { input.focus(); input.select(); return; }
    opener = document.activeElement;
    root.hidden = false;
    document.body.classList.add('srch-open');
    button?.setAttribute('aria-expanded', 'true');
    // The card animates in, and focusing mid-flight makes iOS scroll the page under it.
    requestAnimationFrame(() => input.focus());
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('srch-open');
    button?.setAttribute('aria-expanded', 'false');
    input.value = '';
    box.close();
    // Back to whatever opened it, so a keyboard reader is not dropped at the top of the
    // document. A stale opener (a result re-rendered the panel it lived in) is skipped.
    if (opener && document.body.contains(opener)) opener.focus();
    opener = null;
  }

  const box = wireBox({ input, list, absolute: false, navigate, onEscape: close });

  button?.addEventListener('click', () => (root.hidden ? open() : close()));
  document.getElementById('srch-pal-scrim')?.addEventListener('click', close);
  document.getElementById('srch-pal-x')?.addEventListener('click', close);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !root.hidden) { close(); return; }
    if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      root.hidden ? open() : close();
      return;
    }
    if (event.key === '/' && root.hidden && !isTyping(event.target)
        && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      open();
    }
  });

  // A dialog holds focus. Without this Tab walks off into the page behind the scrim,
  // where a screen reader then reads a nav the reader cannot see.
  root.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const stops = [...root.querySelectorAll('input, button, a[href]')]
      .filter(el => !el.hidden && el.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  pal = { open, close, rerun: box.rerun };
}

// A language switch has to reach the results too: they are titles and section names read
// through t(), so a list left on screen would still be in the old language.
export function rerenderSearch() {
  colBox?.rerun();
  pal?.rerun();
}
