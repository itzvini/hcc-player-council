// Feature modules load on their own, and one that fails takes only itself down.
// These were static imports, which made every feature a single point of failure for
// the whole site: one 404 or 502 on any of the nineteen files threw away the entire
// module graph, so nothing below ever ran — no tabs, no routing, no scroll reveals.
// A visitor saw a page whose nav did nothing and whose sections stayed blank. Now
// the shell boots no matter which features do.
//
// lazy() hands back deferred stand-ins: calling one queues the real function behind
// its module's fetch, so every call site below reads exactly as it did with imports.
function lazy(path) {
  const loading = import(path).catch(error => {
    console.error(`[app] ${path} did not load — its features stay off.`, error);
    return null;
  });
  return new Proxy({}, {
    get: (_target, name) => (...args) => loading.then(mod => {
      if (!mod) return undefined;
      if (typeof mod[name] !== 'function') {
        console.error(`[app] ${path} exports no "${String(name)}".`);
        return undefined;
      }
      return mod[name](...args);
    }),
  });
}

// i18n is the one dependency the shell calls synchronously (t(), when it labels the
// compact mobile nav), so it keeps a live binding instead. Until it lands — or if it
// never does — t() echoes the key back, which selectTab() already reads as "keep the
// label that's in the markup".
let i18n = null;
const i18nReady = import('./i18n.js')
  .then(mod => (i18n = mod))
  .catch(error => {
    console.error('[app] i18n.js did not load — the page keeps its built-in English.', error);
    return null;
  });
const t = key => (i18n ? i18n.t(key) : key);
const setLanguage = lang => i18nReady.then(() => i18n && i18n.setLanguage(lang));
const initI18n = () => i18nReady.then(() => (i18n ? i18n.initI18n() : null));

const { loadHoldersChart, rerenderHolders } = lazy('./holders.js');
const { loadMarketChart, rerenderMarket } = lazy('./market.js');
const { loadChangelog, rerenderChangelog } = lazy('./changelog.js');
const { loadApply, rerenderApply } = lazy('./apply.js');
const { loadElection, rerenderElection } = lazy('./election.js');
const { loadBallot, rerenderBallot } = lazy('./ballot.js');
const { loadVote, rerenderVote } = lazy('./vote.js');
const { loadMarketplace, rerenderMarketplace, openProfileView, closeProfileView, closeTradeModal,
  openFundsView, exitFundsView, openTradeTab, exitTradeSubView,
  restoreTradeTitle } = lazy('./marketplace.js');
const { loadPolls, rerenderPolls } = lazy('./polls.js');
const { loadAnnouncements, rerenderAnnouncements, openAnnouncement } = lazy('./announcements.js');
const { loadGen2, rerenderGen2 } = lazy('./gen2.js');
const { initGuideDemos, rerenderGuideDemos } = lazy('./guide-demos.js');
const { loadCollections, rerenderCollections } = lazy('./collections.js');
const { loadTraits, rerenderTraits } = lazy('./traits.js');
const { openCodex, closeCodex, rerenderCodex, renderGlossary } = lazy('./codex.js');
// Site search. Both front doors are here: the archive's own box on the Collections page,
// and the palette behind the nav magnifier, "/" and Ctrl/Cmd-K. Loaded at boot rather
// than lazily, because it has to answer a keystroke on a page nobody has clicked into —
// it is a small module, and it fetches nothing until someone types.
const { initSearchPalette, initCollectionsSearch, rerenderSearch } = lazy('./search.js');
// Glossary links in prose. i18n.js decorates after every translation pass, which covers a
// cold load and a language switch; this covers the third way a panel becomes visible,
// which is someone clicking the nav. A panel nobody has looked at yet has no layout, and
// the decorator skips what it cannot measure.
const { linkGlossaryTerms } = lazy('./glossary-link.js');
const { initCouncilBoard, rerenderCouncilBoard } = lazy('./council.js');
const { initPerks, rerenderPerks } = lazy('./perks.js');
const { initSafety, rerenderSafety } = lazy('./safety.js');
const { initRegionPick, rerenderRegionPick } = lazy('./region-pick.js');
const { rerenderProfile } = lazy('./profile.js');

// Language switcher — re-render dynamic views after language change
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang).then(() => {
    rerenderChangelog();
    rerenderMarket();
    rerenderHolders();
    rerenderApply();
    rerenderElection();
    rerenderBallot();
    rerenderVote();
    rerenderMarketplace();
    rerenderPolls();
    rerenderAnnouncements();
    rerenderGen2();
    rerenderCollections();
    rerenderTraits();
    rerenderCodex();
    rerenderSearch();
    if (glossaryPainted) renderGlossary();
    rerenderGuideDemos();
    rerenderCouncilBoard();
    rerenderPerks();
    rerenderSafety();
    rerenderRegionPick();
    rerenderProfile();
  }));
  btn.addEventListener('click', () => setDrawer(false));
});

// Tabs
const tabButtons = document.querySelectorAll('[data-tab]');
const tabPanels  = document.querySelectorAll('.tab-panel');
const navMenu    = document.getElementById('nav-menu');
const navToggle  = document.getElementById('nav-toggle');
const navCurrent = document.getElementById('nav-current');
const navGroups  = document.querySelectorAll('.nav-group');
let holdersLoaded   = false;
let marketLoaded    = false;
let changelogLoaded = false;
let councilLoaded   = false;
let pollsLoaded     = false;
let announcementsLoaded = false;
let tradeLoaded     = false;
let roadmapLoaded   = false;
let collectionsLoaded = false;

// The sheet hangs off the bottom of the tab bar, and that bar is sticky, not fixed. Open
// the menu while the page still sits above the bar's resting place and the sheet drops
// past the bottom of the screen — on an iPhone SE that left 21 of the 22 rows, the whole
// language row among them, out of reach. Pinning the bar first gives the sheet a full
// screen to open into; a bar already up there stays put.
//   jump, never glide: a sheet still travelling is a moving target. Tapping 120ms into a
//     smooth scroll opened Roadmap instead of switching language, because the row that
//     had slid under the finger by click time won — the very bug this menu was just
//     fixed for. Overriding scroll-behavior beats `behavior: 'instant'`, which throws on
//     iOS 15.0 to 15.3.
//   ceil: a fractional scroll lands a pixel short in Safari, and a bar one pixel shy of
//     the top never trips the sentinel that frosts it.
//   queried, not the pageTabs const below: that one is declared further down the file.
function pinTabBar() {
  const top = Math.ceil(document.querySelector('.page-tabs')?.getBoundingClientRect().top ?? 0);
  if (top <= 0) return;
  const root = document.documentElement;
  root.style.scrollBehavior = 'auto';
  window.scrollBy(0, top);
  root.style.scrollBehavior = '';
}

// Mobile menu open/close (the whole menu sheet drops from under the bar).
// `body.nav-open` drives two things the sheet can't do alone: the scrim that dims the
// page behind it, and a scroll lock so a swipe on the sheet doesn't scroll the page
// underneath it. Both are scoped to the mobile layout in CSS.
function setDrawer(open) {
  if (open) pinTabBar();
  navMenu.classList.toggle('is-open', open);
  document.body.classList.toggle('nav-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  if (!open) closeGroups();
}
navToggle.addEventListener('click', () => setDrawer(!navMenu.classList.contains('is-open')));

// Grouped drop-downs (Council, Market, Guides, More, Language). Desktop reveals them
// on hover/focus via CSS; a click/tap pins one open (and drives the mobile accordion).
// Function declaration so selectTab() below can call it before this runs.
function closeGroups(except) {
  navGroups.forEach(g => {
    if (g === except) return;
    g.classList.remove('is-open');
    g.querySelector('.nav-trigger')?.setAttribute('aria-expanded', 'false');
  });
}
navGroups.forEach(group => {
  const trigger = group.querySelector('.nav-trigger');
  trigger?.addEventListener('click', () => {
    const open = !group.classList.contains('is-open');
    closeGroups(group);
    group.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', String(open));
  });
  // Close once keyboard focus leaves the group entirely (Tab past the last item)
  group.addEventListener('focusout', e => {
    if (!group.contains(e.relatedTarget)) {
      group.classList.remove('is-open');
      trigger?.setAttribute('aria-expanded', 'false');
    }
  });
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') { setDrawer(false); closeGroups(); } });
document.addEventListener('click', e => {
  if (e.target.closest('.nav-bar')) return;   // clicks inside the bar are handled above
  if (navMenu.classList.contains('is-open')) setDrawer(false);
  closeGroups();
});

// Frost the tab bar only while it's actually pinned: a 1px sentinel sits right above
// it; when the sentinel scrolls out of view the bar is stuck and gains its backdrop
// (.is-stuck in CSS). At rest the bar is transparent — no floating strip mid-page.
const pageTabs = document.querySelector('.page-tabs');
if (pageTabs && 'IntersectionObserver' in window) {
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'position:relative;height:1px;margin-top:-1px;visibility:hidden';
  pageTabs.parentNode.insertBefore(sentinel, pageTabs);
  new IntersectionObserver(entries => {
    pageTabs.classList.toggle('is-stuck', !entries[0].isIntersecting);
  }).observe(sentinel);
}

function selectTab(name, updateUrl = true) {
  // Which page is open, published to CSS. The hero masthead above the nav is site
  // chrome, not part of any page: on a phone it ate the whole first screen of every
  // tab, so you landed on the Marketplace looking at a slime parade with the real
  // content below the fold. CSS keeps the hero on The Club and drops it everywhere
  // else at mobile widths, where the app bar already names the section.
  document.body.dataset.tab = name;
  tabButtons.forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
    // Mirror the active section into the compact mobile bar (keeps i18n in sync).
    // The logo carries data-nav-label so "The Club" shows there, not its brand word.
    if (active && navCurrent) {
      const key = btn.dataset.navLabel || btn.dataset.i18n;
      const label = key ? t(key) : '';
      navCurrent.textContent = (label && label !== key) ? label : btn.textContent.trim();
      if (key) navCurrent.dataset.i18n = key;
    }
  });
  // Light the parent group's trigger when one of its pages is the open one
  navGroups.forEach(g => {
    const owns = g.querySelector(`[data-tab="${name}"]`);
    g.querySelector('.nav-trigger')?.classList.toggle('is-current', !!owns);
  });
  setDrawer(false);
  // On a pointer device, drop any hover-held menu the cursor still rests on; the
  // block lifts the next time the pointer moves, so hovering keeps working.
  navGroups.forEach(g => g.classList.add('is-dismissed'));
  window.addEventListener('mousemove',
    () => navGroups.forEach(g => g.classList.remove('is-dismissed')), { once: true });
  tabPanels.forEach(panel => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (name === 'market'    && !marketLoaded)    { marketLoaded    = true; loadMarketChart(); }
  if (name === 'changelog' && !changelogLoaded) { changelogLoaded = true; loadChangelog(); }
  if (name === 'council'   && !councilLoaded)   { councilLoaded   = true; loadApply(); loadElection(); loadBallot(); loadVote(); }
  if (name === 'polls'     && !pollsLoaded)     { pollsLoaded     = true; loadPolls(); }
  if (name === 'announcements' && !announcementsLoaded) { announcementsLoaded = true; loadAnnouncements(); }
  if (name === 'trade'     && !tradeLoaded)     { tradeLoaded     = true; loadMarketplace(); }
  // Re-selecting Trade (nav click, or a popstate back to /trade) while its profile
  // view is open should land on the marketplace, not a stale profile. route()'s
  // /profile/{slug} path re-opens the view right after, so deep links still work.
  // A nav click (updateUrl) means the marketplace itself, so any sub-view steps aside and
  // the pushed /trade below matches what's on screen. route() passes updateUrl false and
  // opens the view the URL actually names, which is why the reset is not unconditional:
  // doing it there would paint Buy for a frame on the way to every /trade/<view> address.
  else if (name === 'trade') { closeProfileView(); exitFundsView(); if (updateUrl) exitTradeSubView(); }
  if (name === 'roadmap'   && !roadmapLoaded)   { roadmapLoaded   = true; loadGen2(); }
  if (name === 'collections' && !collectionsLoaded) {
    collectionsLoaded = true;
    loadCollections();
    initCollectionsSearch(gotoSearchResult);   // one matcher over pages and the archive
  }
  // A nav click on Collections means the archive, not whatever codex page was last open.
  // route() re-opens the page straight after when the URL asks for one.
  if (name === 'collections') closeCodex();
  // Marketplace views name the browser tab after themselves (Sell, Sales history, Cash out).
  // Leaving for another part of the site has to hand that name back, or a member who wandered
  // off from Sell is still looking at a tab labelled Sell.
  if (name !== 'trade' && tradeLoaded) restoreTradeTitle();
  if (updateUrl && location.pathname !== urlFor(name)) history.pushState(null, '', urlFor(name));
  const panel = document.getElementById(`panel-${name}`);
  if (panel) linkGlossaryTerms(panel);
}

tabButtons.forEach(btn => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));

// Holders now lives as the "Holders" sub-tab of the Data (market) page. Load its
// charts the first time that sub-tab is shown — the canvases must be visible to size.
function ensureHoldersLoaded() {
  if (!holdersLoaded) { holdersLoaded = true; loadHoldersChart(); }
}
document.querySelector('#panel-market [data-subtab="holders"]')?.addEventListener('click', ensureHoldersLoaded);

// Collections › Creature Traits reads the whole trait catalogue, so it waits until someone
// actually opens that sub-tab rather than loading behind the release archive.
let traitsLoaded = false;
function ensureTraitsLoaded() {
  if (!traitsLoaded) { traitsLoaded = true; loadTraits(); }
}
document.querySelector('#panel-collections [data-subtab="traits"]')?.addEventListener('click', ensureTraitsLoaded);

// The glossary is 54 rows of copy already in the locale, so it costs no fetch. It still
// waits for its sub-tab, because it renders from translations that land after boot.
let glossaryPainted = false;
function ensureGlossary() {
  if (!glossaryPainted) { glossaryPainted = true; renderGlossary(); }
}
document.querySelector('#panel-collections [data-subtab="glossary"]')?.addEventListener('click', ensureGlossary);

// The brand mark opens The Club and returns to the top, like clicking a site logo
document.querySelector('.nav-logo')?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Landing hub cards and footer links — jump to a tab and return to the top.
// The footer uses real <a href="/roadmap"> so the links are crawlable and open in a
// new tab on ctrl/middle-click; a plain click switches tab in place instead.
document.querySelectorAll('[data-goto]').forEach(el => {
  el.addEventListener('click', e => {
    if (el.tagName === 'A') {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
    }
    selectTab(el.dataset.goto);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// Sub-tabs (Guides: Basics/Walkthroughs/…, Roadmap: Milestones/Gen 2) — scoped to
// the page panel the sub-nav lives in, so each page only drives its own subpanels.
function selectSubTab(scope, name) {
  scope.querySelectorAll('[data-subtab]').forEach(btn => {
    // data-subowns lists sub-panels that have no button of their own and belong to
    // this one: Roadmap's "Gen 2" owns the pets and creatures boards, so it stays lit
    // while either is open and they keep the URLs already published in Discord.
    const owns = (btn.dataset.subowns || '').split(/\s+/).filter(Boolean);
    const active = btn.dataset.subtab === name || owns.includes(name);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  scope.querySelectorAll('[data-subpanel]').forEach(p => { p.hidden = p.dataset.subpanel !== name; });
  // A sub-panel that was hidden has no layout, so the decorator skipped it. Now that it is
  // on screen it can be measured, and its first mentions are its own.
  linkGlossaryTerms(scope.querySelector(`[data-subpanel="${name}"]`) || scope);
}
function jumpSubTab(el, name) {
  const scope = el.closest('.tab-panel');
  if (!scope) return;
  selectSubTab(scope, name);
  history.replaceState(null, '', urlFor(scope.id.replace(/^panel-/, ''), name));
  scope.querySelector('.subnav-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.querySelectorAll('[data-subtab]').forEach(btn =>
  btn.addEventListener('click', () => jumpSubTab(btn, btn.dataset.subtab)));
// In-page jumps that switch sub-tab (e.g. the Gen 2 CTA at the end of Milestones)
document.querySelectorAll('[data-subgoto]').forEach(el =>
  el.addEventListener('click', e => {
    // On an <a>, a modified or middle click follows the real href into a new tab;
    // a plain click switches sub-tab in place. Same deal as [data-goto] above.
    if (el.tagName === 'A') {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
    }
    jumpSubTab(el, el.dataset.subgoto);
  }));

// Walkthrough steppers — show one guide at a time (chip tabs + prev/next) instead of
// one long scroll. Used by Guides › Walkthroughs, Guides › Marketplace, and the
// Contribute how-to. Steppers that live in a Guides sub-panel sync their active step
// into the URL (/guides/<subpanel>/<slug>) so individual steps are shareable and
// survive refresh; the Contribute stepper (no sub-panel) stays local-only.
const stepperRouters = {}; // { walkthroughs: fn, marketplace: fn } — driven by route()

function initStepper(nav) {
  const scope    = nav.closest('section');
  const subpanel = nav.closest('[data-subpanel]');
  const tabs     = [...nav.querySelectorAll('[data-wt]')];
  const panels   = [...scope.querySelectorAll('[data-wt-panel]')];
  const total    = panels.length;
  if (!total) return;
  const prevBtn  = scope.querySelector('[data-wt-prev]');
  const nextBtn  = scope.querySelector('[data-wt-next]');
  const countEls = [...scope.querySelectorAll('[data-wt-count]')];  // rail + footer can both show it
  const syncKey  = subpanel ? subpanel.dataset.subpanel : null; // null → no URL sync
  let current    = 1;

  const slugFor = n => tabs.find(t => Number(t.dataset.wt) === n)?.dataset.wtSlug || String(n);

  function show(n, { scroll = false, focusTab = false, updateUrl = false } = {}) {
    n = Math.min(total, Math.max(1, n));
    // Stop any video in the panel we're leaving so its audio doesn't linger.
    if (n !== current) {
      const leaving = panels.find(p => Number(p.dataset.wtPanel) === current);
      const frame = leaving && leaving.querySelector('iframe');
      if (frame) frame.src = frame.src; // eslint-disable-line no-self-assign
    }
    current = n;
    tabs.forEach(t => {
      const wt = Number(t.dataset.wt);
      const active = wt === n;
      t.classList.toggle('is-active', active);
      t.classList.toggle('is-done', wt < n);   // fills the spine's progress line
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    });
    panels.forEach(p => { p.hidden = Number(p.dataset.wtPanel) !== n; });
    if (prevBtn) prevBtn.disabled = n === 1;
    if (nextBtn) nextBtn.disabled = n === total;
    countEls.forEach(el => { el.textContent = `${n} / ${total}`; });
    if (syncKey && updateUrl) history.replaceState(null, '', `/guides/${syncKey}/${slugFor(n)}`);
    // Re-anchor the whole cockpit (rail + stage) when present, so advancing a step
    // keeps the brand hero in view; other steppers just scroll their nav as before.
    if (scroll)   (nav.closest('.gm-cockpit') || nav).scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusTab) tabs.find(t => Number(t.dataset.wt) === n)?.focus();
    // Glossary links, now that this panel has a box. The decorator skips anything with no
    // client rects, so a step that was hidden when the tab opened was never decorated —
    // which was every step but the first.
    linkGlossaryTerms(panels.find(p => Number(p.dataset.wtPanel) === n) || scope);
  }

  tabs.forEach(t => t.addEventListener('click', () => show(Number(t.dataset.wt), { scroll: true, updateUrl: true })));
  prevBtn?.addEventListener('click', () => show(current - 1, { scroll: true, updateUrl: true }));
  nextBtn?.addEventListener('click', () => show(current + 1, { scroll: true, updateUrl: true }));
  // Per-card footer nav — only the visible panel's buttons are clickable, so stepping
  // from `current` always lands on the neighbouring card. (The last card's forward
  // button uses data-goto instead, handled by the tab-jump wiring.)
  scope.querySelectorAll('[data-wt-cta]').forEach(btn =>
    btn.addEventListener('click', () => show(current + 1, { scroll: true, updateUrl: true })));
  scope.querySelectorAll('[data-wt-cta-prev]').forEach(btn =>
    btn.addEventListener('click', () => show(current - 1, { scroll: true, updateUrl: true })));
  nav.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    show(current + (e.key === 'ArrowRight' ? 1 : -1), { focusTab: true, updateUrl: true });
  });

  if (syncKey) {
    stepperRouters[syncKey] = slug => {
      const match = tabs.find(t => t.dataset.wtSlug === slug || String(t.dataset.wt) === slug);
      show(match ? Number(match.dataset.wt) : 1);
    };
  }
  show(1);
}

document.querySelectorAll('.wt-nav').forEach(initStepper);

// Glossary links for prose that lives inside a collapsed <details> (the guide's option
// accordions, the region notes): the decorator skips anything with no client rects, so
// those bodies are invisible to it until they open. 'toggle' doesn't bubble — capture it.
document.addEventListener('toggle', e => {
  if (e.target instanceof HTMLDetailsElement && e.target.open) linkGlossaryTerms(e.target);
}, true);

// Chromium keeps :focus-visible on a <summary> after a plain mouse click, so the focus
// ring lingers on a card someone just closed and reads as a broken border. Tag
// pointer-driven focus; the CSS shows the ring only when the tag is absent (keyboard).
document.addEventListener('pointerdown', e => {
  const sum = e.target instanceof Element && e.target.closest('summary');
  if (sum) sum.classList.add('is-pointer');
}, true);
document.addEventListener('focusout', e => {
  if (e.target instanceof Element && e.target.matches('summary')) e.target.classList.remove('is-pointer');
}, true);

// In-card collection toggle (the marketplace walkthrough's Creatures ⇄ LAND switch).
// Scoped to its own card so it never clashes with the steppers or the live Trade panel.
document.querySelectorAll('[data-mkt-toggle]').forEach(group => {
  const scope  = group.closest('.wt-panel') || group.parentElement;
  const btns   = [...group.querySelectorAll('[data-mkt-btn]')];
  const blocks = [...scope.querySelectorAll('[data-mkt]')];
  function showMkt(key) {
    btns.forEach(b => {
      const on = b.dataset.mktBtn === key;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    blocks.forEach(bl => { bl.hidden = bl.dataset.mkt !== key; });
  }
  btns.forEach(b => b.addEventListener('click', () => showMkt(b.dataset.mktBtn)));
  showMkt('creatures');
});

// Interactive guide demos (Guides › Marketplace) — built now, animated only once
// visible; rerendered after initI18n() resolves and on language switch.
initGuideDemos();

// Council board — the roster is static markup; this fills in each seat's term dates
// and progress (refreshed once translations resolve and on each language switch).
initCouncilBoard();

// Perks tab — coin yield calculator (static markup, so it wires up immediately;
// number formatting and aria labels are refreshed once translations resolve).
initPerks();

// Scam Watch (Guides › Scam Watch) — spot-the-scam + persisted safety checklist.
// Static markup, so listeners attach now; count/progress strings and the tap-to-
// reveal tooltips are filled once translations resolve and on each language switch.
initSafety();

// "Where you live changes the answer" (Guides › Marketplace › Funding and Cash out): the
// country picker fills its selects and renders the saved pick now; country names and the
// answer are redrawn once translations resolve and on each language switch.
initRegionPick();

// Clean tab URLs — every tab (and sub-tab) is a real path the server also serves:
// /council, /polls, /roadmap/gen2, … Tab clicks push the path; legacy #tab links
// and in-page anchors (#terms, #council) still work and get normalized to paths.
// 'apply' is a legacy alias: the old Apply & Vote tab now lives at /council/vote,
// and route() rewrites it so bookmarks and old OAuth redirects keep working.
const ROUTE_TABS = ['club', 'announcements', 'council', 'apply', 'polls', 'roadmap', 'collections', 'guides', 'perks', 'holders', 'market', 'trade', 'profile', 'changelog', 'contribute', 'terms', 'privacy'];

// Codex entity pages hang off Collections: /collections/item/<slug> and friends. They
// are the reference layer's addresses, so anything that renders one of these links (a
// release page, a trait tile, a Creature card) gets in-page navigation for free.
const CODEX_KINDS = new Set(['release', 'item', 'trait', 'creature', 'term']);

// Every /trade/<x> the marketplace paints as a view of its own. Read by route() and by the
// in-page link handler; a link to anything else under /trade falls through to the browser,
// which is the right answer for a bad address.
const TRADE_VIEWS = new Set(['buy', 'sell', 'transfer', 'sales', 'history']);

function urlFor(name, sub) {
  return name === 'club' && !sub ? '/' : `/${name}${sub ? `/${sub}` : ''}`;
}

function route(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  let tab = ROUTE_TABS.includes(segs[0]) ? segs[0] : 'club';
  let sub = segs[1] && /^[a-z0-9-]+$/.test(segs[1]) ? segs[1] : null;
  if (tab === 'apply') {
    // Legacy path → the merged tab, keeping the query string (?auth= errors).
    tab = 'council';
    sub = 'vote';
    history.replaceState(null, '', '/council/vote' + location.search);
  }
  if (tab === 'holders') {
    // Holders was merged into the Data page as a sub-tab; keep old /holders links working.
    tab = 'market';
    sub = 'holders';
    history.replaceState(null, '', '/market/holders' + location.search);
  }
  // Holder profiles (/profile/{slug}) live inside the marketplace: open the Trade
  // panel with its profile view (no nav tab of their own). route() owns the URL here,
  // so openProfileView must not push another history entry.
  if (tab === 'profile') {
    selectTab('trade', false);
    openProfileView(sub, { updateUrl: false });
    return;
  }
  // The marketplace's two money views own real paths (/trade/add-funds, /trade/cash-out).
  // Routed before the generic sub-tab lookup below, which would read them as sub-tabs that
  // #panel-trade does not have and silently leave Browse on screen at a bogus URL.
  if (tab === 'trade' && (sub === 'add-funds' || sub === 'cash-out')) {
    selectTab('trade', false);
    openFundsView(sub, { updateUrl: false });
    return;
  }
  // Buy is the marketplace's front door, so /trade/buy and /trade are one page. People guess
  // the longer one, so it works — and then normalises, the way /apply and /holders do, rather
  // than leaving two addresses for the same view.
  if (tab === 'trade' && sub === 'buy') {
    sub = null;
    history.replaceState(null, '', '/trade' + location.search);
  }
  // Every marketplace view is an address: /trade/sell, /trade/sales, /trade/history and the
  // rest. Routed here rather than through the generic sub-tab lookup below, because they are
  // views inside one panel, not sub-panels the shell can find by attribute.
  if (tab === 'trade' && TRADE_VIEWS.has(sub)) {
    selectTab('trade', false);
    openTradeTab(sub, { updateUrl: false });
    return;
  }
  // Bare /trade is Buy — including on the way BACK from one of the views above, which is
  // the case that needs saying: without this, Back changed the address and left the old
  // view on screen underneath it.
  if (tab === 'trade' && !sub) {
    selectTab('trade', false);
    openTradeTab('buy', { updateUrl: false });
    return;
  }
  // Any other /trade/<x> is a stale bookmark or a typo — normalise it rather than leaving
  // the address bar claiming a page that isn't there (same treatment /apply and /holders get).
  if (tab === 'trade' && sub) {
    sub = null;
    history.replaceState(null, '', '/trade' + location.search);
  }
  // Announcements: every post has an address of its own, /announcements/<slug>-<id>. The
  // id is the last long run of digits so a slug carrying its own numbers ("gen-2") can't
  // be read as one. Called on the bare tab too, so going back to /announcements from a
  // post puts the feed back rather than leaving the reader on one card.
  if (tab === 'announcements') {
    selectTab('announcements', false);
    const m = /(?:^|-)(\d{15,25})$/.exec(segs[1] || '');
    openAnnouncement(m ? m[1] : null);
    return;
  }

  // Codex entity pages: /collections/<kind>/<…>. They take over the Collections panel,
  // so they're routed before the sub-tab lookup below, which would otherwise read
  // "release" or "item" as a sub-tab that doesn't exist.
  if (tab === 'collections' && CODEX_KINDS.has(segs[1])) {
    selectTab('collections', false);
    openCodex(segs[1], segs.slice(2).map(decodeURIComponent));
    return;
  }
  selectTab(tab, false);
  // Legacy guides subtab: Scam Watch was merged into Stay safe, so old /guides/scams links land there.
  if (tab === 'guides' && sub === 'scams') sub = 'safety';
  if (sub) {
    const scope = document.getElementById(`panel-${tab}`);
    if (scope && scope.querySelector(`[data-subtab="${sub}"], [data-subpanel="${sub}"]`)) selectSubTab(scope, sub);
  }
  if (tab === 'market' && sub === 'holders') ensureHoldersLoaded();
  if (tab === 'collections' && sub === 'traits') ensureTraitsLoaded();
  if (tab === 'collections' && sub === 'glossary') ensureGlossary();
  // Deep link to a specific step, e.g. /guides/walkthroughs/funding or
  // /guides/marketplace/trading
  if (tab === 'guides' && sub && segs[2] && stepperRouters[sub]) {
    stepperRouters[sub](segs[2]);
  }
}

// Back/forward navigation
window.addEventListener('popstate', () => route(location.pathname));

// Codex links are written into HTML by several modules, so they're caught here once
// rather than wired up per render. They stay real <a href> elements: crawlable, and a
// modified or middle click still opens a new tab.
// The marketplace's two money views own paths too, and the glossary and the Guides link
// straight at them. Without this they fall through to the browser: a full reload and a
// white flash on the way to a page the app could have painted in place.
const MARKET_SUBS = new Set([...TRADE_VIEWS, 'add-funds', 'cash-out']);
document.addEventListener('click', event => {
  const link = event.target.closest && event.target.closest(
    'a[href^="/collections/"], a[href^="/trade/"], a[href^="/announcements"]');
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  // Already handled: the search boxes cancel the click and route it themselves, because a
  // result can be any address on the site rather than one of the three prefixes above.
  // Without this a codex result found through search pushed two history entries.
  if (event.defaultPrevented) return;
  const segs = link.getAttribute('href').split('?')[0].split('/').filter(Boolean);
  if (segs[0] === 'announcements') {
    // Nothing to check: the tab handles its own addresses, including the feed itself.
  } else if (segs[0] === 'trade') {
    if (!MARKET_SUBS.has(segs[1])) return;
  } else {
    // Any Collections address, not just the entity kinds. The glossary breadcrumb on every
    // term page points at /collections/glossary, and while that fell through to the browser
    // it meant a full reload and a white flash on the trip readers make most.
    if (segs[0] !== 'collections') return;
    if (segs[1] && !CODEX_KINDS.has(segs[1]) && !document.querySelector(
      `#panel-collections [data-subtab="${segs[1]}"]`)) return;
  }
  event.preventDefault();
  // These links also sit inside overlays that would otherwise stay open on top of the
  // page they just sent you to: the archive's and the trait grid's quick-look dialogs,
  // and the marketplace's token modal, which is a plain div and closes on its own terms.
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  if (document.body.classList.contains('trade-modal-open')) closeTradeModal();
  history.pushState(null, '', link.getAttribute('href'));
  route(location.pathname);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// The header search, wired now so it answers "/" and Ctrl/Cmd-K on a cold page. Its
// results are addresses anywhere on the site, not only the three prefixes the handler
// above catches, so it navigates through route() itself rather than leaning on that. A
// modified or middle click never reaches here: the palette leaves those to the browser.
function gotoSearchResult(href) {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  if (document.body.classList.contains('trade-modal-open')) closeTradeModal();
  if (href !== location.pathname + location.search) history.pushState(null, '', href);
  route(href.split('?')[0]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
initSearchPalette(gotoSearchResult);

// Legacy hash links switch tabs; the URL is normalized to the path form. Routing
// through route() keeps the '#apply' → /council/vote alias working here too.
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (ROUTE_TABS.includes(name)) {
    history.replaceState(null, '', urlFor(name) + location.search);
    route(location.pathname);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// Initial route: a legacy #tab hash (e.g. an old OAuth redirect or shared link)
// wins and is rewritten to its path; otherwise the path decides the tab.
const legacyTab = ROUTE_TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : null;
if (legacyTab) {
  history.replaceState(null, '', urlFor(legacyTab) + location.search);
  route(urlFor(legacyTab));
} else {
  route(location.pathname);
}

// Re-render dynamic views once translations are loaded. A deep-link to #apply (e.g.
// the OAuth callback redirect) triggers loadApply() before initI18n() resolves, so
// without this the panel would show raw keys until the next language switch.
initI18n().then(() => {
  rerenderChangelog();
  rerenderApply();
  rerenderElection();
  rerenderBallot();
  rerenderVote();
  rerenderMarket();
  rerenderHolders();
  rerenderMarketplace();
  rerenderPolls();
  rerenderAnnouncements();
  rerenderGen2();
  rerenderCollections();
  rerenderTraits();
  rerenderCodex();
  if (glossaryPainted) renderGlossary();
  rerenderGuideDemos();
  rerenderCouncilBoard();
  rerenderPerks();
  rerenderSafety();
  rerenderRegionPick();
  rerenderProfile();
});

// Jump animation on hover / click / tap
document.querySelectorAll('.pet-wrap').forEach(pet => {
  function jumpPet() {
    pet.classList.remove('is-jumping');
    void pet.offsetWidth; // force reflow so re-triggering restarts the animation
    pet.classList.add('is-jumping');
  }
  pet.addEventListener('mouseenter', jumpPet);
  pet.addEventListener('click', jumpPet);
  pet.addEventListener('animationend', e => {
    if (e.animationName === 'pet-jump') pet.classList.remove('is-jumping');
  });
});

// Gen 2 roadmap — scroll-in reveals + count-up stats. Both no-op under reduced
// motion; the CSS only hides .g2-reveal when motion is welcome, so content stays
// visible even if the observer never fires.
const g2MotionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function g2CountUp(el) {
  const target = parseInt(el.dataset.countup, 10);
  if (!Number.isFinite(target)) return;
  const dur = 900;
  let t0 = null;
  function frame(ts) {
    if (t0 === null) t0 = ts;
    const p = Math.min((ts - t0) / dur, 1);
    // Grouped, in the reader's language: the home intro counts to 11,111, and a bare
    // "11111" reads as a serial number.
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)))
      .toLocaleString(document.documentElement.lang || 'en');
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const g2Reveals = document.querySelectorAll('.g2-reveal');
if (g2MotionOK && 'IntersectionObserver' in window && g2Reveals.length) {
  const g2io = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('is-in');
    entry.target.querySelectorAll('[data-countup]').forEach(g2CountUp);
    g2io.unobserve(entry.target);
  }), { threshold: 0.15 });
  // .is-watched calls off the CSS failsafe: this observer has the element, so it
  // doesn't need rescuing. Tag only what actually reaches observe(), so anything
  // this file never got to still gets shown by CSS alone.
  g2Reveals.forEach(el => { el.classList.add('is-watched'); g2io.observe(el); });
} else {
  g2Reveals.forEach(el => el.classList.add('is-in'));
}

// Fetch and inline pet SVGs so internal <g transform> paths render in document context
(async () => {
  const pets = document.querySelectorAll('.pet-wrap img[src]');
  await Promise.all([...pets].map(async img => {
    try {
      const src = img.getAttribute('src');
      const base = src.replace(/[^/]+$/, '');
      const res = await fetch(src);
      const text = await res.text();
      const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
      svg.querySelectorAll('image[href]').forEach(el => {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('/') && !href.startsWith('http')) {
          el.setAttribute('href', base + href);
        }
      });
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', img.getAttribute('alt') || '');
      svg.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none';
      img.replaceWith(svg);
    } catch {}
  }));
})();
