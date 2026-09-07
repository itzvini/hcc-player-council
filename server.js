const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Load .env into process.env if present, so the OpenSea key works no matter how the
// server is launched (node server.js, npm start, IDE). No-op in production, where
// Railway injects real env vars and there is no .env file.
try { process.loadEnvFile(); } catch { /* no .env — fine */ }

const db = require('./lib/db');
const auth = require('./lib/auth');
const { recoverPersonalSignAddress } = require('./lib/eth-verify');
const ethRpcLib = require('./lib/eth-rpc'); // ordered mainnet RPC failover (LAND side only)
const mktOrderbook = require('./lib/marketplace-orderbook');
const squidBridge = require('./lib/squid-bridge');
const layerswapBridge = require('./lib/layerswap-bridge');
const gasFaucet = require('./lib/gas-faucet');
const landMarket = require('./lib/land-market');
const landPets = require('./lib/land-pets');
const upstreamHealth = require('./lib/upstream-health'); // per-collection upstream state
const lastKnown = require('./lib/last-known');           // failure-path snapshots only
// Layerswap's accepted move range: one shared copy, refreshed at most every LS_LIMITS_TTL_MS.
let lsLimits = { data: null, at: 0, failedAt: 0 };
const LS_LIMITS_TTL_MS = 5 * 60 * 1000;
const LS_LIMITS_FAIL_MS = 60 * 1000;
const creatureFallback = require('./lib/creature-fallback'); // Blockscout read-only browse fallback
const slimeIndex = require('./lib/slime-index');
const imxArchive = require('./lib/imx-archive');        // pre-migration (StarkEx) Creature sales
const { computeEligibility, BRACKETS } = require('./lib/eligibility');
const { PROPOSITIONS, PROPOSITION_IDS } = require('./lib/propositions');
const { POLLS, pollStatus } = require('./lib/polls');
const derive = require('./lib/derive-positions');

// Treat common truthy spellings (1/true/yes/on, case- and whitespace-insensitive) as
// "on", so a minor env value doesn't silently leave a flag off. Used for APPLICATIONS_OPEN.
const envFlag = v => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

// Held so the warm-ups that read their own tables can wait for them to exist. On a database
// that has been through this before, init is a handful of no-op CREATE IF NOT EXISTS calls;
// on a fresh one it is the difference between the first market rebuild finding its history
// and finding nothing.
const dbReady = db.init()
  .then(() => db.recordEvent({ event: 'system.startup', detail: { applicationsOpen: envFlag(process.env.APPLICATIONS_OPEN), usingPostgres: db.usingPostgres } }))
  .catch(err => console.error('DB init failed:', err.message));

// Optional local dev-login helper for testing eligibility screens without a real
// wallet. The active file (lib/dev-login.js) is gitignored, so it is ABSENT from
// the deployed build — the auth bypass cannot exist in production regardless of env
// vars. See lib/dev-login.example.js for how to enable it locally.
let devLogin = null;
try { devLogin = require('./lib/dev-login.js'); } catch { /* not present — normal in production */ }
if (devLogin) console.warn('[dev] lib/dev-login.js loaded — /api/auth/dev-login active locally. Never commit or deploy this file.');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';

// --- Announcements feed (public Discord mirror) ---
// The Discord bot POSTs the announcements channel's messages to
// /api/announcements/ingest, authenticated with an HMAC-SHA256 of the raw request
// body under ANNOUNCEMENTS_INGEST_SECRET. No secret set → ingest is disabled (503),
// so a misconfigured deploy can never accept unauthenticated writes. The website
// holds NO credential to the bot's database; the bot is the only thing that reads
// Discord, and it only ever pushes this one channel — so the worst a leaked secret
// buys an attacker is the ability to append a fake announcement, never to read
// anything. Idempotency + the channel/thread guards below mean edits never double a
// card, deletes hide instantly, and thread replies are refused outright.
const ANNOUNCEMENTS_CHANNEL_ID  = String(process.env.ANNOUNCEMENTS_CHANNEL_ID || '1083852782722887691').trim();
const DISCORD_GUILD_ID          = String(process.env.DISCORD_GUILD_ID || '890228388311228456').trim();
const ANNOUNCEMENTS_INGEST_SECRET = process.env.ANNOUNCEMENTS_INGEST_SECRET || '';
// Long announcements are often split across several messages posted back-to-back. We
// merge consecutive messages from the SAME author whose gaps are within this window into
// one card (read-time only — the rows stay individual). The window is generous vs. how
// far apart distinct announcements land (hours/days) but tight enough not to merge them.
const ANNOUNCEMENTS_GROUP_WINDOW_MS = Math.max(0, Number(process.env.ANNOUNCEMENTS_GROUP_WINDOW_MIN || 5)) * 60 * 1000;

// --- Holder stats ---
const CREATURE_HOLDERS_URL    = 'https://explorer.immutable.com/api/v2/tokens/0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA/holders';
const LAND_HOLDERS_URL        = 'https://eth.blockscout.com/api/v2/tokens/0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11/holders';
const HOLDER_CACHE_TTL_MS     = 30 * 60 * 1000;
const DIST_THRESHOLDS         = [1, 2, 5, 10]; // bucket breakpoints

// Highrise ESTATE: minting an estate locks N LAND parcels INTO this contract and issues
// one ERC-721 back, so those parcels leave the owner's wallet — on-chain the estate
// contract is the LAND holder, not the user. Without crediting estates, every estate
// owner reads as holding 0 LAND. We credit each estate's parcel count back to its
// current owner below (see buildEstateAttribution).
//
// Ownership is read straight from the contract (totalSupply/tokenByIndex/ownerOf) rather
// than Blockscout's /holders or /instances: those are balance-derived and over-report
// for this contract (they keep burned/transferred-out estates), which would credit LAND
// to wallets that no longer hold an estate.
//
// KNOWN OVER-COUNT: the parcel LIST is not reliable, from either source. A live estate can
// end up holding fewer parcels than it was minted with — estate 11927738 was minted with
// 144 and the contract holds 57 of them today — and NEITHER the EstateMinted log NOR the
// contract's own estatesToParcels array shrinks to match, so both say 144. The only
// truthful count is LAND ownership itself, parcel by parcel. Today that means the credit
// below runs high by roughly 100 parcels across 3 wallets: it can make a wallet look like
// it holds more LAND than it does, never less, so it never wrongly locks anyone out of
// Council eligibility. The holders page publishes the exact figure instead, counted from
// the parcel sweep in landQuality().
const ESTATE_CONTRACT         = '0x8dcbcafacfdc935d084dc19983194509813da6bd';
const ESTATE_LOGS_URL         = `https://eth.blockscout.com/api/v2/addresses/${ESTATE_CONTRACT}/logs`;
// topic0 of EstateMinted(uint256,address,uint32[]) — filters the contract's log feed to
// just mints (≈2 pages) instead of its full Transfer/Approval/role history.
const ESTATE_MINTED_TOPIC     = '0x61e22a5856592b5587565bc3f94edb44458e1a8cf97705c0450802385188a753';
// ERC-721 read selectors used to enumerate live estates + their owners on-chain.
const SEL_TOTAL_SUPPLY        = '0x18160ddd'; // totalSupply()
const SEL_TOKEN_BY_INDEX      = '0x4f6ccce7'; // tokenByIndex(uint256)
const SEL_OWNER_OF            = '0x6352211e'; // ownerOf(uint256)
const ETH_RPC_URL             = process.env.ETH_RPC_URL || 'https://eth.blockscout.com/api/eth-rpc';
// Balance reads MUST reflect a fresh top-up. Blockscout's eth-rpc has been observed to lag
// recent balance changes (reporting a stale, lower balance), which wrongly blocks funded
// buyers — so wallet-balance lookups use a full node. Heavy estate/LAND eth_calls (cached,
// slow-changing) stay on ETH_RPC_URL to avoid hammering a public node.
const ETH_BALANCE_RPC         = process.env.ETH_BALANCE_RPC || 'https://ethereum-rpc.publicnode.com';
const ZK_RPC_URL              = process.env.ZK_RPC_URL || 'https://rpc.immutable.com'; // Immutable zkEVM (Creatures)
// The L2s a member can fund FROM (see lib/layerswap-bridge.js). Read-only balance lookups,
// so a public node is enough; the browser can't reach these itself because CSP pins
// connect-src to 'self'. Keys match FUND_SOURCES in the bridge lib.
const FUND_CHAIN_RPC = {
  base: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
  arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com',
  optimism: process.env.OPTIMISM_RPC_URL || 'https://optimism-rpc.publicnode.com',
};
// Transak card on-ramp credentials. As of Transak's June 2026 migration, query-param widget
// URLs are dead — the widget loads ONLY with a sessionId minted server-side from the API key
// + SECRET (see the on-ramp helpers near handleMarketplaceApi). The secret must never reach a
// browser, so both live in env. Absent → the card CTA falls back to Immutable's keyless hosted
// page (zkEVM) / is hidden (LAND). TRANSAK_ENV picks the host set: a staging key only works on
// the -stg hosts, a production key only on the prod hosts. TRANSAK_REFERRER_DOMAIN overrides the
// referrer Transak validates against your whitelisted domains (defaults to the request host).
const TRANSAK_API_KEY         = (process.env.TRANSAK_API_KEY || '').trim();
const TRANSAK_API_SECRET      = (process.env.TRANSAK_API_SECRET || '').trim();
const TRANSAK_ENV             = (process.env.TRANSAK_ENV || 'production').trim().toLowerCase();
const TRANSAK_REFERRER_DOMAIN = (process.env.TRANSAK_REFERRER_DOMAIN || '').trim();
// Read selectors for the authoritative per-wallet eligibility lookup (see getWalletHoldings).
const SEL_BALANCE_OF          = '0x70a08231'; // balanceOf(address)
// Immutable's canonical bridge. Deployed at the SAME address on both chains: the child
// bridge on zkEVM, the root bridge (which owns the flow-rate guard) on Ethereum.
const IMX_ROOT_BRIDGE         = '0xBa5E35E26Ae59c7aea6F029B68c6460De2d13eB6';
const SEL_WITHDRAWAL_QUEUE_ACTIVATED = '0xa6f72cb8'; // withdrawalQueueActivated() -> bool
const SEL_LARGE_TRANSFER_THRESHOLDS  = '0x84a3291a'; // largeTransferThresholds(address) -> uint256
// The bridge's stand-in address for native ETH. Not the usual 0xEeee…EeE placeholder: its
// NATIVE_ETH() returns plain 0xEEE, confirmed identical on both chains.
const IMX_NATIVE_ETH_SENTINEL = '0000000000000000000000000000000000000000000000000000000000000eee';
const SEL_OWNER_TOKENS        = '0xbba7723e'; // ownerTokens(address) -> uint256[]
const SEL_ESTATES_TO_PARCELS  = '0x3890889f'; // estatesToParcels(uint256,uint256) -> uint256
const ZERO_ADDRESS            = '0x0000000000000000000000000000000000000000';

const holderCache    = { data: null, fetchedAt: 0, inFlight: null };
const fetchProgress  = { phase: 'idle', creaturePages: 0, landPages: 0 };
// Raw per-address counts from the latest successful fetch, kept so the Council
// eligibility check can look up a single wallet without re-querying the chain.
const holderCounts   = { creature: new Map(), land: new Map(), fetchedAt: 0 };

// Blockscout is slow well before it is broken: a page of these endpoints normally takes six
// to nine seconds, and a sweep is sixty-odd of them in a row. On a fifteen-second budget with
// no second try, one ordinary slow page threw away the whole sweep — which is how a parcel
// count that had already cost seven minutes of paging turned into "LAND unavailable" for the
// next twelve hours. So: room to be slow, and two more goes before a page gives up. A 4xx we
// caused is not retried; a 429 or a 5xx or a timeout is.
const BLOCKSCOUT_TIMEOUT_MS = 30000;

async function blockscoutFetch(url, label) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1000 * attempt));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(BLOCKSCOUT_TIMEOUT_MS) });
      if (res.ok) return res.json();
      const err = new Error(`Blockscout API ${res.status} for ${label}`);
      err.retryable = res.status >= 500 || res.status === 429;
      if (!err.retryable) throw err;
      lastErr = err;
    } catch (err) {
      if (err.retryable === false) throw err;
      lastErr = err; // timeouts and dropped connections are worth another go
    }
  }
  throw lastErr;
}

// Fetch all pages from any Blockscout-style /holders endpoint.
// Returns Map<lowercaseAddress, nftCount>.
// onPage() is called after each page is received.
async function fetchHolderCounts(baseUrl, onPage) {
  const counts = new Map();
  let pageParams = null;

  do {
    const url = new URL(baseUrl);
    if (pageParams) {
      for (const [k, v] of Object.entries(pageParams)) url.searchParams.set(k, v);
    }
    const body = await blockscoutFetch(url.toString(), baseUrl);
    for (const item of (body.items ?? [])) {
      const addr = item.address?.hash;
      if (typeof addr === 'string') counts.set(addr.toLowerCase(), Number(item.value) || 1);
    }
    if (onPage) onPage();
    pageParams = body.next_page_params ?? null;
  } while (pageParams);

  return counts;
}

// Page through a Blockscout v2 list endpoint, invoking onBody(body) per page and
// following next_page_params until exhausted. `extraParams` are reapplied each page.
async function fetchBlockscoutPages(baseUrl, onBody, extraParams = {}) {
  let pageParams = null;
  do {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
    if (pageParams) for (const [k, v] of Object.entries(pageParams)) url.searchParams.set(k, v);
    const body = await blockscoutFetch(url.toString(), baseUrl);
    onBody(body);
    pageParams = body.next_page_params ?? null;
  } while (pageParams);
}

// Minimal eth_call against the given chain RPC. `data` is the ABI-encoded calldata;
// returns the raw hex result (throws on transport/RPC/revert so callers can degrade).
//
// Mainnet calls are routed through lib/eth-rpc.js, which tries several providers in order
// (Alchemy joins the list when ALCHEMY_API_KEY is set). zkEVM keeps the single-host path:
// Alchemy does not serve Immutable zkEVM at all, so there is nothing to fail over TO.
//
// A revert still throws with `err.rpcError = true` — callers that read a revert as data
// (estateLandOwnedBy) MUST check that flag rather than catching everything.
// Which failover list a URL belongs to. Anything that isn't one of the two mainnet hosts
// (i.e. zkEVM) keeps the direct single-host path.
const rpcRoleFor = rpcUrl => (rpcUrl === ETH_RPC_URL ? 'read' : rpcUrl === ETH_BALANCE_RPC ? 'fresh' : null);

// One JSON-RPC round trip: mainnet goes through the ordered failover, everything else
// straight to the given host.
async function rpcVia(rpcUrl, method, params) {
  const role = rpcRoleFor(rpcUrl);
  if (role) return ethRpcLib.ethRpc(method, params, { role, timeoutMs: 15000 });
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`), { rpcError: true });
  return body.result;
}

const ethCall = (rpcUrl, to, data) => rpcVia(rpcUrl, 'eth_call', [{ to, data }, 'latest']);

const padUint = n => BigInt(n).toString(16).padStart(64, '0'); // uint256 arg → 32-byte word

// Transaction receipt on the given chain RPC (null while pending). Powers the bridge
// tracker's "confirmed on Ethereum" stage before Squid has indexed the transfer.
async function ethGetTxReceipt(rpcUrl, hash) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`eth_getTransactionReceipt HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'eth_getTransactionReceipt error');
  return body.result; // null until mined
}

// Native-coin balance (wei hex) for an address on the given chain RPC. Powers the
// marketplace's "your ETH is just on the wrong network" helper (mainnet ETH lookup).
const ethGetBalance = (rpcUrl, address) => rpcVia(rpcUrl, 'eth_getBalance', [address, 'latest']);

// Mask a wallet for logs — never write a full holder address to the server log.
const maskWallet = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : '(addr)');

// Authoritative [{ estateId, owner }] for every live (non-burned) estate, read from the
// contract: totalSupply() → tokenByIndex(i) → ownerOf(id). See the ESTATE_CONTRACT note.
async function fetchLiveEstateOwners() {
  const total = parseInt(await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_TOTAL_SUPPLY), 16);
  if (!Number.isFinite(total) || total <= 0) return [];
  const idxs = Array.from({ length: total }, (_, i) => i);
  const estateIds = await Promise.all(idxs.map(async i =>
    BigInt(await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_TOKEN_BY_INDEX + padUint(i))).toString()));
  const owners = await Promise.all(estateIds.map(async id =>
    ('0x' + (await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_OWNER_OF + padUint(id))).slice(-40)).toLowerCase()));
  return estateIds.map((estateId, i) => ({ estateId, owner: owners[i] }));
}

// Everything the rest of the file needs to know about estates, worked out in one pass:
//
//   credits     Map<ownerAddress, lockedParcelCount> — the LAND each estate owner is due
//   parcelOwner Map<landTokenId, ownerAddress> — who is really behind an estate-held parcel
//   estates     { live } — how many estates exist right now
//
// Two callers on very different clocks want this (the 30-minute holder snapshot and the
// 12-hour rarity sweep), and it costs a full log crawl plus 2×N contract reads, so it is
// cached and shared rather than computed twice. See the ESTATE_CONTRACT note above.
// Parcel ids come from decoded EstateMinted logs; ownership comes from the contract.
async function buildEstateAttribution() {
  // Parcel id list per estate id. The log feed is newest-first, so the first entry seen
  // for an id is its current mint (an id is only ever re-minted after a burn).
  const parcelsByEstate = new Map();
  await fetchBlockscoutPages(ESTATE_LOGS_URL, body => {
    for (const log of (body.items ?? [])) {
      const dec = log.decoded;
      if (!dec || !String(dec.method_call || '').startsWith('EstateMinted')) continue;
      const params = dec.parameters ?? [];
      const id = params.find(p => p.type === 'uint256')?.value;
      const parcels = params.find(p => String(p.type || '').endsWith('[]'))?.value;
      const estateId = id != null ? String(id) : null;
      if (estateId == null || parcelsByEstate.has(estateId)) continue;
      parcelsByEstate.set(estateId, Array.isArray(parcels) ? parcels.map(String) : []);
    }
  }, { topic: ESTATE_MINTED_TOPIC });

  const credits = new Map();
  const parcelOwner = new Map();
  let live = 0;
  for (const { estateId, owner } of await fetchLiveEstateOwners()) {
    if (owner === ZERO_ADDRESS) continue;
    const parcels = parcelsByEstate.get(estateId);
    if (parcels == null) { console.warn(`Estate ${estateId} live but has no EstateMinted parcel count`); continue; }
    live++;
    if (!parcels.length) continue;
    credits.set(owner, (credits.get(owner) || 0) + parcels.length);
    for (const tokenId of parcels) parcelOwner.set(tokenId, owner);
  }
  // Only `live` is published: it comes from the contract's own token enumeration and is
  // exact. A parcel COUNT from this data is not (see the KNOWN OVER-COUNT note above), so
  // the one on the holders page is counted from real LAND ownership in landQuality().
  return { credits, parcelOwner, estates: { live } };
}

const EMPTY_ESTATE_ATTRIBUTION = {
  credits: new Map(), parcelOwner: new Map(), estates: { live: 0 },
};
const estateCache = { data: null, at: 0, inFlight: null };
const ESTATE_CACHE_TTL_MS = 30 * 60 * 1000;

// Stale-while-revalidate, same contract as getHolderStats: a cached copy answers at once
// and a refresh runs behind it. A failed refresh keeps whatever we already had.
function getEstateAttribution() {
  const fresh = estateCache.data && Date.now() - estateCache.at < ESTATE_CACHE_TTL_MS;
  if (!fresh && !estateCache.inFlight) {
    estateCache.inFlight = buildEstateAttribution()
      .then(d => { estateCache.data = d; estateCache.at = Date.now(); return d; })
      .catch(err => {
        console.error('Estate attribution failed:', err.message);
        if (estateCache.data) return estateCache.data;
        throw err;
      })
      .finally(() => { estateCache.inFlight = null; });
  }
  if (estateCache.data) return Promise.resolve(estateCache.data);
  return estateCache.inFlight;
}

// Wallets grouped by how many they hold. `thresholds` are the bucket floors: [1,2,5,10]
// gives 1 / 2-4 / 5-9 / 10+. Anything below the lowest floor (i.e. zero) is left out.
function computeDistribution(countMap, thresholds = DIST_THRESHOLDS) {
  const sorted = [...thresholds].sort((a, b) => a - b);
  const buckets = sorted.map((t, i) => ({
    min: t,
    max: i < sorted.length - 1 ? sorted[i + 1] - 1 : Infinity,
    count: 0,
  }));
  for (const n of countMap.values()) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (n >= buckets[i].min) { buckets[i].count++; break; }
    }
  }
  return buckets.map(b => ({
    label: b.max === Infinity ? `${b.min}+` : b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`,
    count: b.count,
  }));
}

// Concentration of one collection, straight from its address→count map. Every share is
// measured against the supply those wallets add up to, so the numbers are consistent with
// the holder counts on the same page rather than a separate totalSupply() read.
function computeConcentration(countMap) {
  const held = [...countMap.values()].filter(n => n > 0).sort((a, b) => b - a);
  if (!held.length) return null;
  const supply = held.reduce((a, b) => a + b, 0);
  const shareOf = n => round4(n / supply);
  const topShare = n => shareOf(held.slice(0, n).reduce((a, b) => a + b, 0));
  const mid = held.length >> 1;
  return {
    supply,
    wallets: held.length,
    largest: held[0],
    largestShare: shareOf(held[0]),
    top10Share: topShare(Math.min(10, held.length)),
    // Top 1% of wallets, rounded up so a small collection still has at least one.
    topPercentWallets: Math.max(1, Math.ceil(held.length / 100)),
    topPercentShare: topShare(Math.max(1, Math.ceil(held.length / 100))),
    median: held.length % 2 ? held[mid] : (held[mid - 1] + held[mid]) / 2,
    average: round4(supply / held.length),
    singles: held.filter(n => n === 1).length,
  };
}

async function computeHolderStats() {
  fetchProgress.phase = 'fetching';
  fetchProgress.creaturePages = 0;
  fetchProgress.landPages = 0;

  const [creatureCounts, landCounts, estate] = await Promise.all([
    fetchHolderCounts(CREATURE_HOLDERS_URL, () => fetchProgress.creaturePages++),
    fetchHolderCounts(LAND_HOLDERS_URL,     () => fetchProgress.landPages++),
    // Non-fatal: a failed estate lookup just leaves estate-locked LAND uncredited
    // (and the phantom contract holding removed below), rather than failing the snapshot.
    getEstateAttribution().catch(() => EMPTY_ESTATE_ATTRIBUTION),
  ]);

  fetchProgress.phase = 'computing';

  // LANDs locked inside an estate are held on-chain by the estate contract, not their
  // owner. Drop that phantom contract holding, then credit each estate's parcels back to
  // its real owner — so estate holders count as LAND holders for eligibility and stats.
  landCounts.delete(ESTATE_CONTRACT);
  for (const [owner, parcels] of estate.credits) {
    landCounts.set(owner, (landCounts.get(owner) || 0) + parcels);
  }

  // Combined: total HCC assets per wallet (creature + land)
  const combinedCounts = new Map(creatureCounts);
  for (const [addr, count] of landCounts) {
    combinedCounts.set(addr, (combinedCounts.get(addr) || 0) + count);
  }

  let both = 0;
  for (const addr of creatureCounts.keys()) {
    if (landCounts.has(addr)) both++;
  }

  // Retain the raw maps for single-wallet eligibility lookups.
  holderCounts.creature = creatureCounts;
  holderCounts.land = landCounts;
  holderCounts.fetchedAt = Date.now();

  return {
    creaturesOnly: creatureCounts.size - both,
    landOnly: landCounts.size - both,
    both,
    totalUniqueHolders: combinedCounts.size,
    totalCreatureHolders: creatureCounts.size,
    totalLandHolders: landCounts.size,
    creatureDistribution: computeDistribution(creatureCounts),
    landDistribution: computeDistribution(landCounts),
    combinedDistribution: computeDistribution(combinedCounts),
    // How tightly held each collection is. Free to compute — it reads the same maps the
    // buckets above are built from — and it is the number holders actually argue about,
    // because on a one-wallet-one-vote council it is also the shape of the electorate.
    concentration: {
      creatures: computeConcentration(creatureCounts),
      land: computeConcentration(landCounts),
      combined: computeConcentration(combinedCounts),
    },
    stale: false,
    lastFetched: new Date().toISOString(),
  };
}

function getHolderStats() {
  const now = Date.now();
  const isFresh = holderCache.data && (now - holderCache.fetchedAt) < HOLDER_CACHE_TTL_MS;
  if (isFresh) return Promise.resolve(holderCache.data);

  // Kick off background refresh if not already running
  if (!holderCache.inFlight) {
    holderCache.inFlight = computeHolderStats()
      .then(data => {
        holderCache.data = data;
        holderCache.fetchedAt = Date.now();
        holderCache.inFlight = null;
        return data;
      })
      .catch(err => {
        holderCache.inFlight = null;
        console.error('Holder stats fetch failed:', err.message);
        throw err;
      });
  }

  // Stale data exists — return it immediately; refresh runs in background
  if (holderCache.data) return Promise.resolve({ ...holderCache.data, stale: true });

  // Cold start — must wait for first fetch
  return holderCache.inFlight;
}

// Per-wallet holdings cache — bounds RPC load when /api/me is hit repeatedly. Short TTL
// so a fresh buy/sell shows up quickly.
const walletHoldingsCache = new Map(); // lowercaseAddr -> { holdings, at }
const WALLET_HOLDINGS_TTL_MS = 60 * 1000;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/; // a real on-chain address (rejects dev-login placeholders)

// ERC-721 balanceOf for one address on the given chain RPC.
// An unparseable result is a broken response, not a zero balance. Returning 0 there told
// callers "this wallet holds nothing", which silently drops a holder's eligibility; throw
// so the failover in ethCall gets a chance at another provider.
async function erc721BalanceOf(rpcUrl, contract, address) {
  const raw = await ethCall(rpcUrl, contract, SEL_BALANCE_OF + padUint(BigInt(address)));
  const n = parseInt(raw, 16);
  if (!Number.isFinite(n)) throw new Error(`balanceOf: unparseable result for ${contract}`);
  return n;
}

// LAND parcels locked in estates owned by `address`. Estate parcels live in the estate
// contract, not the wallet, so they'd otherwise be invisible. ownerTokens(address) gives
// the owned estate ids; each estate's parcel count is read by probing estatesToParcels
// (id, i) until the array index reverts (out of bounds). Usually 0 — most wallets own no
// estate, so this is a single empty call.
async function estateLandOwnedBy(address) {
  const raw = await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_OWNER_TOKENS + padUint(BigInt(address)));
  if (!raw || raw.length <= 2) return 0;
  const hex = raw.slice(2);
  const word = i => hex.slice(i * 64, i * 64 + 64);   // [0]=offset, [1]=length, [2..]=ids
  const len = parseInt(word(1), 16) || 0;
  let parcels = 0;
  for (let k = 0; k < len; k++) {
    const estateId = BigInt('0x' + word(2 + k)).toString();
    for (let i = 0; i < 1000; i++) {
      let pr;
      try { pr = await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_ESTATES_TO_PARCELS + padUint(BigInt(estateId)) + padUint(i)); }
      catch (err) {
        // An out-of-bounds index REVERTS, and that revert is how we find the end of this
        // estate's parcel array — so a revert breaks the loop. A transport failure is not
        // an answer: breaking on it silently under-counts the holder's LAND (and their
        // eligibility) as if the estate were smaller. Let it propagate instead.
        if (err.rpcError) break;
        throw err;
      }
      if (!pr || pr === '0x') break;
      parcels++;
    }
  }
  return parcels;
}

// Every LAND parcel tokenId a wallet holds, straight from the contract — ownerTokens(address)
// returns the full uint256[] in ONE eth_call (the LAND contract shares the estate contract's
// custom enumerator, and is ERC721Enumerable besides; both verified on-chain). This is what
// feeds the Sell/Transfer pickers: authoritative and current the block after a buy, unlike
// OpenSea's owner index, which lags a mined buy by minutes. Estate-locked parcels are owned
// by the estate contract on-chain, so they're naturally absent — right for trading surfaces.
// Highrise LAND token ids pack the parcel coordinates as (x << 16) | y — verified across
// the whole live collection (x,y are the grid coords, both well under 16 bits). Decoding
// them means every owned parcel gets coords straight from its id, so its Slime pet renders
// even when the background slime sweep hasn't catalogued that parcel (the join miss that
// otherwise left wallet/profile LAND tiles on the plain map placeholder).
function coordsFromLandTokenId(tokenId) {
  let tid;
  try { tid = BigInt(tokenId); } catch { return null; }
  if (tid <= 0n || tid >= (1n << 32n)) return null; // not a coord-packed id — don't guess
  const n = Number(tid);
  return { x: n >>> 16, y: n & 0xffff };
}

async function landOwnedOnChain(address) {
  const raw = await ethCall(ETH_RPC_URL, LAND_CONTRACT, SEL_OWNER_TOKENS + padUint(BigInt(address)));
  if (!raw || raw.length < 2 + 128) return [];
  const hex = raw.slice(2);
  const word = i => hex.slice(i * 64, i * 64 + 64);   // [0]=offset, [1]=length, [2..]=ids
  const len = parseInt(word(1), 16) || 0;
  return Array.from({ length: len }, (_, k) => {
    const tokenId = BigInt('0x' + word(2 + k)).toString();
    // Coords come from the id itself; the slime-index join downstream still refines with
    // the slime's traits/rank when the parcel is catalogued.
    const coords = coordsFromLandTokenId(tokenId);
    const name = coords ? `Highrise LAND (${coords.x}, ${coords.y})` : `Highrise LAND #${tokenId}`;
    return { tokenId, name, image: null, coords };
  });
}

// A single wallet's HCC holdings (Creature + LAND, including estate-locked LAND), read
// AUTHORITATIVELY from the contracts via balanceOf / ownerTokens — NOT the bulk /holders
// snapshot, which can omit a legitimate holder (Blockscout indexing gaps) and wrongly
// report 0. Short-cached per wallet to bound RPC; on a chain-read failure it falls back to
// the snapshot, so a transient RPC outage degrades gracefully instead of erroring out.
async function getWalletHoldings(address) {
  const addr = (address || '').toLowerCase();
  if (!addr) return { creatureCount: 0, landCount: 0, holdersAvailable: false, holdersFetchedAt: null };
  // Not a real on-chain address (e.g. a dev-login placeholder like 0xDEV…). Reading the
  // chain would throw on BigInt(addr); report "unavailable" so callers keep the last-known
  // eligibility instead of erroring — and so a malformed upstream wallet degrades cleanly.
  if (!HEX_ADDRESS.test(addr)) return { creatureCount: 0, landCount: 0, holdersAvailable: false, holdersFetchedAt: null };

  const cached = walletHoldingsCache.get(addr);
  if (cached && (Date.now() - cached.at) < WALLET_HOLDINGS_TTL_MS) return cached.holdings;

  try {
    const [creatureCount, standaloneLand, estateParcels] = await Promise.all([
      erc721BalanceOf(ZK_RPC_URL, CREATURE_CONTRACT, addr),
      erc721BalanceOf(ETH_RPC_URL, LAND_CONTRACT, addr),
      estateLandOwnedBy(addr),
    ]);
    const holdings = {
      creatureCount,
      landCount: standaloneLand + estateParcels,
      holdersAvailable: true,
      holdersFetchedAt: new Date().toISOString(),
    };
    walletHoldingsCache.set(addr, { holdings, at: Date.now() });
    return holdings;
  } catch (err) {
    console.error(`Per-wallet holdings lookup failed for ${maskWallet(addr)}, using holder snapshot:`, err.message);
    if (!holderCounts.fetchedAt) { try { await getHolderStats(); } catch { /* snapshot also unavailable */ } }
    return {
      creatureCount: holderCounts.creature.get(addr) || 0,
      landCount: holderCounts.land.get(addr) || 0,
      holdersAvailable: holderCounts.fetchedAt > 0,
      holdersFetchedAt: holderCounts.fetchedAt ? new Date(holderCounts.fetchedAt).toISOString() : null,
    };
  }
}

// Warm up cache in the background on startup
getHolderStats().catch(err => console.error('Holder stats prefetch failed:', err.message));

// --- Market / floor price stats ---
// Creatures: floor + real daily sale-price history from Immutable zkEVM (free, no key).
// LAND: floor + daily sale-price history from OpenSea when OPENSEA_API_KEY is set;
//       falls back to CoinGecko for the current floor only (keyless) if the key is absent.
// Both collections trade in ETH, so their daily floors plot on one shared timeline.
const IMX_ZKEVM_CHAIN   = 'imtbl-zkevm-mainnet';
const CREATURE_CONTRACT = '0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA';
const IMX_ETH_TOKEN     = '0x52a6c53869ce09a731cd772f245b97a4401d3348'; // ETH on Immutable zkEVM (18 decimals)
// Bridged USDC on Immutable zkEVM — a dollar-pegged listing currency alongside ETH. VERIFIED
// ON-CHAIN 2026-07-23 (symbol()=="USDC", decimals()==6 via rpc.immutable.com); do NOT swap this
// for a search-found address without re-checking symbol/decimals — a wrong token means listings
// no one can fill. USDC has 6 decimals (ETH has 18): all price math MUST be currency-aware.
const IMX_USDC_TOKEN    = '0x6de8acc0d406837030ce4dd28e7c08c5a96a30d2';
// Accepted listing currencies on zkEVM (Creatures). The security allowlists on sell/create +
// offer/create only ever permit tokens in THIS map — never an arbitrary address.
const ZK_CURRENCIES = {
  eth:  { key: 'eth',  address: IMX_ETH_TOKEN,  decimals: 18, symbol: 'ETH'  },
  usdc: { key: 'usdc', address: IMX_USDC_TOKEN, decimals: 6,  symbol: 'USDC' },
};
const ZK_CURRENCY_BY_ADDR = new Map(Object.values(ZK_CURRENCIES).map(c => [c.address.toLowerCase(), c]));
const zkCurrency = key => ZK_CURRENCIES[String(key || '').toLowerCase()] || null;
const zkCurrencyByAddr = addr => ZK_CURRENCY_BY_ADDR.get(String(addr || '').toLowerCase()) || null;
// Decimals-aware conversions. amount (human string/number) <-> smallest-unit wei string.
const CUR_POW = new Map([[18, 10n ** 18n], [6, 10n ** 6n]]);
function amountToUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try { return (BigInt(whole) * (CUR_POW.get(decimals) || 10n ** BigInt(decimals)) + BigInt(fracPadded || '0')).toString(); }
  catch { return null; }
}
function unitsToAmount(units, decimals) {
  try {
    const n = Number(BigInt(units)) / Number(CUR_POW.get(decimals) || 10n ** BigInt(decimals));
    return round4(n);
  } catch { return null; }
}
const IMX_L1_TOKEN      = '0xf57e7e7c23978c3caec3c3548e3d615c346e79ff'; // IMX (ERC-20) on Ethereum mainnet (18 decimals)
const LAND_CONTRACT     = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11'; // Highrise LAND on Ethereum
const LAND_OS_SLUG      = 'highrise-land';
const OPENSEA_API_KEY   = process.env.OPENSEA_API_KEY || '';
const LAND_ETH_SYMBOLS  = new Set(['ETH', 'WETH']); // 1:1 ETH-equivalent payment tokens
const MARKET_CACHE_TTL_MS = 30 * 60 * 1000;
const DAY_MS              = 24 * 60 * 60 * 1000;
// How many days of our own floor snapshots we read. Neither price line is bounded by it any
// more: Creatures run from the collection's first day in November 2021 (the live zkEVM feed on
// top of lib/imx-archive.js) and LAND from OpenSea's oldest sale in April 2022.
const HISTORY_DAYS        = 730;
// How far back each market rebuild re-reads LAND's sales. Everything older is held from the
// one deep sweep, so this only has to cover what can have changed since.
const LAND_RECENT_MS      = 45 * DAY_MS;
const MAX_MARKET_PAGES    = 30; // safety cap; current data is well within this

const marketCache = { data: null, fetchedAt: 0, inFlight: null };

const round4 = n => Math.round(n * 1e4) / 1e4;

// Fetch an Immutable endpoint with retries on transient 5xx / 429 / network errors —
// the orderbook occasionally returns 500s that succeed on a quick retry, and bursts
// (boot builds several indexes at once) can trip the rate limit. Other 4xx (a
// malformed request on our side) fails fast.
async function imxFetch(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, (lastErr?.rateLimited ? 1200 : 500) * attempt));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return res.json();
      const err = new Error(`Immutable API ${res.status} for ${url}`);
      err.rateLimited = res.status === 429;
      if (res.status < 500 && !err.rateLimited) throw err; // our fault — retrying won't help
      lastErr = err;
    } catch (err) {
      if (err.message?.startsWith('Immutable API 4') && !err.rateLimited) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// Page through Immutable orderbook/activities until the cursor runs out (or the page cap).
async function imxPaged(baseUrl, params, onItems, maxPages = MAX_MARKET_PAGES) {
  let cursor = null, pages = 0;
  do {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    onItems(body.result ?? []);
    cursor = body.page?.next_cursor ?? null;
    pages++;
  } while (cursor && pages < maxPages);
}

// All ETH-denominated Creature sales: [{ ts, price }] (price in ETH).
async function fetchCreatureSales() {
  const base = `https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/activities`;
  const sales = [];
  await imxPaged(base, { contract_address: CREATURE_CONTRACT, activity_type: 'sale', page_size: '100' }, items => {
    for (const a of items) {
      const p = a.details?.payment;
      // ETH + USDC sales both count toward volume/history. USDC's `amt` is dollars; its
      // ETH-equivalent is applied later (computeMarketStats) at each sale's own day rate.
      const cur = zkCurrencyByAddr(p?.token?.contract_address);
      if (!cur) continue;
      const amt = Number(p.price_including_fees) / 10 ** cur.decimals;
      const ts = Date.parse(a.updated_at);
      if (Number.isFinite(amt) && amt > 0 && Number.isFinite(ts)) {
        sales.push(cur.key === 'eth' ? { ts, price: amt, currency: 'eth' } : { ts, currency: 'usdc', amt });
      }
    }
  });
  return sales;
}

// Lowest active ETH listing = current Creature floor (in ETH). A single sorted
// request (cheapest ETH listing first) instead of paging every active listing —
// far lighter on the orderbook API, which keeps it well clear of the transient
// 500s that deep queries can trigger.
async function fetchCreatureFloorEth() {
  const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
  url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
  url.searchParams.set('buy_item_contract_address', IMX_ETH_TOKEN);
  url.searchParams.set('status', 'ACTIVE');
  url.searchParams.set('sort_by', 'buy_item_amount');
  url.searchParams.set('sort_direction', 'asc');
  url.searchParams.set('page_size', '1');
  const body = await imxFetch(url.toString());
  const buy = (body.result ?? [])[0]?.buy?.[0];
  const v = buy ? Number(buy.amount) / 1e18 : null;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Cheapest active USDC listing = the USDC-denominated Creature floor (in dollars). Converted to
// an ETH-equivalent in computeMarketStats and merged with the ETH floor so the headline floor
// reflects the whole mixed book, not just ETH listings.
async function fetchCreatureFloorUsdc() {
  const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
  url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
  url.searchParams.set('buy_item_contract_address', IMX_USDC_TOKEN);
  url.searchParams.set('status', 'ACTIVE');
  url.searchParams.set('sort_by', 'buy_item_amount');
  url.searchParams.set('sort_direction', 'asc');
  url.searchParams.set('page_size', '1');
  const body = await imxFetch(url.toString());
  const buy = (body.result ?? [])[0]?.buy?.[0];
  const v = buy ? Number(buy.amount) / 1e6 : null; // USDC = 6 decimals → dollars
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Shared CoinGecko fetch. Sends the Demo API key when one is set, which gives us a
// private per-key rate budget instead of sharing the free per-IP pool — the reason
// prod (behind Railway's shared egress IPs) hit 429s while local dev didn't. The
// key stays on api.coingecko.com; pro-api.coingecko.com is paid-plan only.
const COINGECKO_KEY = process.env.COINGECKO_API_KEY || '';
function cgFetch(url) {
  return fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(COINGECKO_KEY && { 'x-cg-demo-api-key': COINGECKO_KEY }),
    },
    signal: AbortSignal.timeout(20000),
  });
}

// Daily ETH→USD lookup. Returns { at(ts), current }; at(ts) answers with the rate that
// actually applied on that day, so a 2022 sale is valued in 2022 dollars.
//
// CoinGecko's free tier only gives us the last 365 days. The years before that come from the
// pre-migration archive, where every trade carries the rate that applied when it settled.
// Between the two lies a hole (the archive stops at the July 2025 migration, CoinGecko's
// window keeps sliding forward), and days in it take the rate of the nearest day we know.
async function fetchEthUsd() {
  const res = await cgFetch(
    'https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=365&interval=daily',
  );
  if (!res.ok) throw new Error(`CoinGecko ETH/USD ${res.status}`);
  const body = await res.json();
  const prices = body.prices ?? [];
  const byDay = new Map();
  for (const [ms, usd] of prices) byDay.set(Math.floor(ms / DAY_MS), usd);
  const current = prices.length ? prices[prices.length - 1][1] : null;
  // CoinGecko wins where both have a day, then our own stored rates, then the archive's —
  // which is only consulted on the one boot that sweeps it, before anything has been stored.
  const stored = await db.getStoredEthUsd().catch(err => {
    console.error('Stored ETH/USD read failed:', err.message);
    return new Map();
  });
  for (const source of [stored, imxArchive.archiveRates()]) {
    for (const [date, rate] of source) {
      const day = dayIndex(date);
      if (!byDay.has(day) && rate > 0) byDay.set(day, rate);
    }
  }
  // Sorted once so a lookup is a binary search for the nearest known day rather than a
  // scan outwards — the table is now years long and holed, and a scan that ran off the
  // end used to fall back to TODAY's rate, the one number a historical sale must never wear.
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const at = ts => {
    if (!days.length) return current;
    const day = Math.floor(ts / DAY_MS);
    let lo = 0, hi = days.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] < day) lo = mid + 1; else hi = mid;
    }
    const after = days[lo];
    const before = lo > 0 ? days[lo - 1] : after;
    const nearest = Math.abs(after - day) <= Math.abs(day - before) ? after : before;
    return byDay.get(nearest);
  };
  // The oldest day the table can speak for, so a caller can tell a full one from the
  // 365-day version built before the archive sweep landed.
  return { at, current, from: days.length ? days[0] : null };
}

// Extra display currencies (USD stays the canonical fiat; these are derived from
// it). Stored ETH/USD values are exact + historical; fiats are scaled by the
// latest USD→X rate, which preserves the chart shape and is exact for current values.
const FX_CURRENCIES = ['usd', 'eur', 'gbp', 'brl', 'rub', 'try', 'jpy', 'cad', 'aud'];

// ETH→USD plus USD-relative rates for every display currency, in ONE CoinGecko call.
// The single source of current FX for the whole server (market snapshot + every
// marketplace endpoint), so we hit CoinGecko once per cache window instead of once
// per caller. FX barely moves minute to minute; degrades to the last good value, or
// USD-only, on failure.
const mktFxCache = { data: null, at: 0 };
const MKT_FX_TTL_MS = 15 * 60 * 1000;
async function getMarketplaceFx() {
  if (mktFxCache.data && Date.now() - mktFxCache.at < MKT_FX_TTL_MS) return mktFxCache.data;
  try {
    const res = await cgFetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=${FX_CURRENCIES.join(',')}`,
    );
    if (!res.ok) throw new Error(`CoinGecko FX ${res.status}`);
    const eth = (await res.json()).ethereum || {};
    const ethUsd = eth.usd ?? null;
    const fxRates = { usd: 1 }; // USD-relative display rates (rate.usd === 1)
    if (ethUsd) for (const c of FX_CURRENCIES) if (c !== 'usd' && eth[c] != null) fxRates[c] = eth[c] / ethUsd;
    const data = { ethUsd, fxRates };
    mktFxCache.data = data; mktFxCache.at = Date.now();
    return data;
  } catch (err) {
    console.error('Marketplace FX failed:', err.message);
    return mktFxCache.data || { ethUsd: null, fxRates: { usd: 1 } };
  }
}

// Daily ETH→USD history, cached, so each past sale can show its value at the rate that
// actually applied on its day (not today's). fetchEthUsd() returns { at(ts), current };
// at(ts) clamps to the nearest known day. The single source of daily rates (market
// snapshot + sales feeds). Degrades to the last good copy on failure.
const ethUsdDailyCache = { data: null, at: 0, inFlight: null };
const ETH_USD_DAILY_TTL_MS = 30 * 60 * 1000;
async function getEthUsdDaily() {
  const fresh = ethUsdDailyCache.data && Date.now() - ethUsdDailyCache.at < ETH_USD_DAILY_TTL_MS;
  if (!fresh && !ethUsdDailyCache.inFlight) {
    ethUsdDailyCache.inFlight = fetchEthUsd()
      .then(d => { ethUsdDailyCache.data = d; ethUsdDailyCache.at = Date.now(); return d; })
      .catch(err => { console.error('ETH/USD daily fetch failed:', err.message); return ethUsdDailyCache.data; })
      .finally(() => { ethUsdDailyCache.inFlight = null; });
  }
  return ethUsdDailyCache.data || ethUsdDailyCache.inFlight;
}

// Bucket sales into daily aggregates: cheapest sale, dearest sale, ETH volume and trade
// count, from sales of { ts, eth }. No dollars here — the store keeps one rate per day and
// every USD figure on the chart is derived from it, so a day is valued once, not per sale.
function aggregateByDay(sales) {
  const byDay = new Map();
  for (const s of sales) {
    const day = Math.floor(s.ts / DAY_MS);
    const a = byDay.get(day);
    if (!a) { byDay.set(day, { lowEth: s.eth, highEth: s.eth, volEth: s.eth, sales: 1 }); continue; }
    a.lowEth = Math.min(a.lowEth, s.eth);
    a.highEth = Math.max(a.highEth, s.eth);
    a.volEth += s.eth;
    a.sales++;
  }
  return byDay;
}

// Persist today's lowest-listing floor for a collection. Never throws — a DB
// hiccup must not take down the market endpoint; the chart just won't gain a point.
async function recordFloorSnapshot(collection, day, ethFloor, usdFloor) {
  if (ethFloor == null && usdFloor == null) return; // nothing worth storing
  try {
    await db.recordFloorSnapshot({
      day, collection,
      ethFloor: ethFloor != null ? round4(ethFloor) : null,
      usdFloor: usdFloor != null ? Math.round(usdFloor) : null,
    });
  } catch (err) {
    console.error(`Floor snapshot (${collection}) failed:`, err.message);
  }
}

// 'YYYY-MM-DD' → the day index the series maps are keyed by (UTC days since the epoch),
// and back again.
const dayIndex = date => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const dayIso = day => new Date(day * DAY_MS).toISOString().slice(0, 10);
// Postgres hands NUMERIC back as a string; every stored number comes through here.
const num = v => (v == null || v === '' ? null : Number(v));
const round4or = v => (v == null ? null : round4(v));

// The chart's stored history: { creature: Map(day -> row), land: Map(day -> row) }. A read
// failure is not fatal — the rebuild simply starts from nothing and writes what it learns.
async function readMarketDaily() {
  const out = { creature: new Map(), land: new Map() };
  let rows = [];
  try { rows = await db.getMarketDaily(); }
  catch (err) { console.error('Market history read failed:', err.message); return out; }
  for (const r of rows) {
    const days = out[r.collection];
    if (!days) continue;
    days.set(dayIndex(r.date), {
      lowEth: num(r.low_eth), highEth: num(r.high_eth), volEth: num(r.vol_eth),
      sales: r.sales != null ? Number(r.sales) : null,
      floorEth: num(r.floor_eth), ethUsd: num(r.eth_usd),
    });
  }
  return out;
}

// Near enough to be the same number: NUMERIC round-trips through Postgres, and rewriting a
// row because the fourteenth decimal moved is not a change worth a write.
const sameNumber = (a, b) => a != null && Math.abs(a - b) <= Math.abs(b) * 1e-9;

/**
 * Fold what a source knows about one day into the store, and note the write it implies.
 *
 * A field left out says nothing about that field and leaves the stored value alone — a
 * source that only knows the floor never erases the day's sales. A field equal to what is
 * already stored writes nothing at all, which is what keeps an ordinary rebuild down to the
 * day or two that actually moved instead of the whole five years.
 *
 * Several sources speak about the same day — a pre-migration day has its sales from the
 * trade sweep and its floor from the daily roll-up — so what is noted here is the day, not
 * the change. The row is read back off the store at the end, once, whole.
 */
function mergeDay(state, collection, day, fields, source) {
  const days = state.store[collection];
  if (!days || !Number.isFinite(day)) return;
  const prev = days.get(day) || {};
  const next = { ...prev };
  let moved = false;
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || !Number.isFinite(value)) continue;
    if (!sameNumber(prev[key], value)) moved = true;
    next[key] = value;
  }
  if (!moved) return;
  next.source = source;
  days.set(day, next);
  state.dirty.add(`${collection}|${day}`);
}

// The days this rebuild moved, each as one whole row. One row per day is not a tidiness
// point: a batch that named the same day twice would be rejected outright.
function dirtyRows(state) {
  const rows = [];
  for (const key of state.dirty) {
    const [collection, day] = key.split('|');
    const d = state.store[collection]?.get(Number(day));
    if (d) rows.push({ date: dayIso(Number(day)), collection, ...d });
  }
  return rows;
}

// Read stored listing-floor snapshots into per-collection day-index maps of { eth, usd }.
async function getListingSnapshots() {
  const out = { creature: new Map(), land: new Map() };
  let rows;
  try { rows = await db.getFloorHistory(HISTORY_DAYS); }
  catch (err) { console.error('Floor history read failed:', err.message); return out; }
  for (const r of rows) {
    const m = out[r.collection];
    if (!m) continue;
    const eth = r.eth_floor != null ? Number(r.eth_floor) : null;
    const usd = r.usd_floor != null ? Math.round(Number(r.usd_floor)) : null;
    if (eth == null && usd == null) continue;
    m.set(dayIndex(r.date), { eth, usd });
  }
  return out;
}

// Where our own snapshots stop, the orderbook still remembers. Immutable keeps every
// Creature listing it has ever taken — filled, cancelled, expired — each stamped with when
// it was created and when it stopped standing, so the cheapest listing that stood on any
// past day can be rebuilt from them. That covers the months between the July 2025 migration
// and the day we started recording a floor of our own, which nothing else does: the StarkEx
// orderbook went off with the rollup and the zkEVM one only remembers back to August 2025.
//
// A day's value is the cheapest listing that stood at any point in it, so it answers "what
// was the least a Creature could be bought for that day". Our own snapshots sample the book
// at one moment instead, and where both have a day, the sample wins — it is a floor someone
// actually saw.
//
// The whole book is ~2,500 orders in ~15 pages and nothing about a closed order ever
// changes, so this is swept once per process. ETH only: USDC listings arrived long after our
// own snapshots did, and pricing them would need a rate for a day we may not have one for.
const zkFloorCache = { data: null, inFlight: null, failedAt: 0 };
const ZK_FLOOR_RETRY_MS = 30 * 60 * 1000;

async function sweepZkFloorHistory() {
  const now = Date.now();
  const today = Math.floor(now / DAY_MS);
  const byDay = new Map();
  const base = `https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`;
  for (const status of ['FILLED', 'CANCELLED', 'EXPIRED', 'ACTIVE']) {
    await imxPaged(base, {
      sell_item_contract_address: CREATURE_CONTRACT,
      buy_item_contract_address: IMX_ETH_TOKEN,
      status,
      page_size: '200',
      sort_by: 'created_at',
      sort_direction: 'asc',
    }, items => {
      for (const o of items) {
        const from = Date.parse(o.created_at);
        // A listing stops standing when it fills or is cancelled, and never outlives its own
        // expiry — whichever came first ends it. An active one still stands today.
        const ends = [Date.parse(o.end_at)];
        if (status === 'FILLED' || status === 'CANCELLED') ends.push(Date.parse(o.updated_at));
        const until = Math.min(now, ...ends.filter(Number.isFinite));
        const eth = Number(o.buy?.[0]?.amount) / 1e18;
        if (!Number.isFinite(from) || !Number.isFinite(until) || !(eth > 0)) continue;
        const last = Math.min(today, Math.floor(until / DAY_MS));
        for (let day = Math.floor(from / DAY_MS); day <= last; day++) {
          const cheapest = byDay.get(day);
          if (cheapest == null || eth < cheapest) byDay.set(day, eth);
        }
      }
    });
  }
  console.log(`zkEVM floor history: ${byDay.size} days rebuilt from the Creature orderbook`);
  return byDay;
}

/** Day index -> cheapest ETH listing that stood that day. Empty map if the sweep failed. */
function getZkFloorHistory() {
  if (zkFloorCache.data) return Promise.resolve(zkFloorCache.data);
  if (!zkFloorCache.inFlight && Date.now() - zkFloorCache.failedAt > ZK_FLOOR_RETRY_MS) {
    zkFloorCache.inFlight = sweepZkFloorHistory()
      .then(map => { zkFloorCache.data = map; return map; })
      .catch(err => {
        zkFloorCache.failedAt = Date.now();
        console.error('zkEVM floor history sweep failed:', err.message);
        return new Map();
      })
      .finally(() => { zkFloorCache.inFlight = null; });
  }
  return zkFloorCache.inFlight || Promise.resolve(new Map());
}

// One daily series for the chart, oldest first. Every dollar figure is derived from the
// rate stored against that same day, so a 2022 point stays in 2022 money for good — no
// upstream we can no longer query, and no rate table that only reaches back a year.
function buildCollectionSeries(days) {
  return [...days.keys()].sort((a, b) => a - b).map(day => {
    const d = days.get(day);
    const rate = d.ethUsd;
    const usd = eth => (eth != null && rate != null ? Math.round(eth * rate) : null);
    return {
      date: dayIso(day),
      highEth: round4or(d.highEth), highUsd: usd(d.highEth),
      lowEth:  round4or(d.lowEth),  lowUsd:  usd(d.lowEth),
      floorEth: round4or(d.floorEth), floorUsd: usd(d.floorEth),
      count:  d.sales ?? null,
      volEth: round4or(d.volEth), volUsd: usd(d.volEth),
    };
  });
}

// OpenSea rate-limits, and an 81-page sweep is exactly the shape of request that trips it.
// A 429 or a 5xx used to end the sweep and shorten the LAND line by years, so those are
// retried with a pause; a 4xx of our own making still fails at once.
async function osFetch(url, headers) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1500 * attempt));
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (res.ok) return res.json();
      const err = new Error(`OpenSea ${res.status} for ${url}`);
      if (res.status < 500 && res.status !== 429) throw err;
      lastErr = err;
    } catch (err) {
      if (err.message?.startsWith('OpenSea 4') && !err.message.startsWith('OpenSea 429')) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// Page OpenSea's sale events backwards until they run past `cutoff` (or the page cap).
// Returns the sales and the moment they actually reach back to, which is what lets the
// caller join them to the deep sweep without overlap. 50 an event page is OpenSea's max.
async function fetchLandSales(headers, cutoff, maxPages) {
  const sales = [];
  let cursor = null, pages = 0, reachedCutoff = false, oldest = Infinity;
  do {
    const url = new URL(`https://api.opensea.io/api/v2/events/collection/${LAND_OS_SLUG}`);
    url.searchParams.set('event_type', 'sale');
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('next', cursor);
    const body = await osFetch(url.toString(), headers);
    for (const e of (body.asset_events ?? [])) {
      const ts = Number(e.event_timestamp) * 1000; // OpenSea timestamps are epoch seconds
      if (Number.isFinite(ts)) oldest = Math.min(oldest, ts);
      const p = e.payment;
      // A LAND sale settles in ETH or in WETH, which is the same money; anything else
      // (a sale paid in some other token) has no ETH price and is left out.
      if (!p || !LAND_ETH_SYMBOLS.has(p.symbol)) continue;
      const eth = Number(p.quantity) / Math.pow(10, p.decimals ?? 18);
      if (!Number.isFinite(eth) || eth <= 0 || !Number.isFinite(ts)) continue;
      if (ts < cutoff) { reachedCutoff = true; continue; }
      sales.push({ ts, eth });
    }
    cursor = body.next ?? null;
    pages++;
  } while (cursor && !reachedCutoff && pages < maxPages);
  // Where the window really starts: the cutoff if we reached it, otherwise the oldest
  // event we saw. Reporting the cutoff either way would open a hole under the tail.
  return { sales, from: reachedCutoff ? cutoff : Math.min(oldest, cutoff) };
}

// LAND's whole sale history, swept once. OpenSea holds it all — 4,000-odd events back to
// April 2022 — but it takes 81 pages and half a minute to page through, which is not a
// thing to redo every half hour when only the last few days can have changed. So: one deep
// sweep, held for the life of the process, with each rebuild fetching just the window since
// and joining them. Same shape as the Creature archive, and the same failure behaviour —
// an empty result costs the tail of the LAND line and nothing else.
const LAND_ARCHIVE_MAX_PAGES = 200;
const landSalesArchive = { data: null, inFlight: null, failedAt: 0, sweptAt: Date.now() };

function getLandSalesArchive() {
  if (landSalesArchive.data) return Promise.resolve(landSalesArchive.data);
  if (!OPENSEA_API_KEY) return Promise.resolve([]);
  if (!landSalesArchive.inFlight && Date.now() - landSalesArchive.failedAt > MARKET_CACHE_TTL_MS) {
    const startedAt = Date.now();
    landSalesArchive.inFlight = fetchLandSales(
      { Accept: 'application/json', 'X-API-KEY': OPENSEA_API_KEY }, 0, LAND_ARCHIVE_MAX_PAGES,
    )
      .then(({ sales }) => {
        landSalesArchive.data = sales;
        // The recent window is told to reach back at least this far, so a process that
        // outlives its own history window still hands over without a gap.
        landSalesArchive.sweptAt = startedAt;
        console.log(`OpenSea LAND archive: ${sales.length} sales back to ${sales.length ? new Date(Math.min(...sales.map(s => s.ts))).toISOString().slice(0, 10) : '-'}`);
        return sales;
      })
      .catch(err => {
        landSalesArchive.failedAt = Date.now();
        console.error('OpenSea LAND archive sweep failed:', err.message);
        return [];
      })
      .finally(() => { landSalesArchive.inFlight = null; });
  }
  return landSalesArchive.inFlight || Promise.resolve([]);
}

// LAND via OpenSea: current floor + 30d volume + ETH-denominated sale history.
async function fetchLandFromOpenSea(cutoff, deep) {
  const headers = { Accept: 'application/json', 'X-API-KEY': OPENSEA_API_KEY };

  const statsBody = await osFetch(`https://api.opensea.io/api/v2/collections/${LAND_OS_SLUG}/stats`, headers);
  const total = statsBody.total ?? {};
  const intervals = {};
  for (const it of (statsBody.intervals ?? [])) intervals[it.interval] = it;

  // `deep` asks for the whole history, which is wanted exactly once — the day it goes into
  // our own store. After that this reads the recent window alone and the store holds the
  // rest. The join is by time, so there is nothing to de-duplicate: whatever came before the
  // window opens belongs to the older list.
  const older = deep ? await getLandSalesArchive().catch(() => []) : [];
  const from = older.length ? Math.min(cutoff, landSalesArchive.sweptAt) : cutoff;
  const recent = await fetchLandSales(headers, from, MAX_MARKET_PAGES);
  const sales = [...older.filter(s => s.ts < recent.from), ...recent.sales];

  return {
    currency: 'ETH',
    source: 'opensea',
    floor: total.floor_price ?? null,
    owners: total.num_owners ?? null,
    sales30d: intervals.thirty_day?.sales ?? null,
    volume30d: intervals.thirty_day?.volume != null ? round4(intervals.thirty_day.volume) : null,
    sales,
  };
}

// LAND fallback via CoinGecko: current floor + owners only, no history.
async function fetchLandFromCoinGecko() {
  const res = await cgFetch(`https://api.coingecko.com/api/v3/nfts/ethereum/contract/${LAND_CONTRACT}`);
  if (!res.ok) throw new Error(`CoinGecko NFT ${res.status}`);
  const b = await res.json();
  return {
    currency: (b.native_currency_symbol || 'eth').toUpperCase(),
    source: 'coingecko',
    floor: b.floor_price?.native_currency ?? null,
    owners: b.number_of_unique_addresses ?? null,
    floorUsd: b.floor_price?.usd ?? null,
    sales30d: null,
    volume30d: null,
    floorChange24h: b.floor_price_24h_percentage_change?.native_currency ?? null,
    sales: [], // CoinGecko free tier has no floor history
  };
}

async function fetchLandData(cutoff, deep) {
  if (OPENSEA_API_KEY) {
    try { return await fetchLandFromOpenSea(cutoff, deep); }
    catch (err) { console.error('OpenSea LAND failed, falling back to CoinGecko:', err.message); }
  }
  return fetchLandFromCoinGecko();
}

async function computeMarketStats() {
  const cutoff30d = Date.now() - 30 * DAY_MS;

  // Which closed histories have already been read into our own store. Each is a sweep of an
  // upstream that will never say anything new about those days — a rollup that has been shut
  // off, an orderbook's dead listings, a marketplace's own event log — so it is read once in
  // the life of the site and kept, not re-read on every restart. Delete a `market_sync` row
  // to make the next rebuild read that source again.
  const synced = await db.getMarketSync().catch(err => {
    console.error('Market sync state read failed:', err.message);
    return {};
  });
  const state = { store: await readMarketDaily(), dirty: new Set() };
  // A day that counted sales but priced none of them is the fingerprint of a bug, not of a
  // quiet market — every sale has a price. Rows like that can't be mended from the recent
  // window, so the sweep that wrote them is un-sealed and run once more. It is also the only
  // check that would have caught the field-name slip that put LAND in this state.
  const unpriced = collection => {
    const days = [...state.store[collection].values()].filter(d => d.sales > 0 && d.lowEth == null).length;
    if (days) console.warn(`Market history: ${days} ${collection} day(s) have sales but no price — re-reading that source`);
    return days > 0;
  };
  const needArchive = !synced['imx-archive'] || unpriced('creature');
  const needZkFloor = !synced['zk-orderbook'];
  const needLandArchive = !synced['opensea-archive'] || unpriced('land');

  // Each source degrades independently — a transient failure in one (e.g. the
  // orderbook 500ing) blanks just that figure instead of taking down the whole tab.
  // ethUsd + fxRates come from the shared caches (getEthUsdDaily / getMarketplaceFx),
  // the same ones the marketplace endpoints use, so the snapshot rebuild doesn't spend
  // extra CoinGecko credit on rates it can read from cache.
  const [creatureSalesRaw, creatureFloorEth, creatureFloorUsdc, land, ethUsd, fx, archiveSales, archiveDays, zkFloorDays] = await Promise.all([
    fetchCreatureSales().catch(err => { console.error('Creature sales failed:', err.message); return []; }),
    fetchCreatureFloorEth().catch(err => { console.error('Creature floor failed:', err.message); return null; }),
    fetchCreatureFloorUsdc().catch(err => { console.error('Creature USDC floor failed:', err.message); return null; }),
    fetchLandData(Date.now() - LAND_RECENT_MS, needLandArchive).catch(err => { console.error('LAND market data failed:', err.message); return null; }),
    getEthUsdDaily().then(d => d || { at: () => null, current: null }).catch(err => { console.error('ETH/USD rate failed:', err.message); return { at: () => null, current: null }; }),
    getMarketplaceFx().catch(err => { console.error('FX rates failed:', err.message); return { fxRates: { usd: 1 } }; }),
    // The years the live feeds have no memory of: the StarkEx sales and daily floors up to
    // the July 2025 migration, and the zkEVM floor rebuilt from the months after it. Four
    // fifths of every Creature ever sold was sold before the migration, so without these the
    // chart opens mid-story. Skipped outright once they are in the store.
    needArchive ? getImxSales() : [],
    needArchive ? imxArchive.getArchiveMetrics().catch(() => []) : [],
    needZkFloor ? getZkFloorHistory().catch(() => new Map()) : new Map(),
  ]);

  const fxRates = fx.fxRates || { usd: 1 };
  const rate = ethUsd.current;
  const toUsd = eth => (eth != null && rate != null ? Math.round(eth * rate) : null);
  // Normalize every Creature sale to an ETH price: USDC sales convert at their OWN day's rate
  // (so historical volume is valued correctly), dropping any USDC sale from a day with no rate.
  const creatureSales = creatureSalesRaw.map(s => {
    if (s.currency === 'usdc') { const r = ethUsd.at(s.ts); return r ? { ts: s.ts, eth: s.amt / r } : null; }
    return { ts: s.ts, eth: s.price };
  }).filter(Boolean);
  // Headline floor = the cheapest listing across BOTH currencies (the USDC floor converted to
  // ETH at the current rate), so a below-ETH-floor USDC listing correctly moves the floor.
  const usdcFloorEth = creatureFloorUsdc != null && rate ? creatureFloorUsdc / rate : null;
  const creatureFloor = [creatureFloorEth, usdcFloorEth].filter(v => v != null && v > 0).reduce((m, v) => (m == null || v < m ? v : m), null);

  // 30-day Creature activity
  let creatureSales30 = 0, creatureVol30 = 0;
  for (const s of creatureSales) if (s.ts >= cutoff30d) { creatureSales30++; creatureVol30 += s.eth; }

  // Sample today's *listing* floor and store it. This is the raw observation — the floor as
  // it stood when we looked — and it is the only record of the floor on any day since we
  // started taking them.
  const today = new Date().toISOString().slice(0, 10);
  await recordFloorSnapshot('creature', today, creatureFloor, toUsd(creatureFloor));
  const landFloorEth = land ? (land.currency === 'ETH' ? land.floor : (land.floorUsd != null && rate ? land.floorUsd / rate : null)) : null;
  if (land) await recordFloorSnapshot('land', today, land.currency === 'ETH' ? land.floor : null, land.floorUsd ?? toUsd(land.floor));

  // --- the chart's history: what is stored, plus whatever this rebuild learned -------------
  // Each day is valued at its own rate. Pre-migration days take theirs straight from the
  // trades that settled that day, which is both the best number available and one that does
  // not depend on the rate table having been rebuilt since the archive sweep landed.
  const archiveRates = needArchive ? imxArchive.archiveRates() : new Map();
  const rateFor = day => archiveRates.get(dayIso(day)) ?? ethUsd.at(day * DAY_MS);
  // Marking a source done is a promise that what was written is right, so it waits until the
  // rate table actually reaches back through the years — at boot the market can be rebuilt
  // before the sweep that widens it has landed.
  const rateTableDeep = ethUsd.from != null && ethUsd.from < dayIndex('2024-01-01');

  if (needArchive) {
    const archiveDaySales = [];
    for (const a of archiveSales) {
      const ts = Date.parse(a.at);
      if (Number.isFinite(ts)) archiveDaySales.push({ ts, eth: a.priceEth });
    }
    for (const [day, agg] of aggregateByDay(archiveDaySales)) {
      mergeDay(state, 'creature', day, { ...agg, ethUsd: rateFor(day) }, 'imx-archive');
    }
    // The archive publishes a dollar floor of its own, but it can come off a listing priced
    // in another coin — a fifth of its days imply an ETH rate more than 10% from the real
    // one — so only the ETH floor is taken, and the day's own rate turns it into dollars.
    for (const d of archiveDays) {
      const day = dayIndex(d.date);
      mergeDay(state, 'creature', day, { floorEth: d.floorEth, ethUsd: rateFor(day) }, 'imx-archive');
    }
  }
  for (const [day, eth] of zkFloorDays) {
    mergeDay(state, 'creature', day, { floorEth: eth, ethUsd: rateFor(day) }, 'zk-orderbook');
  }
  // What the live feeds cover — the recent end of both lines, re-read every rebuild.
  for (const [day, agg] of aggregateByDay(creatureSales)) {
    mergeDay(state, 'creature', day, { ...agg, ethUsd: rateFor(day) }, 'zkevm');
  }
  for (const [day, agg] of aggregateByDay(land?.sales ?? [])) {
    mergeDay(state, 'land', day, { ...agg, ethUsd: rateFor(day) }, 'opensea');
  }
  // Our own floor snapshots, the only record of the floor on any day since June.
  const listing = await getListingSnapshots();
  for (const collection of ['creature', 'land']) {
    for (const [day, v] of listing[collection]) {
      const dayRate = rateFor(day);
      // A snapshot taken while LAND was falling back to CoinGecko has dollars but no ETH.
      const eth = v.eth ?? (v.usd != null && dayRate ? v.usd / dayRate : null);
      mergeDay(state, collection, day, { floorEth: eth, ethUsd: dayRate }, 'snapshot');
    }
  }
  // Today's floor, rounded exactly as the snapshot above stored it — otherwise the two
  // disagree in the ninth decimal and every past day gets rewritten on every rebuild.
  const todayIdx = Math.floor(Date.now() / DAY_MS);
  mergeDay(state, 'creature', todayIdx, { floorEth: round4or(creatureFloor), ethUsd: rate }, 'live');
  mergeDay(state, 'land', todayIdx, { floorEth: round4or(landFloorEth), ethUsd: rate }, 'live');

  let stored = true;
  const writes = dirtyRows(state);
  if (writes.length) {
    try {
      await db.upsertMarketDaily(writes);
      const swept = [needArchive && 'imx-archive', needZkFloor && 'zk-orderbook', needLandArchive && 'opensea-archive'].filter(Boolean);
      console.log(`Market history: ${writes.length} day(s) written; creature ${state.store.creature.size}, land ${state.store.land.size} held${swept.length ? `; swept ${swept.join(' + ')}` : ''}`);
    } catch (err) { console.error('Market history write failed:', err.message); stored = false; }
  }
  // A sweep only counts as done once its days are safely written — otherwise a failed write
  // would retire the sweep and leave the years it covers missing for good.
  if (stored && rateTableDeep) {
    const seal = (source, from, to, rows) => db.setMarketSync(source, { from, to, rows })
      .then(() => console.log(`Market history: ${source} sealed, ${rows} days ${from} to ${to} — not read again`))
      .catch(err => console.error(`Market sync mark (${source}) failed:`, err.message));
    if (needArchive && archiveSales.length && archiveDays.length) {
      await seal('imx-archive', archiveDays[0].date, archiveDays[archiveDays.length - 1].date, archiveDays.length);
    }
    if (needZkFloor && zkFloorDays.size) {
      const days = [...zkFloorDays.keys()].sort((a, b) => a - b);
      await seal('zk-orderbook', dayIso(days[0]), dayIso(days[days.length - 1]), days.length);
    }
    if (needLandArchive && landSalesArchive.data?.length) {
      const days = new Set(landSalesArchive.data.map(x => Math.floor(x.ts / DAY_MS)));
      await seal('opensea-archive', dayIso(Math.min(...days)), today, days.size);
    }
  }

  const creatureHistory = buildCollectionSeries(state.store.creature);
  const landHistory = buildCollectionSeries(state.store.land);
  if (!landHistory.length) {
    console.warn(`LAND history is empty: live read ${land ? `returned ${land.sales?.length ?? 0} sales via ${land.source}` : 'failed'}, store holds nothing.`
      + ' The deep OpenSea sweep has not succeeded yet; it retries on the next rebuild.');
  }

  return {
    ethUsd: rate,
    fxRates, // USD-relative display rates: { usd:1, eur, gbp, brl, rub, try, jpy, cad, aud }
    creatures: {
      currency: 'ETH',
      floor: creatureFloor != null ? round4(creatureFloor) : null,
      floorUsd: toUsd(creatureFloor),
      sales30d: creatureSales30,
      volume30d: round4(creatureVol30),
      history: creatureHistory,
    },
    // A bad read of today's LAND figures is not a reason to withhold the years we already
    // have. When the live fetch fails the headline numbers go blank — the page prints "—"
    // for them — and the chart keeps every stored day. Only a collection we know nothing at
    // all about is null.
    land: (land || landHistory.length) ? {
      currency: land?.currency ?? 'ETH',
      source: land?.source ?? 'store',
      floor: land?.floor != null ? round4(land.floor) : null,
      floorUsd: land?.floorUsd != null ? Math.round(land.floorUsd) : toUsd(land?.floor),
      owners: land?.owners ?? null,
      sales30d: land?.sales30d ?? null,
      volume30d: land?.volume30d ?? null,
      floorChange24h: land?.floorChange24h ?? null,
      history: landHistory,
    } : null,
    lastFetched: new Date().toISOString(),
    stale: false,
  };
}

function getMarketStats() {
  const now = Date.now();
  const isFresh = marketCache.data && (now - marketCache.fetchedAt) < MARKET_CACHE_TTL_MS;
  if (isFresh) return Promise.resolve(marketCache.data);

  if (!marketCache.inFlight) {
    marketCache.inFlight = computeMarketStats()
      .then(data => {
        marketCache.data = data;
        marketCache.fetchedAt = Date.now();
        marketCache.inFlight = null;
        return data;
      })
      .catch(err => {
        marketCache.inFlight = null;
        console.error('Market stats fetch failed:', err.message);
        throw err;
      });
  }

  if (marketCache.data) return Promise.resolve({ ...marketCache.data, stale: true });
  return marketCache.inFlight;
}

// Warm up market cache in the background on startup, once its tables are there to read.
dbReady.then(() => getMarketStats()).catch(err => console.error('Market stats prefetch failed:', err.message));

// Re-run periodically so today's floor snapshot is captured even on quiet days
// with no visitors (computeMarketStats records the floor as a side effect).
setInterval(() => { getMarketStats().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();

// --- Marketplace: browse active Creature listings (non-custodial) ---
// Public browse surface for the Trade tab. Joins the Immutable orderbook's active ETH
// listings (cheapest first) with each token's metadata + image, so the client renders
// a grid without ever touching keys or funds. Buy/sell/cancel (which need signed
// orders) arrive in later phases. Short-cached per cursor — listings move, so freshness
// matters more here than for the slow holder/market snapshots.
const MKT_PAGE_SIZE       = 24;
const MKT_LISTINGS_TTL_MS = 60 * 1000;
const CREATURE_IMG_HOST   = 'https://cdn-production.joinhighrise.com'; // Creature art host (see CSP img-src)
const listingsCache = new Map(); // cursor ('' = first page) -> { data, at }

// A chunk of the collection still carries an older metadata format: camelCase trait
// keys ('backgroundColor') and a junk 'attributes' entry (verified live 2026-06-10 —
// 24 of 103 listed tokens). Normalize to the display form the rest of the collection
// uses, so trait filters and facets see ONE vocabulary, not two. Snake_case keys
// ('animation_url_mime_type') are technical metadata, never real traits — dropped.
function normalizeTraitType(tt) {
  const s = String(tt ?? '').trim();
  if (!s || s === 'attributes' || s.includes('_')) return null;
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b[a-z]/g, c => c.toUpperCase());
}

// Shape a raw metadata record into just the public fields the client needs.
function shapeCreatureMeta(r, tokenId) {
  return {
    name: r.name || `Highrise Creature #${tokenId}`,
    image: r.image || null,
    description: r.description || null,
    attributes: Array.isArray(r.attributes)
      ? r.attributes
          .map(a => ({ trait: normalizeTraitType(a.trait_type), value: a.value }))
          .filter(a => a.trait && (typeof a.value === 'string' || typeof a.value === 'number'))
      : [],
  };
}

// Metadata for many tokens → Map<tokenId, meta>. The per-token metadata endpoint
// rate-limits distinct parallel calls (429s), so we never fan out: the list endpoint
// accepts repeated token_id params. But only up to ~32 of them — more is a hard 400
// (verified live 2026-06-10) — so larger requests run as sequential ≤25-id chunks.
const META_BATCH_MAX = 25;
async function fetchCreatureMetaBatch(tokenIds) {
  const out = new Map();
  for (let i = 0; i < tokenIds.length; i += META_BATCH_MAX) {
    const chunk = tokenIds.slice(i, i + META_BATCH_MAX);
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/collections/${CREATURE_CONTRACT}/nfts`);
    for (const id of chunk) url.searchParams.append('token_id', id);
    url.searchParams.set('page_size', String(chunk.length));
    try {
      const body = await imxFetch(url.toString());
      for (const r of (body.result ?? [])) out.set(String(r.token_id), shapeCreatureMeta(r, r.token_id));
    } catch (err) {
      console.error('Creature metadata batch failed:', err.message); // grid still renders, sans art
    }
  }
  return out;
}

// One Creature's metadata (single-token path for the detail endpoint).
async function fetchCreatureMeta(tokenId) {
  const url = `https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/collections/${CREATURE_CONTRACT}/nfts/${tokenId}`;
  try { return shapeCreatureMeta((await imxFetch(url)).result || {}, tokenId); }
  catch { return null; }
}

// A page of cheapest active ETH listings, each joined with its token metadata.
async function fetchCreatureListingsPage(cursor) {
  const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
  url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
  url.searchParams.set('buy_item_contract_address', IMX_ETH_TOKEN);
  url.searchParams.set('status', 'ACTIVE');
  url.searchParams.set('sort_by', 'buy_item_amount');
  url.searchParams.set('sort_direction', 'asc');
  url.searchParams.set('page_size', String(MKT_PAGE_SIZE));
  if (cursor) url.searchParams.set('page_cursor', cursor);

  const body = await imxFetch(url.toString());
  const orders = body.result ?? [];
  const metaById = await fetchCreatureMetaBatch(orders.map(o => o.sell?.[0]?.token_id).filter(Boolean));

  // The price the seller set is buy.amount; the buyer also pays the fee items on top.
  const items = orders.map(o => {
    const sell = (o.sell ?? [])[0] || {};
    const buy  = (o.buy ?? [])[0] || {};
    const tokenId = sell.token_id;
    if (!tokenId || !buy.amount) return null;
    const priceWei = BigInt(buy.amount);
    const feesWei  = (o.fees ?? []).reduce((s, f) => s + (f.amount ? BigInt(f.amount) : 0n), 0n);
    const meta = metaById.get(String(tokenId)) || {};
    return {
      listingId: o.id,
      tokenId,
      seller: o.account_address || null,
      priceEth: round4(Number(priceWei) / 1e18),
      totalEth: round4(Number(priceWei + feesWei) / 1e18),
      name: meta.name || `Highrise Creature #${tokenId}`,
      image: meta.image || null,
      rarity: meta.attributes?.find(a => /rarity/i.test(a.trait))?.value || null,
    };
  }).filter(Boolean);
  return { items, nextCursor: body.page?.next_cursor ?? null };
}

// Offers are gasless signatures — the bidder's ETH stays in THEIR wallet until fill,
// so an "ACTIVE" bid can be unfillable: balance spent or Seaport allowance revoked
// after signing. The orderbook doesn't re-validate funding, which leaves phantom
// offers (often above floor — impossible to fill, guaranteed revert + confusion).
// We verify funding on-chain before showing any offer as acceptable.
const SEAPORT_ZK    = '0x6c12ad6f0bd274191075eb2e78d7da5ba6453424'; // Immutable Seaport (the bid's ERC-20 spender)
const SEL_ALLOWANCE = '0xdd62ed3e'; // allowance(address,address)

async function offerIsFunded(o) {
  try {
    // The bidder must hold + have approved enough of the OFFER currency (ETH or USDC).
    const token = (zkCurrency(o.currency)?.address) || IMX_ETH_TOKEN;
    const owner = padUint(BigInt(o.from));
    const [balRaw, alwRaw] = await Promise.all([
      ethCall(ZK_RPC_URL, token, SEL_BALANCE_OF + owner),
      ethCall(ZK_RPC_URL, token, SEL_ALLOWANCE + owner + padUint(BigInt(SEAPORT_ZK))),
    ]);
    const need = BigInt(o.grossWei || '0');
    return BigInt(balRaw || '0x0') >= need && BigInt(alwRaw || '0x0') >= need;
  } catch (err) {
    console.error('Offer funding check failed:', err.message);
    return true; // fail-open: an RPC hiccup must not blank the offers UI
  }
}
async function annotateOffersFunded(offers) {
  const flags = await Promise.all((offers || []).map(offerIsFunded));
  return (offers || []).map((o, i) => ({ ...o, funded: flags[i] }));
}
// Browse/accept surfaces: hide unfunded entirely (they cannot be filled right now).
async function fundedOffersOnly(offers) {
  return (await annotateOffersFunded(offers))
    .filter(o => o.funded)
    .map(({ grossWei, funded, ...rest }) => rest);
}

// Add an ETH-equivalent (for cross-currency ranking) + a USD estimate to each zkEVM offer.
// A USDC offer's ETH-equivalent is amount / ethUsd; an ETH offer's USD is amount * ethUsd.
function enrichZkOffers(offers, ethUsd) {
  return (offers || []).map(o => o.currency === 'usdc'
    ? { ...o, priceEth: ethUsd ? round4(o.priceAmt / ethUsd) : null, netEth: ethUsd ? round4(o.netAmt / ethUsd) : null, priceUsd: o.priceAmt, netUsd: o.netAmt }
    : { ...o, priceUsd: ethUsd ? Math.round(o.priceAmt * ethUsd) : null, netUsd: ethUsd ? Math.round(o.netAmt * ethUsd) : null });
}
// Fetch offers in EVERY accepted currency (ETH + USDC) and merge into one mixed book, best
// first by ETH-equivalent. `fn` is one of the orderbook list{Collection,Token,My}Offers; `base`
// carries nftContract (+ tokenId / accountAddress). Each currency is queried independently so
// one currency's hiccup can't blank the whole book.
// Returns { offers, ok, failed } — `failed` is the list of currency keys whose read blew
// up. A caller MUST NOT treat `offers: []` as "no offers" without checking it: an empty
// array from a failed read reads to the user as an empty market, which is how someone
// prices a listing against a book that isn't really empty.
async function zkOffersAllCurrencies(fn, base, ethUsd) {
  const perCur = await Promise.all(Object.values(ZK_CURRENCIES).map(async cur => {
    try {
      upstreamHealth.throwIfFaulted('creatures', 'offers');
      const d = await fn({ ...base, sellContract: cur.address, currency: { code: cur.key, decimals: cur.decimals } });
      return { key: cur.key, offers: d.offers || [] };
    } catch (err) {
      console.error(`offers(${cur.key}) failed:`, err.message);
      return { key: cur.key, offers: null, err };
    }
  }));
  const failed = perCur.filter(r => r.offers == null);
  const ok = perCur.filter(r => r.offers != null);
  if (failed.length) upstreamHealth.noteFail('creatures', 'offers', upstreamHealth.codeFor(failed[0].err));
  else upstreamHealth.noteOk('creatures', 'offers');

  const merged = enrichZkOffers(ok.flatMap(r => r.offers), ethUsd);
  merged.sort((a, b) => (b.priceEth ?? 0) - (a.priceEth ?? 0)); // best offer first (ETH-equivalent)
  return { offers: merged, ok: ok.map(r => r.key), failed: failed.map(r => r.key) };
}

// --- Transfer recipient safety checks ---
// Transfers are irreversible; these checks catch the classic loss patterns BEFORE the
// user can sign: bad EIP-55 checksum (= typo), sending to a protocol contract (asset
// gone forever), and never-used addresses (typo'd or wrong-chain destinations).
let ethersLib = null;
try { ethersLib = require('ethers'); } catch { /* transitive dep of @imtbl/orderbook — present in practice */ }

async function ethGetTxCount(rpcUrl, address) {
  return parseInt(await rpcVia(rpcUrl, 'eth_getTransactionCount', [address, 'latest']), 16) || 0;
}
async function ethGetCode(rpcUrl, address) {
  return (await rpcVia(rpcUrl, 'eth_getCode', [address, 'latest'])) || '0x';
}

// Addresses where an NFT is irretrievably lost or obviously wrong — hard-blocked.
const KNOWN_PROTOCOL_ADDRESSES = new Set([
  CREATURE_CONTRACT.toLowerCase(),
  IMX_ETH_TOKEN, // already lowercase
  '0x6c12ad6f0bd274191075eb2e78d7da5ba6453424', // Immutable Seaport
]);

// Per-chain transfer-check context: which RPC to probe, which NFT signals "familiar
// destination", and which protocol addresses are guaranteed asset graves.
const TRANSFER_CHAINS = {
  zkevm: { rpc: () => ZK_RPC_URL, nft: CREATURE_CONTRACT, blocked: KNOWN_PROTOCOL_ADDRESSES },
  ethereum: {
    rpc: () => ETH_RPC_URL,
    nft: LAND_CONTRACT,
    blocked: new Set([
      LAND_CONTRACT,                                  // the LAND contract itself
      ESTATE_CONTRACT,                                // estates lock parcels — not a wallet
      '0x0000000000000068f116a894984e2db1123eb395',   // OpenSea Seaport 1.6
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',   // WETH
    ]),
  },
};

// Full recipient assessment on the given chain. Never throws — individual probes
// degrade to 'unknown' so a transient RPC blip can't block a legitimate transfer.
async function checkTransferRecipient(rawAddress, chain = 'zkevm') {
  const raw = String(rawAddress || '').trim();
  const lower = raw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) return { valid: false, reason: 'format' };

  // EIP-55: a mixed-case address carries a checksum — if it doesn't verify, the
  // address was mistyped or corrupted. All-lowercase carries no checksum (common
  // from explorers and wallets), so there's nothing to verify.
  const hex = raw.slice(2);
  const isMixedCase = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  let checksum = 'none';
  if (isMixedCase) {
    checksum = 'bad';
    if (ethersLib) { try { ethersLib.getAddress(raw); checksum = 'ok'; } catch { /* stays bad */ } }
    else checksum = 'none'; // can't verify without ethers — treat as unverifiable, not bad
  }
  if (checksum === 'bad') return { valid: false, reason: 'checksum' };

  const ctx = TRANSFER_CHAINS[chain] || TRANSFER_CHAINS.zkevm;
  if (ctx.blocked.has(lower)) return { valid: false, reason: 'protocol' };

  const rpc = ctx.rpc();
  const [code, txCount, native, creatures] = await Promise.all([
    ethGetCode(rpc, lower).catch(() => null),
    ethGetTxCount(rpc, lower).catch(() => null),
    ethGetBalance(rpc, lower).catch(() => null),
    erc721BalanceOf(rpc, ctx.nft, lower).catch(() => null),
  ]);
  const isContract = code != null && code !== '0x';
  // "Active" = any sign of life on Immutable zkEVM: sent txs, holds IMX, or holds
  // Creatures. A deployed contract also counts (it exists on this chain).
  const active = (txCount ?? 0) > 0
    || (native != null && BigInt(native) > 0n)
    || (creatures ?? 0) > 0
    || isContract;
  return {
    valid: true,
    checksum,                      // 'ok' (verified) | 'none' (lowercase, unverifiable)
    contract: isContract,          // safeTransferFrom still guards receivers on-chain
    active,
    activityKnown: txCount != null || native != null || creatures != null || code != null,
    creatures: creatures ?? null,  // nice signal: recipient already holds Creatures
  };
}

// Parse a user-supplied decimal ETH string into wei, exactly (no floats).
// Returns a BigInt or null when the input isn't a sane positive amount.
function parseEthToWei(s) {
  const m = /^(\d{1,6})(?:\.(\d{1,18}))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}

// All Creatures owned by one wallet (for the sell picker): [{tokenId, name, image}].
// Public on-chain data; the client only ever asks for its own connected address.
async function getOwnedCreatures(address) {
  const items = [];
  let cursor = null, pages = 0;
  do {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/accounts/${address}/nfts`);
    url.searchParams.set('contract_address', CREATURE_CONTRACT);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    for (const n of (body.result ?? [])) {
      const tokenId = String(n.token_id);
      // Capture any inline attributes immediately so traits exist even if the catalogue
      // (statistical rank) isn't warm yet; the catalogue overlay below refines them.
      const traits = {};
      for (const a of (n.attributes ?? [])) {
        const type = normalizeTraitType(a.trait_type || a.trait || a.name);
        if (type && a.value != null && a.value !== '' && !(type in traits)) traits[type] = String(a.value);
      }
      items.push({ tokenId, name: n.name || `Highrise Creature #${tokenId}`, image: n.image || null, traits });
    }
    cursor = body.page?.next_cursor ?? null;
    pages++;
  } while (cursor && pages < 5); // 500 Creatures is plenty for a picker
  // Traits come from each NFT's inline attributes above — enough for the Sell/Transfer
  // inventory filters (incl. the Rarity tier). We deliberately DON'T join the browse
  // catalogue for a statistical rank: the account endpoint's packed token_id doesn't
  // match the collection endpoint's, and awaiting a cold catalogue build would stall the
  // picker. The client sorts "Rarest first" by the Rarity tier instead.
  return { items, truncated: !!cursor };
}

// One wallet's ACTIVE listings for the Creature collection (for "My listings").
async function getMyListings(address) {
  const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
  url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
  url.searchParams.set('account_address', address);
  url.searchParams.set('status', 'ACTIVE');
  url.searchParams.set('page_size', '50');
  const [body, fx] = await Promise.all([imxFetch(url.toString()), getMarketplaceFx().catch(() => ({ ethUsd: null }))]);
  const orders = body.result ?? [];
  const metaById = await fetchCreatureMetaBatch(orders.map(o => o.sell?.[0]?.token_id).filter(Boolean));
  const ethUsd = fx.ethUsd;
  return {
    items: orders.map(o => {
      const tokenId = o.sell?.[0]?.token_id;
      const buy = o.buy?.[0] || {};
      const amount = buy.amount;
      if (!tokenId || !amount) return null;
      const meta = metaById.get(String(tokenId)) || {};
      // The listing's currency (default ETH); USDC uses 6 decimals, so amounts are per-currency.
      const cur = zkCurrencyByAddr(buy.contract_address) || ZK_CURRENCIES.eth;
      const priceAmt = unitsToAmount(amount, cur.decimals);
      const priceUsd = cur.key === 'usdc' ? priceAmt : (ethUsd != null ? round4(priceAmt * ethUsd) : null);
      return {
        listingId: o.id,
        tokenId,
        currency: cur.key,
        priceAmt, totalAmt: priceAmt, priceUsd,
        priceEth: cur.key === 'eth' ? priceAmt : (ethUsd ? round4(priceAmt / ethUsd) : priceAmt),
        name: meta.name || `Highrise Creature #${tokenId}`,
        image: meta.image || null,
      };
    }).filter(Boolean),
  };
}

// A wallet's Creature HISTORY for the collection: trades (bought / sold), transfers
// (received / sent / minted), and listing-lifecycle events that never transacted
// (cancelled / expired). Read-only by address — the wallet signs nothing. Two sources,
// merged newest-first:
//   • the activities feed (account-filtered) → on-chain buys, sales and transfers;
//   • the orders API → the wallet's CANCELLED / EXPIRED listings (a FILLED listing is the
//     same event as its 'sold' sale, so it's excluded here to avoid a duplicate row).
// LAND has no equivalent maker-scoped feed (OpenSea returns only live orders), so the
// History tab — and this function — are Creatures-only.
const ACTIVITY_PAGES_MAX = 2; // newest ~200 activities — far more than the rendered cap
const HISTORY_ITEMS_MAX = 80;

async function getMyListingHistory(address) {
  const addr = address.toLowerCase();

  // 1) On-chain activity — one chronological (newest-first) feed, account-filtered.
  // A marketplace sale emits BOTH a 'sale' and a paired 'transfer' (same tx hash); we keep
  // the 'sale' (it carries price + direction) and drop that transfer leg, so the NFT-moving
  // side of a trade isn't shown twice. Collect every sale's tx first, then categorize.
  const acts = [];
  const saleTxs = new Set();
  let activityFailed = false;
  try {
    let cursor = null, pages = 0;
    do {
      const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/activities`);
      url.searchParams.set('contract_address', CREATURE_CONTRACT);
      url.searchParams.set('account_address', addr);
      url.searchParams.set('page_size', '100');
      if (cursor) url.searchParams.set('page_cursor', cursor);
      const body = await imxFetch(url.toString());
      for (const a of (body.result ?? [])) {
        if (a.type === 'sale') { const tx = a.blockchain_metadata?.transaction_hash; if (tx) saleTxs.add(tx); }
        acts.push(a);
      }
      cursor = body.page?.next_cursor ?? null;
    } while (cursor && ++pages < ACTIVITY_PAGES_MAX);
  } catch (err) { activityFailed = true; console.error('Creature activity feed failed:', err.message); }

  const entries = [];
  for (const a of acts) {
    const d = a.details || {};
    const at = a.updated_at || a.indexed_at || null;
    const tx = a.blockchain_metadata?.transaction_hash || null;
    if (a.type === 'sale') {
      const asset = Array.isArray(d.asset) ? d.asset[0] : d.asset; // sale.asset is an array
      const tokenId = asset?.token_id;
      if (!tokenId) continue;
      const isBuyer = (d.to || '').toLowerCase() === addr;
      const payToken = (d.payment?.token?.contract_address || '').toLowerCase();
      const priceWei = d.payment?.price_including_fees; // headline all-in trade price
      const priceEth = payToken === IMX_ETH_TOKEN && priceWei ? round4(Number(BigInt(priceWei)) / 1e18) : null;
      entries.push({ kind: isBuyer ? 'bought' : 'sold', tokenId, priceEth, at, tx,
        with: ((isBuyer ? d.from : d.to) || '').toLowerCase() || null });
    } else if (a.type === 'transfer') {
      if (tx && saleTxs.has(tx)) continue; // NFT leg of a sale — already shown as bought/sold
      const tokenId = d.asset?.token_id;
      if (!tokenId) continue;
      const from = (d.from || '').toLowerCase();
      const isReceiver = (d.to || '').toLowerCase() === addr;
      const kind = from === ZERO_ADDRESS ? 'minted' : isReceiver ? 'received' : 'sent';
      entries.push({ kind, tokenId, priceEth: null, at, tx,
        with: kind === 'minted' ? null : ((isReceiver ? d.from : d.to) || '').toLowerCase() || null });
    }
  }

  // 2) Listing-lifecycle events that never transacted (cancelled / expired). One status per
  // request (the API's status filter takes a single value), in parallel; one failing still
  // yields the other.
  const LISTING_KIND = { CANCELLED: 'cancelled', EXPIRED: 'expired' };
  const fetchStatus = async status => {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
    url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
    url.searchParams.set('account_address', addr);
    url.searchParams.set('status', status);
    url.searchParams.set('page_size', '30');
    const body = await imxFetch(url.toString());
    return (body.result ?? []).map(o => ({ o, status }));
  };
  const settled = await Promise.allSettled(Object.keys(LISTING_KIND).map(fetchStatus));
  settled.forEach((s, i) => { if (s.status === 'rejected') console.error(`Listing history [${Object.keys(LISTING_KIND)[i]}] failed:`, s.reason?.message); });
  // Every upstream source failed — surface it as an error so the client shows "couldn't
  // load" rather than a misleading "no activity yet".
  if (activityFailed && settled.every(s => s.status === 'rejected')) {
    throw Object.assign(new Error('unavailable'), { code: 'unavailable', statusCode: 503 });
  }
  for (const { o, status } of settled.flatMap(s => s.status === 'fulfilled' ? s.value : [])) {
    const tokenId = o.sell?.[0]?.token_id;
    const amount = o.buy?.[0]?.amount;
    if (!tokenId || !amount) continue;
    entries.push({
      kind: LISTING_KIND[status], tokenId,
      priceEth: round4(Number(BigInt(amount)) / 1e18),
      at: o.updated_at || o.created_at || null, tx: null, with: null,
    });
  }

  // Merge, newest-first, cap, then join token metadata in one batch.
  const items = entries
    .filter(e => e.at)
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, HISTORY_ITEMS_MAX);
  const metaById = await fetchCreatureMetaBatch([...new Set(items.map(i => String(i.tokenId)))]);
  for (const it of items) {
    const meta = metaById.get(String(it.tokenId)) || {};
    it.name = meta.name || `Highrise Creature #${it.tokenId}`;
    it.image = meta.image || null;
  }
  return { items };
}

async function getCreatureListings(cursor = '') {
  const key = cursor || '';
  const hit = listingsCache.get(key);
  if (hit && Date.now() - hit.at < MKT_LISTINGS_TTL_MS) return hit.data;
  const [page, fx] = await Promise.all([fetchCreatureListingsPage(cursor), getMarketplaceFx()]);
  const data = {
    items: page.items,
    nextCursor: page.nextCursor,
    ethUsd: fx.ethUsd,
    fxRates: fx.fxRates, // { usd:1, eur, gbp, brl, rub, try, jpy, cad, aud } for the currency picker
    fetchedAt: new Date().toISOString(),
  };
  // Oldest out first. Clearing the whole map threw away the hot first page (cursor '')
  // along with the cold deep cursors it was meant to bound; deleting before the set keeps
  // a re-cached page at the young end of the insertion order.
  listingsCache.delete(key);
  if (listingsCache.size >= 64) listingsCache.delete(listingsCache.keys().next().value);
  listingsCache.set(key, { data, at: Date.now() });
  return data;
}

// Full detail for one token: metadata + current on-chain owner (read straight from the
// contract). The active listing, if any, is supplied client-side from the grid card.
async function getCreatureToken(tokenId) {
  const [meta, ownerRaw, artMap] = await Promise.all([
    fetchCreatureMeta(tokenId),
    ethCall(ZK_RPC_URL, CREATURE_CONTRACT, SEL_OWNER_OF + padUint(BigInt(tokenId))).catch(() => null),
    getTraitArtMap().catch(() => new Map()),
  ]);
  const owner = ownerRaw && ownerRaw.length >= 42 ? ('0x' + ownerRaw.slice(-40)).toLowerCase() : null;
  const coll = getCollectionIndex(); // statistical rank, when the index is built
  return {
    tokenId,
    name: meta?.name || `Highrise Creature #${tokenId}`,
    image: meta?.image || null,
    description: meta?.description || null,
    attributes: meta?.attributes || [],
    parts: creatureParts(meta?.attributes || [], artMap),
    owner,
    rank: coll?.byId.get(String(tokenId))?.rank ?? null,
    rankOf: coll?.total ?? null,
  };
}

// --- Marketplace: filterable browse (IMX-Rarity-style explorer) ---
// One in-memory snapshot of EVERY active ETH listing joined with its full metadata,
// rebuilt at most once a minute. Stale-while-revalidate: once the first snapshot
// exists, no request ever waits on a rebuild. Filtering, faceting, and sorting then
// happen in-process per request — zero upstream calls per filter change, so clicking
// through traits stays instant and can't exhaust the Immutable rate limits.
const BROWSE_TTL_MS    = 60 * 1000;
const BROWSE_MAX_PAGES = 5;   // 5 × 200 = 1000 listings indexed — far above today's ~100
const BROWSE_PAGE_SIZE = 24;
const RARITY_ORDER = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common']; // best first
const rarityRank = r => { const i = RARITY_ORDER.indexOf(r); return i === -1 ? RARITY_ORDER.length : i; };
const browseIndex = { data: null, at: 0, inFlight: null };

// Page every active listing priced in one currency (cheapest first), tagging each with it.
async function fetchListingsByCurrency(cur) {
  const orders = [];
  let cursor = null, pages = 0, truncated = false;
  do {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
    url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
    url.searchParams.set('buy_item_contract_address', cur.address);
    url.searchParams.set('status', 'ACTIVE');
    url.searchParams.set('sort_by', 'buy_item_amount');
    url.searchParams.set('sort_direction', 'asc');
    url.searchParams.set('page_size', '200');
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    for (const o of (body.result ?? [])) orders.push({ o, cur });
    cursor = body.page?.next_cursor ?? null;
    if (cursor && ++pages >= BROWSE_MAX_PAGES) { truncated = true; break; }
  } while (cursor);
  return { orders, truncated };
}

async function buildBrowseIndex() {
  // 1) Every active listing in EACH accepted currency (ETH + USDC), plus the ETH/USD rate
  //    so USDC prices can be compared against ETH prices in one mixed, sortable book.
  const fx = await getMarketplaceFx().catch(() => ({ ethUsd: null }));
  const ethUsd = fx.ethUsd;
  const results = await Promise.all(Object.values(ZK_CURRENCIES).map(fetchListingsByCurrency));
  const orders = results.flatMap(r => r.orders);
  const truncated = results.some(r => r.truncated);

  // 2) Metadata. Traits are immutable, so the full-collection index (once built) is
  //    the authoritative source — zero metadata API calls per rebuild, and a transient
  //    upstream 429 can't blank a snapshot's traits. Only tokens the index doesn't
  //    know (not built yet, or a gap) hit the batch endpoint.
  const collIdx = collectionIndex.data;
  const ids = [...new Set(orders.map(({ o }) => o.sell?.[0]?.token_id).filter(Boolean).map(String))];
  const metaById = await fetchCreatureMetaBatch(collIdx ? ids.filter(id => !collIdx.byId.has(id)) : ids);

  // 3) Join into flat filterable rows. `priceEth`/`totalEth` stay as the ETH-COMPARABLE value
  //    (native for ETH rows, USD/ethUsd for USDC rows) so the existing sort/price-filter/floor
  //    logic keeps working across the mixed book; `currency` + `priceAmt`/`totalAmt` carry the
  //    native amount the grid actually displays, and `priceUsd` the all-in dollar value.
  const items = orders.map(({ o, cur }) => {
    const sell = (o.sell ?? [])[0] || {};
    const buy  = (o.buy ?? [])[0] || {};
    const tokenId = sell.token_id;
    if (!tokenId || !buy.amount) return null;
    const priceUnits = BigInt(buy.amount);
    const feesUnits  = (o.fees ?? []).reduce((s, f) => s + (f.amount ? BigInt(f.amount) : 0n), 0n);
    const priceAmt = unitsToAmount(priceUnits, cur.decimals);
    const totalAmt = unitsToAmount(priceUnits + feesUnits, cur.decimals);
    // All-in USD (USDC is 1:1; ETH via the live rate) → the mixed-book comparable.
    const priceUsd = cur.key === 'usdc' ? totalAmt : (ethUsd != null ? round4(totalAmt * ethUsd) : null);
    // ETH-equivalent for the existing ETH-denominated sort/filter/floor machinery.
    const totalEth = cur.key === 'eth' ? totalAmt : (ethUsd ? round4(totalAmt / ethUsd) : totalAmt);
    const priceEth = cur.key === 'eth' ? priceAmt : (ethUsd ? round4(priceAmt / ethUsd) : priceAmt);
    const known = collIdx?.byId.get(String(tokenId));
    const meta = metaById.get(String(tokenId));
    const traits = {};
    if (known) Object.assign(traits, known.traits);
    else if (meta) for (const a of (meta.attributes || [])) traits[a.trait] = String(a.value);
    return {
      listingId: o.id,
      tokenId,
      seller: o.account_address || null,
      currency: cur.key,          // 'eth' | 'usdc' — drives native display
      priceAmt, totalAmt,         // native amount in that currency (what the grid shows)
      priceUsd,                   // all-in USD (comparison + the "≈ $X" line)
      priceEth, totalEth,         // ETH-comparable (kept so sort/filter/floor are unchanged)
      name: known?.name || meta?.name || `Highrise Creature #${tokenId}`,
      image: known?.image || meta?.image || null,
      rarity: Object.entries(traits).find(([k]) => /rarity/i.test(k))?.[1] || null,
      listedAt: Date.parse(o.created_at) || 0,
      traits,
    };
  }).filter(Boolean);
  return { items, truncated };
}

async function getBrowseIndex() {
  const fresh = browseIndex.data && Date.now() - browseIndex.at < BROWSE_TTL_MS;
  if (!fresh && !browseIndex.inFlight) {
    browseIndex.inFlight = buildBrowseIndex()
      .then(d => { browseIndex.data = d; browseIndex.at = Date.now(); return d; })
      .catch(err => {
        console.error('Browse index build failed:', err.message);
        if (!browseIndex.data) throw err; // cold boot with nothing to serve → surface it
        return browseIndex.data;          // refresh hiccup → keep serving the stale copy
      })
      .finally(() => { browseIndex.inFlight = null; });
  }
  return browseIndex.data || browseIndex.inFlight;
}

// Warm it at boot, in the background. Stale-while-revalidate means nobody waits on a
// REBUILD, but a cold process has nothing to serve, so without this the first Trade
// visitor after every deploy waits on the whole listing sweep (measured at ~4s).
getBrowseIndex().catch(() => {}); // a cold-boot failure already logged itself; retry is on demand

// Wire format: q (name substring), min/max (ETH, vs the all-in price), sort,
// page (offset into the filtered set), and repeated t=Type:Value params —
// multi-select is OR within a type, AND across types (standard faceted search).
function parseBrowseQuery(searchParams) {
  const q = (searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
  const num = v => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null; };
  const traits = new Map(); // type -> Set(values)
  for (const pair of searchParams.getAll('t').slice(0, 40)) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const type = pair.slice(0, i).slice(0, 60);
    const value = pair.slice(i + 1).slice(0, 120);
    if (!value) continue;
    if (!traits.has(type)) traits.set(type, new Set());
    traits.get(type).add(value);
  }
  const sort = ['price-asc', 'price-desc', 'newest', 'rarity'].includes(searchParams.get('sort'))
    ? searchParams.get('sort') : 'price-asc';
  const page = Math.min(500, Math.max(0, parseInt(searchParams.get('page'), 10) || 0));
  const scope = searchParams.get('scope') === 'all' ? 'all' : 'listed';
  return { q, min: num(searchParams.get('min')), max: num(searchParams.get('max')), traits, sort, page, scope };
}

// skipType: evaluate every filter EXCEPT that trait type — how facet counts answer
// "what would I get if I picked this value", given everything else stays selected.
function browseMatch(it, f, skipType) {
  // `search` lets a row be findable by more than its name (slimes: nickname + coords).
  if (f.q && !(it.search || it.name || '').toLowerCase().includes(f.q)) return false;
  // Unlisted rows have no price — a price filter implies "for sale", so they drop out.
  const price = it.totalEth ?? it.priceEth ?? null;
  if (f.min != null && (price == null || price < f.min)) return false;
  if (f.max != null && (price == null || price > f.max)) return false;
  for (const [type, values] of f.traits) {
    if (type !== skipType && !values.has(it.traits[type])) return false;
  }
  return true;
}

// Unlisted rows (no price) sink to the end of price sorts; statistical rank breaks
// every tie so ordering is stable across snapshot rebuilds.
const browsePriceOf = it => it.totalEth ?? it.priceEth ?? null;
const browseRankOf  = it => it.rank ?? Number.MAX_SAFE_INTEGER;
function cmpBrowsePrice(a, b, dir) {
  const pa = browsePriceOf(a), pb = browsePriceOf(b);
  if (pa != null && pb != null) return dir * (pa - pb) || browseRankOf(a) - browseRankOf(b);
  if (pa != null) return -1;
  if (pb != null) return 1;
  return browseRankOf(a) - browseRankOf(b);
}
const BROWSE_SORTS = {
  'price-asc':  (a, b) => cmpBrowsePrice(a, b, 1),
  'price-desc': (a, b) => cmpBrowsePrice(a, b, -1),
  'newest':     (a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0) || browseRankOf(a) - browseRankOf(b),
  // True statistical rank when the collection index is built; tier order until then.
  'rarity':     (a, b) => (a.rank != null && b.rank != null)
    ? a.rank - b.rank
    : (rarityRank(a.rarity) - rarityRank(b.rarity) || cmpBrowsePrice(a, b, 1)),
};

// Facets over the whole snapshot: every trait value that exists in ANY active listing
// renders in the filter UI, with its count under the current other filters (0 = picking
// it would empty the grid — shown disabled, never hidden, so the vocabulary is stable).
function computeBrowseFacets(items, f) {
  const types = new Map(); // type -> Map(value -> count)
  for (const it of items) {
    for (const [type, v] of Object.entries(it.traits)) {
      if (!types.has(type)) types.set(type, new Map());
      const vals = types.get(type);
      if (!vals.has(v)) vals.set(v, 0);
    }
  }
  for (const [type, vals] of types) {
    for (const it of items) {
      const v = it.traits[type];
      if (v !== undefined && browseMatch(it, f, type)) vals.set(v, vals.get(v) + 1);
    }
  }
  const out = [];
  for (const [type, vals] of types) {
    const values = [...vals.entries()].map(([v, n]) => ({ v, n }));
    if (/rarity/i.test(type)) values.sort((a, b) => rarityRank(a.v) - rarityRank(b.v));
    else values.sort((a, b) => a.v.localeCompare(b.v));
    out.push({ type, values });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return out;
}

// --- Full-collection index: every Creature's traits + a statistical rarity rank ---
// Traits are immutable, so this builds once (~56 paged calls, well under a minute) in
// the background at boot and refreshes daily. It powers scope=all browsing and the
// rank chips. Until the first build lands, browse quietly serves listed-only and
// flags `indexing` so the client can say "hold on, cataloguing".
const COLLECTION_TTL_MS    = 24 * 60 * 60 * 1000;
const COLLECTION_MAX_PAGES = 120;      // 120 × 200 = 24k — far above the 11,111 supply
const COLLECTION_RETRY_MS  = 60 * 1000; // failed build → cool off before trying again
const collectionIndex = { data: null, at: 0, inFlight: null, failedAt: 0 };

async function buildCollectionIndex() {
  const byId = new Map();
  let cursor = null, pages = 0;
  do {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/collections/${CREATURE_CONTRACT}/nfts`);
    url.searchParams.set('page_size', '200');
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    for (const r of (body.result ?? [])) {
      const meta = shapeCreatureMeta(r, r.token_id);
      const traits = {};
      for (const a of meta.attributes) traits[a.trait] = String(a.value);
      byId.set(String(r.token_id), {
        tokenId: String(r.token_id),
        name: meta.name,
        image: meta.image,
        rarity: meta.attributes.find(a => /rarity/i.test(a.trait))?.value || null,
        traits,
      });
    }
    cursor = body.page?.next_cursor ?? null;
    if (cursor) await new Promise(r => setTimeout(r, 120)); // pace the sweep
  } while (cursor && ++pages < COLLECTION_MAX_PAGES);

  // Statistical rarity, the formula IMX Rarity used: a token's score is the sum of
  // 1/frequency across its trait values, so rare values dominate. Rank 1 = rarest.
  const freq = new Map();
  for (const it of byId.values()) {
    for (const [type, v] of Object.entries(it.traits)) {
      const k = `${type}:${v}`;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const total = byId.size;
  for (const it of byId.values()) {
    let score = 0;
    for (const [type, v] of Object.entries(it.traits)) score += total / freq.get(`${type}:${v}`);
    it.score = score;
  }
  const items = [...byId.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  items.forEach((it, i) => { it.rank = i + 1; });
  console.log(`Creature collection index built: ${total} tokens across ${pages + 1} pages.`);
  return { byId, items, total, builtAt: Date.now() };
}

// Non-blocking accessor: returns the index when built (kicking a refresh once stale),
// null while the first build is running — callers degrade to listed-only meanwhile.
function getCollectionIndex() {
  const fresh = collectionIndex.data && Date.now() - collectionIndex.at < COLLECTION_TTL_MS;
  const cooling = Date.now() - collectionIndex.failedAt < COLLECTION_RETRY_MS;
  if (!fresh && !collectionIndex.inFlight && !cooling) {
    collectionIndex.inFlight = buildCollectionIndex()
      .then(d => { collectionIndex.data = d; collectionIndex.at = Date.now(); return d; })
      .catch(err => { collectionIndex.failedAt = Date.now(); console.error('Collection index build failed:', err.message); })
      .finally(() => { collectionIndex.inFlight = null; });
  }
  return collectionIndex.data;
}
getCollectionIndex(); // warm it at boot, in the background
setInterval(() => { getCollectionIndex(); }, 60 * 60 * 1000).unref(); // hourly check; TTL gates the rebuild

// --- Holders: rarity & tier quality index ---
// The holders snapshot above answers "how many", never "how good". Two questions holders
// keep asking are how many Legendary Creatures exist and where they sit, and how much of
// the LAND map is Premium — and neither is answerable from a /holders balance feed, which
// carries counts and nothing else. Both need per-TOKEN ownership joined to per-token
// attributes, so this is its own sweep on its own clock:
//
//   Creatures  Immutable's collection /owners feed (tokenId → wallet, 200/page, ~56 pages)
//              joined to the rarity already carried by the collection index.
//   LAND       the mainnet explorer's /instances feed, which returns the owner AND the
//              parcel's own Rarity trait (normal/premium) inline — one crawl, no
//              per-token metadata calls. Estate-held parcels are handed back to the
//              person behind the estate before anything is counted.
//
// Twelve hours between sweeps: a Legendary changing hands is rare, and the alternative is
// ~120 pages of upstream crawl every time somebody opens the tab. The client is told when
// the snapshot was taken and hides the section while the first one builds.
const QUALITY_TTL_MS       = 12 * 60 * 60 * 1000;
const QUALITY_RETRY_MS     = 5 * 60 * 1000;   // nothing to serve → try again soon
const QUALITY_DEGRADED_MS  = 60 * 60 * 1000;  // an older snapshot still serves → go gently
const QUALITY_PARTIAL_MS   = 15 * 60 * 1000;  // one side missing → re-sweep within the hour
const QUALITY_MAX_PAGES    = 120;             // 120 × 200 = 24k, far above the 11,111 supply
// Buckets for "wallets by how many of the rare thing they hold": 1 / 2 / 3-4 / 5-9 / 10+.
// Finer at the bottom than the main distribution, because holding two Legendaries is a
// real distinction and holding two Creatures is not.
const RARE_DIST_THRESHOLDS = [1, 2, 3, 5, 10];
const RAREST_TOP_N         = 100; // "the N rarest by statistical rank sit in M wallets"
const LAND_INSTANCES_URL   = 'https://eth.blockscout.com/api/v2/tokens/0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11/instances';
// The parcel's own metadata "Rarity" trait is what Highrise calls the plot TIER. Same
// mapping as lib/land-market.js tierOf() — keep the two in step.
const LAND_TIER = { premium: 'Premium', normal: 'Standard', standard: 'Standard' };

// Map<tokenId, ownerAddress> for every Creature. The collection /owners feed is the same
// shape and page cost as the metadata sweep the collection index already runs.
async function fetchCreatureOwners() {
  const byToken = new Map();
  let cursor = null, pages = 0;
  do {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/collections/${CREATURE_CONTRACT}/owners`);
    url.searchParams.set('page_size', '200');
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    for (const r of (body.result ?? [])) {
      const owner = String(r.account_address || '').toLowerCase();
      if (!HEX_ADDRESS.test(owner) || owner === ZERO_ADDRESS) continue;
      byToken.set(String(r.token_id), owner);
    }
    cursor = body.page?.next_cursor ?? null;
    if (cursor) await new Promise(r => setTimeout(r, 120)); // pace the sweep
  } while (cursor && ++pages < QUALITY_MAX_PAGES);
  return byToken;
}

// [{ tokenId, owner, tier }] for every live LAND parcel. A parcel with no readable owner
// or no tier is skipped rather than guessed at — a missing tier is not a Standard plot.
async function fetchLandParcels() {
  const parcels = [];
  await fetchBlockscoutPages(LAND_INSTANCES_URL, body => {
    for (const it of (body.items ?? [])) {
      const owner = String(it.owner?.hash || '').toLowerCase();
      const props = it.metadata?.properties ?? [];
      const rarity = props.find(p => /^rarity$/i.test(p.trait_type || ''))?.value;
      const tier = LAND_TIER[String(rarity ?? '').toLowerCase()];
      if (!HEX_ADDRESS.test(owner) || owner === ZERO_ADDRESS || !tier) continue;
      parcels.push({ tokenId: String(it.id), owner, tier });
    }
  });
  return parcels;
}

// One rare-thing close-up: how many exist, how many wallets hold at least one, the biggest
// single holding, and the wallets-by-holding buckets. `share` is filled in by the caller.
function summariseRare(perWallet, supply) {
  const held = [...perWallet.values()];
  return {
    supply,
    share: null,
    holders: held.length,
    mostHeld: held.length ? Math.max(...held) : 0,
    perWallet: computeDistribution(perWallet, RARE_DIST_THRESHOLDS),
  };
}

// Creature side: rarity tiers across the whole supply, plus a close-up on the rarest tier.
function creatureQuality(ownersByToken, coll) {
  const supplyByTier = new Map();   // 'Legendary' → creatures
  const walletsByTier = new Map();  // 'Legendary' → Set(wallets)
  const perWalletTop = new Map();   // wallet → rarest-tier creatures held
  const rarestWallets = new Set();  // wallets holding a top-N-rank Creature
  const wallets = new Set();

  // The rarest tier PRESENT, not a hardcoded "Legendary" — Gen 2 need not use the same
  // words, and 11,002 of today's 11,111 Creatures are Epic with nothing below it.
  let topTier = null;
  for (const known of coll.byId.values()) {
    if (known.rarity && (topTier == null || rarityRank(known.rarity) < rarityRank(topTier))) topTier = known.rarity;
  }

  for (const [tokenId, owner] of ownersByToken) {
    wallets.add(owner);
    const known = coll.byId.get(tokenId);
    if (!known) continue;
    // 33 Creatures carry no attributes at all, so they have no rarity either. They get
    // their own label rather than being folded into the commonest tier.
    const tier = known.rarity || 'Untraited';
    supplyByTier.set(tier, (supplyByTier.get(tier) || 0) + 1);
    if (!walletsByTier.has(tier)) walletsByTier.set(tier, new Set());
    walletsByTier.get(tier).add(owner);
    if (tier === topTier) perWalletTop.set(owner, (perWalletTop.get(owner) || 0) + 1);
    if (known.rank != null && known.rank <= RAREST_TOP_N) rarestWallets.add(owner);
  }

  const supply = [...supplyByTier.values()].reduce((a, b) => a + b, 0);
  // Rarest tier first, untraited tail last — rarityRank() already sends anything it does
  // not recognise to the back.
  const tiers = [...supplyByTier.keys()]
    .sort((a, b) => rarityRank(a) - rarityRank(b) || a.localeCompare(b))
    .map(key => ({
      key,
      supply: supplyByTier.get(key),
      share: supply ? round4(supplyByTier.get(key) / supply) : 0,
      holders: walletsByTier.get(key).size,
    }));

  const top = topTier ? { key: topTier, ...summariseRare(perWalletTop, supplyByTier.get(topTier) || 0) } : null;
  if (top) top.share = supply ? round4(top.supply / supply) : 0;
  return {
    supply,
    wallets: wallets.size,
    tiers,
    top,
    rarest: { n: RAREST_TOP_N, holders: rarestWallets.size },
  };
}

// LAND side: Premium vs Standard across the map, plus a close-up on Premium.
function landQuality(parcels, estate) {
  const supplyByTier = new Map();
  const walletsByTier = new Map();
  const perWalletPremium = new Map();
  const wallets = new Set();
  const estateOwners = new Set();
  let estateHeld = 0;

  for (const { tokenId, owner, tier } of parcels) {
    // A parcel locked in an estate is owned on-chain by the estate contract. Hand it to
    // whoever owns the estate, exactly as the holder snapshot does — otherwise every
    // estate builder reads as owning no Premium land at all.
    let holder = owner;
    if (holder === ESTATE_CONTRACT) {
      const behind = estate.parcelOwner.get(tokenId);
      if (!behind) continue; // in the contract but no live estate claims it — leave it out
      holder = behind;
      estateHeld++;
      estateOwners.add(behind);
    }
    wallets.add(holder);
    supplyByTier.set(tier, (supplyByTier.get(tier) || 0) + 1);
    if (!walletsByTier.has(tier)) walletsByTier.set(tier, new Set());
    walletsByTier.get(tier).add(holder);
    if (tier === 'Premium') perWalletPremium.set(holder, (perWalletPremium.get(holder) || 0) + 1);
  }

  const supply = [...supplyByTier.values()].reduce((a, b) => a + b, 0);
  const tiers = ['Premium', 'Standard'].filter(k => supplyByTier.has(k)).map(key => ({
    key,
    supply: supplyByTier.get(key),
    share: supply ? round4(supplyByTier.get(key) / supply) : 0,
    holders: walletsByTier.get(key).size,
  }));
  const top = { key: 'Premium', ...summariseRare(perWalletPremium, supplyByTier.get('Premium') || 0) };
  top.share = supply ? round4(top.supply / supply) : 0;
  return {
    supply,
    wallets: wallets.size,
    tiers,
    top,
    // Parcels counted from what the estate contract ACTUALLY holds, not from the mint logs
    // or the contract's own parcel array — both of those run high (see the KNOWN OVER-COUNT
    // note by ESTATE_CONTRACT). This is the exact figure the page publishes.
    estates: {
      live: estate.estates.live,
      parcelsLocked: estateHeld,
      owners: estateOwners.size,
    },
  };
}

async function buildHolderQuality() {
  // The Creature side is a join, so it needs the collection index's rarity and ranks. On a
  // cold boot that index is still sweeping, and a snapshot built without it would say
  // "Creatures unavailable" for a quarter of an hour — so wait on the build already in
  // flight instead. Only if there is no build at all do we go LAND-only.
  let coll = getCollectionIndex();
  if (!coll && collectionIndex.inFlight) coll = await collectionIndex.inFlight;
  const [ownersByToken, parcels, estate] = await Promise.all([
    coll
      ? fetchCreatureOwners().catch(err => { console.error('Creature owner sweep failed:', err.message); return null; })
      : Promise.resolve(null),
    fetchLandParcels().catch(err => { console.error('LAND parcel sweep failed:', err.message); return null; }),
    getEstateAttribution().catch(() => EMPTY_ESTATE_ATTRIBUTION),
  ]);

  const creatures = ownersByToken?.size && coll ? creatureQuality(ownersByToken, coll) : null;
  const land = parcels?.length ? landQuality(parcels, estate) : null;
  // Both halves gone means the sweep told us nothing. Throw, so the retry timer runs and
  // whatever we served before keeps serving — an empty snapshot would read as "there are
  // no Legendaries", which is a lie a stale one never tells.
  if (!creatures && !land) throw new Error('neither the Creature nor the LAND sweep returned anything');
  console.log(`Holder quality snapshot: ${creatures ? `${creatures.supply} Creatures` : 'Creatures unavailable'}, ${land ? `${land.supply} parcels` : 'LAND unavailable'}.`);
  return { creatures, land, fetchedAt: new Date().toISOString() };
}

const qualityIndex = { data: null, at: 0, inFlight: null, failedAt: 0, coolMs: 0 };

// Non-blocking, same contract as getCollectionIndex: returns the snapshot when there is
// one and kicks a refresh once it is stale. A partial snapshot (one side missing) expires
// on the short clock, so the missing half gets another go soon.
function getHolderQuality() {
  const partial = qualityIndex.data && !(qualityIndex.data.creatures && qualityIndex.data.land);
  const ttl = partial ? QUALITY_PARTIAL_MS : QUALITY_TTL_MS;
  const fresh = qualityIndex.data && Date.now() - qualityIndex.at < ttl;
  const cooling = Date.now() - qualityIndex.failedAt < qualityIndex.coolMs;
  if (!fresh && !qualityIndex.inFlight && !cooling) {
    qualityIndex.inFlight = buildHolderQuality()
      .then(d => {
        qualityIndex.data = d; qualityIndex.at = Date.now();
        qualityIndex.failedAt = 0; qualityIndex.coolMs = 0;
        return d;
      })
      .catch(err => {
        qualityIndex.failedAt = Date.now();
        qualityIndex.coolMs = qualityIndex.data ? QUALITY_DEGRADED_MS : QUALITY_RETRY_MS;
        console.error('Holder quality build failed:', err.message);
      })
      .finally(() => { qualityIndex.inFlight = null; });
  }
  return qualityIndex.data;
}
// Warmed a minute after boot rather than at it: the collection index it joins against is
// starting its own sweep right now, and racing the two only makes both slower.
setTimeout(() => { getHolderQuality(); }, 60 * 1000).unref();
setInterval(() => { getHolderQuality(); }, 30 * 60 * 1000).unref(); // TTL gates the rebuild

// Browse pools, memoized per (listings snapshot, collection build) pair so the merge
// cost is paid once per 60s snapshot rebuild, not once per request.
function listedPoolOf(listIdx, coll) {
  if (listIdx._listedPool && listIdx._poolColl === coll) return listIdx._listedPool;
  listIdx._listedPool = listIdx.items.map(it =>
    ({ ...it, listed: true, rank: coll?.byId.get(String(it.tokenId))?.rank ?? null }));
  listIdx._poolColl = coll;
  listIdx._allPool = null;
  return listIdx._listedPool;
}
function allPoolOf(listIdx, coll) {
  const listed = listedPoolOf(listIdx, coll); // also keys the memo to this coll build
  if (listIdx._allPool) return listIdx._allPool;
  const listedById = new Map(listed.map(it => [String(it.tokenId), it]));
  listIdx._allPool = coll.items.map(c => listedById.get(c.tokenId)
    || { tokenId: c.tokenId, name: c.name, image: c.image, rarity: c.rarity, rank: c.rank, traits: c.traits, listed: false });
  return listIdx._allPool;
}

// --- Browse view memo -----------------------------------------------------------------
// Filtering, sorting and faceting all run over a snapshot that changes once a minute, yet
// every request redid the lot just to slice out 24 rows: for scope=all that is 11k rows
// re-sorted and 14 facet types re-counted on every keystroke and every "load more". One
// view per (snapshot, query-without-page) turns paging into a slice. It also freezes
// `fetchedAt` to when the DATA was read, which is both more honest than "now" and what
// makes the response body stable enough for its ETag to ever match.
const BROWSE_VIEW_MAX = 64;
const browseViewCache = new Map(); // key -> view; insertion-ordered, so the oldest is first

// The parts are joined on a control character no field can contain: joined bare, a search
// for "ab" with no price floor would key the same as a search for "a" with a floor of "b",
// and one query would then be served the other's rows.
function browseViewKey(kind, stamps, f) {
  const traits = [...f.traits].map(([t, v]) => `${t}=${[...v].sort().join('|')}`).sort().join(';');
  return [kind, stamps.join('.'), f.q, f.min, f.max, f.sort, f.scope, traits].join('\u0001');
}

// `stamps` are the build times of every input the view is derived from — when any of them
// moves, the key moves with it and the old view falls out on its own.
function browseView(kind, stamps, f, build) {
  const key = browseViewKey(kind, stamps, f);
  const hit = browseViewCache.get(key);
  if (hit) { browseViewCache.delete(key); browseViewCache.set(key, hit); return hit; } // re-insert = keep hot
  const view = build();
  if (browseViewCache.size >= BROWSE_VIEW_MAX) browseViewCache.delete(browseViewCache.keys().next().value);
  browseViewCache.set(key, view);
  return view;
}

// A page of rows out of a memoized view, plus the fields every browse response shares.
// Facets are identical for every page of one query and are half the payload, so only
// page 0 carries them — the client keeps the copy it already has.
function browsePage(view, f, extra = {}) {
  const start = f.page * BROWSE_PAGE_SIZE;
  return {
    items: view.matched.slice(start, start + BROWSE_PAGE_SIZE).map(view.strip),
    total: view.matched.length,
    page: f.page,
    hasMore: start + BROWSE_PAGE_SIZE < view.matched.length,
    ...(f.page === 0 ? { facets: view.facets } : {}),
    priceRange: view.priceRange,
    fetchedAt: view.fetchedAt,
    ...extra,
  };
}

async function getCreatureBrowse(searchParams) {
  const f = parseBrowseQuery(searchParams);
  // A full wallet address in the search box switches Browse into "this wallet's holdings".
  if (HEX_ADDRESS.test(f.q)) return getWalletBrowse('creatures', f);
  // An exact public-profile username/slug switches Browse into that profile's collection
  // (union of all their showcase wallets). Exact match only, so it rarely shadows a name search.
  const profMatch = f.q ? await db.findEnabledProfileByQuery(f.q).catch(() => null) : null;
  if (profMatch && profMatch.wallets.length) {
    return getWalletBrowse('creatures', f, { wallets: profMatch.wallets, profile: { name: profMatch.profile.display_name, slug: profMatch.profile.slug } });
  }
  const [listIdx, fx] = await Promise.all([getBrowseIndex(), getMarketplaceFx()]);
  const coll = getCollectionIndex(); // null until the first build lands
  const wantAll = f.scope === 'all';
  const view = browseView('creatures', [browseIndex.at, collectionIndex.at], f, () => {
    const pool = wantAll && coll ? allPoolOf(listIdx, coll) : listedPoolOf(listIdx, coll);
    const matched = pool.filter(it => browseMatch(it, f)).sort(BROWSE_SORTS[f.sort]);
    let lo = null, hi = null;
    for (const it of listIdx.items) {
      const p = it.totalEth ?? it.priceEth;
      if (lo === null || p < lo) lo = p;
      if (hi === null || p > hi) hi = p;
    }
    return {
      matched,
      strip: ({ traits, listedAt, ...pub }) => pub,
      facets: computeBrowseFacets(pool, f),
      priceRange: lo === null ? null : { min: lo, max: hi },
      scope: wantAll && coll ? 'all' : 'listed',
      indexing: wantAll && !coll,                // asked for everything; still cataloguing
      listedTotal: listIdx.items.length,
      collectionTotal: coll?.total ?? null,
      truncated: listIdx.truncated,
      fetchedAt: new Date(browseIndex.at || Date.now()).toISOString(),
    };
  });
  return browsePage(view, f, {
    scope: view.scope,
    indexing: view.indexing,
    listedTotal: view.listedTotal,
    collectionTotal: view.collectionTotal,
    truncated: view.truncated,
    ethUsd: fx.ethUsd,
    fxRates: fx.fxRates,
  });
}

// --- Trait showcase: every trait in the collection, on a Creature that wears it --------
// Browse the collection by trait instead of by token — every Eyes, Hair, Outfit and Aura
// the Creatures were built from, grouped by slot, with how many wear it and a way straight
// into Browse filtered to it. Asked for by the club, and the same view will carry Gen 2's
// traits the day that collection is indexed.
//
// No trait needs art of its own. Every Creature render is the same 666px bust, so the
// client frames a Creature that wears the trait to the right part of the body. WHICH
// Creature is the whole trick: the fewer other add-ons it carries, the less there is to
// cover the trait or pull the eye off it, so the pick takes the plainest wearer — fewest
// non-"None" traits, then the most ordinary of those (rank counts up from the rarest, so
// the highest rank wins). Rank is unique, so the same Creature represents a trait on every
// rebuild.
//
// "None" is not a trait, so those values are left out; each slot reports how many Creatures
// wear anything in it instead. Rarity is a tier rather than a trait, and Browse already has
// its own chips for it, so it's skipped too.
const TRAIT_SKIP = /rarity/i;
const traitShowcase = { forBuild: 0, data: null };

// Where each slot sits on the 666px render, as [centre x, centre y, side]. The tile is
// square and fits the window's longer side, so a window is only ever seen as the smallest
// square around it — these are written square already, so the numbers are what you see.
// null = show the whole render, which is right for anything that isn't in one place: an
// aura wraps the body, a tail hangs off it, a background is all of it.
//
// One definition, three readers: the client frames the full render with it, and
// tools/build-trait-art.py crops the baked tiles to it. Nudging a window here and
// rebuilding the art keeps the two views showing the same thing.
const TRAIT_FRAMES = {
  'Eyes':             [372, 305, 210],
  'Mouth':            [372, 395, 190],
  'Nose':             [372, 352, 165],
  'Glasses':          [372, 330, 245],
  'Face Accessory':   [372, 345, 265],
  'Body':             [372, 350, 300],
  'Ears':             [338, 310, 380],
  'Hair':             [333, 300, 560],
  'Head Accessory':   [340, 220, 440],
  'Outfit':           null,     // a whole look on a whole Creature; a waist-down crop of it
                                // shows trousers and shoes and hides the top half of the outfit
  'Aura':             null,
  'Body Accessory':   null,
  'Background Color': null,
};

// Baked tile art: 240px crops in the `trait_art` table, built by tools/build-trait-art.py.
// The grid shows hundreds of traits at once and a Creature render is 445 KB, so a whole slot
// of crops costs less than two renders. The repo ships none of it, the same as the release
// archive's pictures. Read once per boot into slug -> art_id; a trait with no row (a new one
// between builds, or no database at all) tells the client to frame a Creature render instead,
// which is heavier but never broken.
const slugPart = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const traitSlug = (type, value) => `${slugPart(type)}--${slugPart(value)}`;

// What each Outfit trait is actually made of. An Outfit names a whole look rather than one item —
// "Super Belted Trench Dress Outfit" is a trench dress, a pair of clogs, fishnet socks and undies
// — and the breakdown is worked out by tools/build-outfits.py from the items' own ids. This file
// carries no Highrise ids: item name, category, rarity and the slug its tile is baked under, which
// is all the page needs. Garment slots are synthesised from it, so each piece gets its own tile
// under its own category instead of hiding inside a composite.
const OUTFITS = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'creature-outfits.json'), 'utf8'));
    return raw.outfits || {};
  } catch { return {}; }        // no map built yet — Outfits stay whole, nothing breaks
})();
// A 1/1 character's bespoke parts go into the slot they'd be a trait of, if the collection had
// bothered to record them. Their tokens carry Body, Outfit and Rarity and nothing else, so the
// Eyes slot has no 1/1 value of its own — putting "Zedd Eyes" in it is the only way the ten
// rarest Creatures show up where someone browsing eyes would look for them. Each such tile is
// badged, its card says which look it came out of, and its marketplace link filters on that look,
// because there's still no trait to filter on.
const PIECE_MERGE = {
  eye: 'Eyes', mouth: 'Mouth', nose: 'Nose', freckle: 'Face Accessory',
  hat: 'Head Accessory', hair_front: 'Hair', aura: 'Aura', bag: 'Body Accessory',
};
// Everything else gets a slot of its own, head to toe, with the label it wears on the page.
// `shirt` covers dresses too, hence "Tops". Eyebrows and Handbag exist only as 1/1 parts —
// the collection has no trait slot for either.
const GARMENT_SLOTS = [
  ['eyebrow', 'Eyebrows'], ['shirt', 'Tops'], ['fullsuit', 'Full body'], ['pants', 'Bottoms'],
  ['skirt', 'Skirts'], ['sock', 'Socks'], ['shoes', 'Shoes'], ['handbag', 'Handbag'],
];

let traitArtMap = null;
async function getTraitArtMap() {
  if (traitArtMap) return traitArtMap;
  try {
    const rows = await db.listTraitArt();
    traitArtMap = new Map(rows.map(r => [r.slug, r.art_id]));
    console.log(`Trait tile art: ${traitArtMap.size} row(s).`);
  } catch (err) {
    console.error('Trait tile art unavailable:', err.message);
    traitArtMap = new Map();
  }
  return traitArtMap;
}

function buildTraitShowcase(coll, artMap) {
  const types = new Map(); // type -> Map(value -> { n, pick, addOns })
  for (const it of coll.items) {
    let addOns = 0;
    for (const [type, v] of Object.entries(it.traits)) {
      if (!TRAIT_SKIP.test(type) && v !== 'None') addOns++;
    }
    for (const [type, v] of Object.entries(it.traits)) {
      if (TRAIT_SKIP.test(type) || v === 'None') continue;
      let vals = types.get(type);
      if (!vals) types.set(type, vals = new Map());
      const cur = vals.get(v);
      if (!cur) { vals.set(v, { n: 1, pick: it, addOns }); continue; }
      cur.n++;
      if (addOns < cur.addOns || (addOns === cur.addOns && (it.rank ?? 0) > (cur.pick.rank ?? 0))) {
        cur.pick = it;
        cur.addOns = addOns;
      }
    }
  }
  const out = [];
  for (const [type, vals] of types) {
    // Rarest first: the shortest supply is what a buyer hunting traits wants at the top.
    const values = [...vals.entries()]
      .map(([v, e]) => ({
        v, n: e.n, tokenId: e.pick.tokenId, name: e.pick.name, image: e.pick.image,
        art: artMap.get(traitSlug(type, v)) || null,
        // An Outfit is several garments; hand the page the pieces so its card can show them
        // instead of one crop of a Creature and no explanation of what's in the look. `c` becomes
        // the slot the piece appears in rather than the raw catalogue category, so one lookup
        // serves the label, the chip and the jump from the card back into the grid.
        items: type === 'Outfit' && OUTFITS[v]
          ? OUTFITS[v].map(x => ({ ...x, c: PIECE_MERGE[x.c] || x.c, art: artMap.get(x.s) || null }))
          : undefined,
      }))
      .sort((a, b) => a.n - b.n || a.v.localeCompare(b.v));
    out.push({
      type,
      kind: 'trait',
      frame: TRAIT_FRAMES[type] ?? null,
      count: values.length,
      worn: values.reduce((s, x) => s + x.n, 0),   // one value per slot per Creature, so this sums
      values,
    });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));   // the client orders these head to toe
  mergeParts(out);
  return { types: [...out, ...garmentSlots(out, artMap)], total: coll.total, builtAt: coll.builtAt };
}

// Everything one Creature is actually built from, for its marketplace card: a tile per real
// Highrise item, with the Outfit opened up into the garments it stands for. Head to toe.
//
// Body and Background Color are left out on purpose — a skin colour and a backdrop are not items
// you could hold — and so is Rarity, which is a tier. They're all in the trait list above it
// anyway. "None" means the Creature hasn't got one.
const PART_ORDER = ['Hair', 'Head Accessory', 'Ears', 'Eyes', 'Nose', 'Mouth', 'Face Accessory',
                    'Glasses', 'Outfit', 'Body Accessory', 'Aura'];
const PART_SKIP = new Set(['Body', 'Background Color', 'Rarity']);

function creatureParts(attributes, artMap) {
  const rank = a => { const i = PART_ORDER.indexOf(a.trait); return i === -1 ? PART_ORDER.length : i; };
  const pieceLabel = { ...PIECE_MERGE, ...Object.fromEntries(GARMENT_SLOTS) };
  const out = [];
  for (const a of [...attributes].sort((x, y) => rank(x) - rank(y))) {
    const v = String(a.value ?? '');
    if (!v || v === 'None' || PART_SKIP.has(a.trait)) continue;
    if (a.trait === 'Outfit') {
      // A look is not an item. Its garments are, and creature-outfits.json says which — so the
      // card shows a trench dress, clogs, socks and undies instead of the words for all four.
      for (const x of (OUTFITS[v] || [])) {
        out.push({ n: x.n, slot: pieceLabel[x.c] || x.c, art: artMap.get(x.s) || null, of: v });
      }
      if (!OUTFITS[v]) out.push({ n: v, slot: a.trait, art: artMap.get(traitSlug(a.trait, v)) || null });
      continue;
    }
    out.push({ n: v, slot: a.trait, art: artMap.get(traitSlug(a.trait, v)) || null });
  }
  return out;
}

// The 1/1 parts, dropped into the trait slots they belong to. `count` stays the number of real
// trait values — it's what the page's "466 traits" is summed from — and `parts` counts what was
// added, so a chip can say how many tiles the slot actually shows. `worn` is left alone too: it
// answers how many Creatures have a value recorded in this slot, and these ten haven't.
function mergeParts(traitTypes) {
  const outfit = traitTypes.find(t => t.type === 'Outfit');
  if (!outfit) return;
  const byType = new Map(traitTypes.map(t => [t.type, t]));
  for (const val of outfit.values) {
    for (const x of (val.items || [])) {
      const ty = byType.get(x.c);           // only the merged categories name a trait slot
      if (!ty) continue;
      ty.values.push({ v: x.n, n: val.n, r: x.r, of: val.v, art: x.art, part: true });
      ty.parts = (ty.parts || 0) + 1;
    }
  }
  for (const ty of traitTypes) {
    if (ty.parts) ty.values.sort((a, b) => a.n - b.n || a.v.localeCompare(b.v));
  }
}

// The Outfit slot, turned inside out: one slot per garment category, one tile per piece.
//
// Only the categories with no trait slot to merge into land here (see PIECE_MERGE) — the clothes,
// plus Eyebrows and Handbag, which the collection has no trait for at all.
//
// A piece's numbers are its outfit's, and honestly so — an item belongs to exactly one outfit, so
// the Creatures wearing that outfit are precisely the Creatures wearing the item. The card says
// which outfit it came out of, and the marketplace link filters on that outfit, because the
// collection has no trait for a single garment to filter on.
function garmentSlots(traitTypes, artMap) {
  const outfit = traitTypes.find(t => t.type === 'Outfit');
  if (!outfit) return [];
  const byCat = new Map();
  for (const val of outfit.values) {
    for (const x of (val.items || [])) {
      if (!byCat.has(x.c)) byCat.set(x.c, new Map());
      const seen = byCat.get(x.c).get(x.n);
      if (seen) { seen.n += val.n; continue; }   // a name shared by two looks, if it ever happens
      byCat.get(x.c).set(x.n, { v: x.n, n: val.n, r: x.r, of: val.v, art: artMap.get(x.s) || null });
    }
  }
  const out = [];
  for (const [cat, label] of GARMENT_SLOTS) {
    const vals = byCat.get(cat);
    if (!vals || !vals.size) continue;
    const values = [...vals.values()].sort((a, b) => a.n - b.n || a.v.localeCompare(b.v));
    out.push({ type: cat, kind: 'item', label, frame: null,
      count: values.length, worn: values.reduce((s, x) => s + x.n, 0), values });
  }
  return out;
}

async function getCreatureTraits() {
  const [listIdx, fx, artMap] = await Promise.all([
    getBrowseIndex(), getMarketplaceFx(), getTraitArtMap()]);
  const coll = getCollectionIndex();   // null until the first build lands
  if (!coll) {
    return { indexing: true, total: null, types: [], listedTotal: listIdx.items.length,
      ethUsd: fx.ethUsd, fetchedAt: new Date(browseIndex.at || Date.now()).toISOString() };
  }
  if (traitShowcase.forBuild !== coll.builtAt) {
    traitShowcase.data = buildTraitShowcase(coll, artMap);
    traitShowcase.forBuild = coll.builtAt;
  }
  // Listings are a 60s snapshot against a daily trait build, so "listed now" and the floor
  // are merged per request instead of baked into the memo.
  const live = new Map(); // "type:value" -> { n, floorEth }
  for (const it of listIdx.items) {
    const p = it.totalEth ?? it.priceEth ?? null;
    for (const [type, v] of Object.entries(it.traits)) {
      const k = `${type}:${v}`;
      const cur = live.get(k) || { n: 0, floorEth: null };
      cur.n++;
      if (p != null && (cur.floorEth == null || p < cur.floorEth)) cur.floorEth = p;
      live.set(k, cur);
    }
  }
  return {
    indexing: false,
    total: traitShowcase.data.total,
    types: traitShowcase.data.types.map(ty => ({
      ...ty,
      values: ty.values.map(val => {
        // A garment isn't a trait, so it has no listings of its own: it inherits its outfit's,
        // which is exact — the Creatures wearing that outfit are the ones wearing the piece.
        const l = live.get(ty.kind === 'item' ? `Outfit:${val.of}` : `${ty.type}:${val.v}`);
        return { ...val, listed: l?.n || 0, floorEth: l?.floorEth ?? null };
      }),
    })),
    listedTotal: listIdx.items.length,
    ethUsd: fx.ethUsd,
    // When the DATA was read, not when this response was built: the listing snapshot is
    // the youngest input, and a stable value here is what lets the 164KB body 304.
    fetchedAt: new Date(browseIndex.at || Date.now()).toISOString(),
  };
}

// --- Sales history: recent COMPLETED sales, collection-wide, filtered like Browse ------
// Price discovery beside the active listings: what buyers actually paid, not just what
// sellers ask. The same faceted filter (search / price / traits) the Browse tab uses runs
// over the sold set, so "Cutesy mouth Creatures" or "Premium LAND" narrows the history to
// comparable past sales. All read-only public on-chain data (buyer/seller are wallet
// addresses the explorer already exposes) — no auth, nothing sensitive.

// Every ETH-denominated Creature sale, newest first, briefly cached. Keeps the fields a
// sale card needs (price, when, tx, buyer, seller); traits/name/image are joined per
// request from the collection index, so a metadata refresh never blanks the feed.
const CREATURE_SALES_TTL_MS = 3 * 60 * 1000;
const creatureSalesFeed = { data: null, at: 0, inFlight: null };
async function buildCreatureSalesFeed() {
  const base = `https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/activities`;
  const sales = [];
  await imxPaged(base, { contract_address: CREATURE_CONTRACT, activity_type: 'sale', page_size: '100' }, items => {
    for (const a of items) {
      const d = a.details || {};
      const asset = Array.isArray(d.asset) ? d.asset[0] : d.asset; // sale.asset is an array
      const tokenId = asset?.token_id;
      const p = d.payment;
      // Sales settled in ETH or USDC (either accepted listing currency); ignore any other token.
      const cur = zkCurrencyByAddr(p?.token?.contract_address);
      if (!tokenId || !cur) continue;
      const amt = p.price_including_fees ? unitsToAmount(p.price_including_fees, cur.decimals) : null;
      const at = a.updated_at || a.indexed_at || null;
      if (!Number.isFinite(amt) || amt <= 0 || !at) continue;
      sales.push({
        tokenId: String(tokenId), currency: cur.key, priceAmt: amt,
        priceEth: cur.key === 'eth' ? amt : null, // USDC's ETH-equivalent is added per-sale in shapeSalesHistory
        at,
        tx: a.blockchain_metadata?.transaction_hash || null,
        buyer: (d.to || '').toLowerCase() || null,
        seller: (d.from || '').toLowerCase() || null,
      });
    }
  });
  sales.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return sales;
}
async function getCreatureSalesFeed() {
  const fresh = creatureSalesFeed.data && Date.now() - creatureSalesFeed.at < CREATURE_SALES_TTL_MS;
  if (!fresh && !creatureSalesFeed.inFlight) {
    creatureSalesFeed.inFlight = buildCreatureSalesFeed()
      .then(d => { creatureSalesFeed.data = d; creatureSalesFeed.at = Date.now(); return d; })
      .catch(err => {
        console.error('Creature sales feed build failed:', err.message);
        if (!creatureSalesFeed.data) throw err;
        return creatureSalesFeed.data;
      })
      .finally(() => { creatureSalesFeed.inFlight = null; });
  }
  return creatureSalesFeed.data || creatureSalesFeed.inFlight;
}

/**
 * Every pre-migration Creature sale, newest first — from our own table if they are in it,
 * from immutascan's archive if they are not, in which case they go into the table on the way
 * past. Thirteen thousand settled trades on a rollup that was switched off: read once, kept.
 *
 * `swept` says which of the two happened, because the sweep is also the only thing that can
 * tell us what a dollar was worth on a day in 2022 before those rates are stored.
 */
const imxSales = { rows: null, inFlight: null, swept: false };

async function loadImxSales() {
  const synced = await db.getMarketSync().catch(() => ({}));
  if (synced['imx-sales']) {
    const rows = await db.getCreatureSalesImx().catch(err => {
      console.error('Stored pre-migration sales read failed:', err.message);
      return [];
    });
    if (rows.length) {
      console.log(`Pre-migration sales: ${rows.length} read from store, archive not swept`);
      return rows.map(r => ({
        tokenId: String(r.token_id),
        currency: 'eth',
        priceAmt: Number(r.price_eth),
        priceEth: Number(r.price_eth),
        usdRate: r.usd_rate != null ? Number(r.usd_rate) : null,
        at: r.at,
        // StarkEx had no per-trade hash — immutascan is where a rollup transaction id
        // resolves, and `era` is what sends the client's links there instead of to the
        // zkEVM explorer.
        era: 'imx',
        tx: null,
        txnId: String(r.txn_id),
        buyer: r.buyer,
        seller: r.seller,
      }));
    }
    console.warn('Pre-migration sales: marked stored but the table is empty — sweeping again');
  }
  const rows = await imxArchive.getArchiveSales().catch(() => []);
  if (!rows.length) return [];
  imxSales.swept = true;
  try {
    await db.insertCreatureSalesImx(rows);
    // Sealed only after the write lands, so a failed write means the next boot tries again
    // rather than trusting an empty table.
    await db.setMarketSync('imx-sales', { from: rows[rows.length - 1].at.slice(0, 10), to: rows[0].at.slice(0, 10), rows: rows.length });
    console.log(`Pre-migration sales: ${rows.length} stored — archive not swept again`);
  } catch (err) {
    console.error('Pre-migration sales write failed:', err.message);
  }
  return rows;
}

function getImxSales() {
  if (imxSales.rows) return Promise.resolve(imxSales.rows);
  if (!imxSales.inFlight) {
    imxSales.inFlight = loadImxSales()
      .then(rows => { imxSales.rows = rows; return rows; })
      .catch(err => { console.error('Pre-migration sales failed:', err.message); return []; })
      .finally(() => { imxSales.inFlight = null; });
  }
  return imxSales.inFlight;
}

// zkEVM sales + the StarkEx years that came before them, one list. Creatures traded on
// Immutable X from 2021 until the July 2025 migration, and that's most of the collection's
// price history — a "sales history" that starts at the migration would be showing a member
// the last year of a five-year market. Token ids carried over 1:1, so the two eras join on
// the same catalogue and filter identically. The archive is only ever additive: if its
// sweep hasn't landed (or never lands), this is exactly the live feed.
const mergedSalesFeed = { rows: null, liveAt: 0, archiveN: -1 };
async function getCreatureSalesWithArchive() {
  const [live, archived] = await Promise.all([
    getCreatureSalesFeed(),
    getImxSales(),
  ]);
  if (!archived.length) return live;
  // Both inputs only change when one of them is rebuilt, so merge once and keep it: this
  // runs on every request, and re-sorting fourteen thousand settled sales per page view is
  // work with a known answer.
  const m = mergedSalesFeed;
  if (!m.rows || m.liveAt !== creatureSalesFeed.at || m.archiveN !== archived.length) {
    m.rows = [...live, ...archived].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    m.liveAt = creatureSalesFeed.at;
    m.archiveN = archived.length;
  }
  return m.rows;
}
// Warm the pre-migration sales at boot so the first visitor to the Sales tab isn't the one
// who waits. Once they are stored that is a single query; the first time, it is ~70 paged
// calls to the archive, and those carry the only ETH/USD rates we have for the years before
// CoinGecko's free window — so on that one run, anything already built without them is
// thrown away and rebuilt. Nobody waits on it: the market snapshot serves its old copy while
// the new one is being made.
dbReady.then(() => getImxSales())
  .then(() => {
    if (!imxSales.swept) return; // rates already come from the store
    // Drop the table rather than just ageing it: an aged one is still served while the
    // replacement is fetched, and the market snapshot would rebuild against the old rates.
    ethUsdDailyCache.data = null;
    ethUsdDailyCache.at = 0;
    return getEthUsdDaily()
      // Rebuild the market snapshot ourselves rather than leaving it to the next visitor: an
      // expired cache is served while it refreshes, so a visitor would read the old copy.
      .then(() => { marketCache.fetchedAt = 0; return getMarketStats(); });
  })
  .catch(() => {});

// Sales-history sort — its own small set (Browse's price-asc default makes no sense for a
// time-ordered log). Recent first by default.
const SALES_SORTS = {
  recent:       (a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0),
  oldest:       (a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0),
  'price-asc':  (a, b) => a.priceEth - b.priceEth,
  'price-desc': (a, b) => b.priceEth - a.priceEth,
};
function parseSalesSort(searchParams) {
  const s = searchParams.get('sort');
  return SALES_SORTS[s] ? s : 'recent';
}

// --- Sales price series: the same matched set, plotted over time --------------------------
// The card list answers "what sold"; the chart answers "for how much, and which way is it
// moving" — the question a filter like `t=Eyes:Cutesy` is really being asked. It's built
// from the WHOLE matched set (not the page on screen), so narrowing to one trait plots
// every sale that trait ever had, and it rides along with page 0 like the facets do.
const SALES_SERIES_MAX_POINTS = 400;   // a scatter past this is a smear; sample it evenly
const SALES_SERIES_DETAIL_MAX = 300;   // above this, dots are a cloud — drop the per-sale label

// Bucket width for the trend line: enough buckets to show a shape, few enough to mean
// something. A three-week window buckets by day, five years by month.
function salesBucketSize(spanMs) {
  const days = spanMs / DAY_MS;
  if (days <= 90) return { key: 'day', ms: DAY_MS };
  if (days <= 730) return { key: 'week', ms: 7 * DAY_MS };
  return { key: 'month', ms: 0 }; // calendar months — width varies, so keyed by date
}
const monthStart = ts => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

const round6 = n => (n == null ? null : Math.round(n * 1e6) / 1e6);
const round2 = n => (n == null ? null : Math.round(n * 100) / 100);
function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A price-over-time series for a filtered sales set: every sale as a point, plus a bucketed
 * average for the trend line, plus the headline stats. Null when nothing priced matched —
 * the client hides the chart rather than drawing an empty axis.
 *
 * Prices ride in BOTH currencies per point (ETH and the USD it was worth on its own day),
 * because the display currency is the client's to choose and re-picking it must not cost a
 * round trip. Sales with no ETH-equivalent (a USDC sale on a day with no rate) are dropped:
 * a point that can't be valued is worse than a gap.
 */
// Every priceable matched sale as a bare {t, eth, usd} point, oldest first. Kept on the
// memoized view, because both the chart and any later "what about just this window" question
// are slices of exactly this list.
function salesPricePoints(matched) {
  const pts = [];
  for (const r of matched) {
    const t = Date.parse(r.at) || 0;
    if (!t || !Number.isFinite(r.priceEth) || r.priceEth <= 0) continue;
    pts.push({ t, eth: r.priceEth, usd: r.priceUsd ?? null, id: r.tokenId, name: r.name });
  }
  return pts.sort((a, b) => a.t - b.t);
}

/** The six headline figures over a set of price points, in both currencies. */
function salesStatsOf(pts) {
  if (!pts.length) return null;
  const ethSorted = pts.map(p => p.eth).sort((a, b) => a - b);
  // Sorted, so min/max/median all read straight off the ends and the middle — and no
  // Math.min(...arr) spread, which would put fourteen thousand arguments on the stack.
  const usdSorted = pts.map(p => p.usd).filter(v => v != null).sort((a, b) => a - b);
  const usdSum = usdSorted.reduce((sum, v) => sum + v, 0);
  return {
    n: pts.length,
    loEth: round6(ethSorted[0]), hiEth: round6(ethSorted[ethSorted.length - 1]),
    avgEth: round6(ethSorted.reduce((sum, v) => sum + v, 0) / ethSorted.length),
    medEth: round6(median(ethSorted)),
    volEth: round6(ethSorted.reduce((sum, v) => sum + v, 0)),
    avgUsd: usdSorted.length ? round2(usdSum / usdSorted.length) : null,
    medUsd: usdSorted.length ? round2(median(usdSorted)) : null,
    loUsd: usdSorted.length ? round2(usdSorted[0]) : null,
    hiUsd: usdSorted.length ? round2(usdSorted[usdSorted.length - 1]) : null,
    volUsd: usdSorted.length ? round2(usdSum) : null,
  };
}

function buildSalesSeries(pts) {
  if (!pts.length) return null;
  const from = pts[0].t, to = pts[pts.length - 1].t;
  const bucket = salesBucketSize(Math.max(to - from, 1));
  const acc = new Map(); // bucket start ms -> running aggregate
  for (const p of pts) {
    const k = bucket.ms ? Math.floor(p.t / bucket.ms) * bucket.ms : monthStart(p.t);
    let a = acc.get(k);
    if (!a) acc.set(k, a = { t: k, n: 0, sumT: 0, sumEth: 0, sumUsd: 0, usdN: 0, lo: Infinity, hi: -Infinity });
    a.n++; a.sumT += p.t; a.sumEth += p.eth; a.lo = Math.min(a.lo, p.eth); a.hi = Math.max(a.hi, p.eth);
    if (p.usd != null) { a.sumUsd += p.usd; a.usdN++; }
  }
  const buckets = [...acc.values()].sort((a, b) => a.t - b.t).map(a => ({
    t: a.t, n: a.n,
    // Where the line's point goes: the average MOMENT of the sales in this bucket, not the
    // bucket's own start. Stamped at the start, a monthly bucket holding one sale on the 30th
    // drew its point on the 1st — so the trend line stopped a month short of the last dot at
    // one end and was clipped off the axis at the other.
    mid: Math.round(a.sumT / a.n),
    avgEth: round6(a.sumEth / a.n),
    avgUsd: a.usdN ? round2(a.sumUsd / a.usdN) : null,
    loEth: round6(a.lo), hiEth: round6(a.hi),
    volEth: round6(a.sumEth),
  }));

  // Sample evenly rather than truncating: a capped scatter must still span the whole
  // window, and the first and last sale are the two points anyone looks for. Spread the
  // survivors across the cap instead of striding — 644 sales at stride 2 would throw away
  // half a set that nearly fits.
  const sampled = pts.length > SALES_SERIES_MAX_POINTS;
  const kept = sampled
    ? Array.from({ length: SALES_SERIES_MAX_POINTS },
        (_, i) => pts[Math.round(i * (pts.length - 1) / (SALES_SERIES_MAX_POINTS - 1))])
    : pts;
  // Which asset a dot is only matters while dots are still individually readable. Past a
  // few hundred the chart is a cloud you read as a whole, and 39-digit token ids for every
  // one of them would be most of the response.
  const detail = pts.length <= SALES_SERIES_DETAIL_MAX;
  return {
    from, to, bucket: bucket.key, sampled, shown: kept.length, detail,
    points: kept.map(p => (detail
      ? { t: p.t, e: round6(p.eth), u: round2(p.usd), id: p.id, n: p.name }
      : { t: p.t, e: round6(p.eth), u: round2(p.usd) })),
    buckets,
    stats: salesStatsOf(pts),
  };
}

// A zoom on the chart is a question about a period, so `from`/`to` (ms) ask for the same six
// figures over just that slice. Exact, not derived from the drawn scatter: past a few hundred
// matches that scatter is a sample, and a sampled "volume" would be a fraction of the truth.
function parseSalesWindow(searchParams) {
  const ms = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const from = ms(searchParams.get('from')), to = ms(searchParams.get('to'));
  return from != null && to != null && to > from ? { from, to } : null;
}

// Shared shaper: enrich each raw sale with catalogue metadata (name/image/traits/rank),
// value it in USD at its own day's rate, filter by the Browse query, sort, paginate. A
// full wallet address in `q` matches the buyer OR seller instead of the name.
function shapeSalesHistory(feed, f, sortKey, meta, win) {
  const rate = ts => (meta.daily && ts ? meta.daily.at(ts) : null) ?? meta.ethUsd ?? null;
  // Memoized on the same terms as Browse: one view per (data snapshot, query-without-page).
  // It matters more here than it did — the Creature feed grew from a few hundred live sales
  // to fourteen thousand once the pre-migration archive joined it, and re-shaping and
  // re-facetting the lot to slice out 24 rows is not something to redo per "load more".
  const view = browseView(`${meta.kind}:${sortKey}`, meta.stamps, f, () => buildSalesView(feed, f, sortKey, meta, rate));
  // A window query wants the numbers, not the page: same filters, same memoized view, one
  // slice by time. Answering it here rather than on its own route means it can't drift from
  // what the chart is drawing.
  if (win) {
    const inWindow = view.pricePoints.filter(p => p.t >= win.from && p.t <= win.to);
    // The drawing as well as the figures. Page 0's scatter is an even sample of the WHOLE
    // matched set, so on a big set a six-month window inherits about eight of its four
    // hundred dots: a true picture of nothing much. Re-sampled over the window it gets its
    // own four hundred, its own bucket size for the trend line, and — a window being small
    // enough to count — a label on every dot again.
    return {
      window: win,
      stats: salesStatsOf(inWindow),
      series: buildSalesSeries(inWindow),
      fetchedAt: view.fetchedAt,
    };
  }
  return browsePage(view, f, {
    ethUsd: meta.ethUsd,
    fxRates: meta.fxRates,
    // The chart describes the whole matched set, so it's the same for every page of one
    // query. Like the facets, it rides with page 0 and the client keeps its copy.
    ...(f.page === 0 && view.series ? { series: view.series } : {}),
  });
}

function buildSalesView(feed, f, sortKey, meta, rate) {
  const rows = feed.map(s => {
    const known = meta.lookup(s.tokenId);
    const ts = Date.parse(s.at) || 0;
    // A sale that knows the ETH/USD rate it happened at (the pre-migration archive records
    // one per trade) is valued with it: our daily table only reaches back a year and would
    // otherwise price a 2022 sale at last September's rate.
    const usd = s.usdRate ?? rate(ts);
    // Is this token listed RIGHT NOW? (drives the "For sale / Not listed" badge + the
    // in-marketplace deep link.) meta.listed returns the current all-in list price or null.
    const listedNow = meta.listed ? (meta.listed(s.tokenId) ?? null) : null;
    // Currency-aware valuation: a USDC sale's USD is its dollar amount 1:1 and its ETH-
    // equivalent (the sort/compare key) is amount / that day's ETH-USD; an ETH sale is the
    // mirror. priceAmt/currency ride through for the client's currency-aware display.
    const isUsdc = s.currency === 'usdc';
    const priceEth = isUsdc ? (usd ? Math.round(s.priceAmt / usd * 1e6) / 1e6 : null) : s.priceEth;
    const priceUsd = isUsdc ? s.priceAmt : (usd != null && s.priceEth != null ? Math.round(s.priceEth * usd * 100) / 100 : null);
    // Catalogue metadata wins for traits/rank; name/image/coords fall back to whatever the
    // raw feed already carried (OpenSea LAND events ship these; Immutable sales don't).
    return {
      ...s,
      name: known?.name || s.name || meta.fallbackName(s.tokenId),
      image: known?.image || s.image || null,
      rarity: known?.rarity || null,
      rank: known?.rank ?? null,
      coords: known?.coords || s.coords || null,
      traits: known?.traits || {},
      search: known?.search || known?.name || s.name || '',
      currency: s.currency || 'eth',
      priceAmt: s.priceAmt ?? s.priceEth,
      priceEth,
      priceUsd,
      listedNow,
    };
  });
  const isAddr = HEX_ADDRESS.test(f.q);
  const fq = isAddr ? { ...f, q: '' } : f; // wallet query is handled below, not as a name match
  const matched = rows.filter(r =>
    (!isAddr || r.buyer === f.q || r.seller === f.q) && browseMatch(r, fq)
  ).sort(SALES_SORTS[sortKey]);
  const pricePoints = salesPricePoints(matched);
  return {
    matched,
    // usdRate did its job in the shaper above (it valued the sale); priceUsd is what the
    // client reads, so the rate itself stays server-side.
    strip: ({ search, usdRate, ...pub }) => pub,
    facets: computeBrowseFacets(rows, fq),
    // Never serialized — browsePage picks the response's fields by name. This is here so a
    // window query is a filter over a list that already exists.
    pricePoints,
    series: buildSalesSeries(pricePoints),
    // The sales feed's own cache time: when the DATA was read, not when this response was
    // assembled, so paging through settled history doesn't churn the response's validator.
    fetchedAt: new Date(meta.at || Date.now()).toISOString(),
  };
}

async function getCreatureSalesHistory(searchParams) {
  const f = parseBrowseQuery(searchParams);
  const sortKey = parseSalesSort(searchParams);
  const win = parseSalesWindow(searchParams);
  const [feed, fx, daily, listIdx] = await Promise.all([getCreatureSalesWithArchive(), getMarketplaceFx(), getEthUsdDaily(), getBrowseIndex()]);
  const coll = getCollectionIndex(); // null until the first catalogue build lands
  const listedMap = new Map((listIdx?.items || []).map(it => [String(it.tokenId), it.totalEth ?? it.priceEth]));
  return shapeSalesHistory(feed, f, sortKey, {
    kind: 'sales:creatures',
    // Every input the view is derived from: the live feed's read time, the catalogue build,
    // and how many archived rows have landed (0 before the sweep finishes, fixed after).
    stamps: [creatureSalesFeed.at, collectionIndex.at, feed.length],
    at: creatureSalesFeed.at,
    daily, ethUsd: fx.ethUsd, fxRates: fx.fxRates,
    lookup: id => coll?.byId.get(String(id)) || null,
    listed: id => listedMap.get(String(id)) ?? null,
    fallbackName: id => `Highrise Creature #${id}`,
  }, win);
}

// --- Unified LAND browse: every parcel, shown via its attached Slime ---
// A LAND parcel and its Slime are ONE NFT — you buy the parcel, the slime comes with
// it — so there's a single faceted browse: filter parcels by their slime's traits +
// rarity rank, price/buyability from the parcel's OpenSea listing. The catalogue
// (traits, rank) comes from the background slime sweep (lib/slime-index); listings come
// from OpenSea. Reuses the Creature browse machinery (parseBrowseQuery / browseMatch /
// computeBrowseFacets / BROWSE_SORTS) by shaping each parcel into the same row contract.
slimeIndex.getSlimeIndex(); // warm the sweep at boot, in the background

// All active LAND listings as Map<tokenId, listing>, briefly cached — merged into the
// parcel rows so a listed parcel shows its price and is buyable.
const slimeListingsCache = { data: null, at: 0 };
const LAND_LISTINGS_TTL_MS = 30 * 1000; // shorter than Creatures: OpenSea indexes new listings within seconds
// `force` bypasses the cache READ (still refreshes it) — used right after a listing is
// created so the freshly-indexed order overwrites any cached "not listed yet" snapshot.
async function landListingsByToken(force = false) {
  if (!force && slimeListingsCache.data && Date.now() - slimeListingsCache.at < LAND_LISTINGS_TTL_MS) return slimeListingsCache.data;
  const map = new Map();
  if (landMarket.configured()) {
    let cursor = '', pages = 0;
    do {
      const { items, nextCursor } = await landMarket.listListings(cursor);
      for (const it of items) if (!map.has(String(it.tokenId))) map.set(String(it.tokenId), it);
      cursor = nextCursor;
    } while (cursor && ++pages < 20);
  }
  slimeListingsCache.data = map; slimeListingsCache.at = Date.now();
  return map;
}

// Shape a parcel + its (optional) listing into a browse row. Mixed-currency: an ETH listing's
// native amount IS its ETH-equivalent; a USDC listing is dollar-denominated, so its ETH-
// equivalent (used for sort/floor/the modal's all-in gate) is amount / ethUsd, and its USD
// estimate is the amount itself. `ethUsd` comes from the marketplace FX (getLandBrowse).
const landRowOf = (s, L, ethUsd = null) => {
  let currency, priceAmt = null, totalEth = null, priceUsd = null;
  if (L) {
    currency = L.currency || 'eth';
    priceAmt = L.priceAmt != null ? L.priceAmt : L.priceEth;
    if (currency === 'usdc') {
      priceUsd = priceAmt;
      totalEth = ethUsd ? round4(priceAmt / ethUsd) : null;
    } else {
      totalEth = priceAmt;
      priceUsd = ethUsd ? Math.round(priceAmt * ethUsd) : null;
    }
  }
  return {
    tokenId: s.tokenId,
    coords: s.coords,
    name: s.slimeName || s.parcelName,
    slimeName: s.slimeName,
    parcelName: s.parcelName,
    search: `${s.slimeName || ''} ${s.parcelName} ${s.coords.x} ${s.coords.y}`,
    traits: s.traits,
    rank: s.rank,
    listed: !!L,
    currency: L ? currency : undefined,
    priceAmt, totalAmt: priceAmt,
    priceUsd,
    priceEth: L ? totalEth : null,
    totalEth, // ETH-equivalent (all-in) — the sort/floor key
    listingId: L ? L.orderHash : null,
    protocolAddress: L ? L.protocolAddress : null,
    seller: L ? L.seller : null,
    listedAt: 0,
  };
};
// A listed parcel the slime catalogue doesn't know yet (still sweeping, or the rare
// parcel with no pet) must still appear for sale — just without traits/rank.
const listingRowOf = (tokenId, L, ethUsd = null) => landRowOf({
  tokenId, coords: L.coords || {}, slimeName: null,
  parcelName: L.name || `LAND #${tokenId}`, traits: {}, rank: null,
}, L, ethUsd);

async function getLandBrowse(searchParams) {
  const f = parseBrowseQuery(searchParams);
  if (HEX_ADDRESS.test(f.q)) return getWalletBrowse('land', f);
  const profMatch = f.q ? await db.findEnabledProfileByQuery(f.q).catch(() => null) : null;
  if (profMatch && profMatch.wallets.length) {
    return getWalletBrowse('land', f, { wallets: profMatch.wallets, profile: { name: profMatch.profile.display_name, slug: profMatch.profile.slug } });
  }
  const [fx, listings] = await Promise.all([getMarketplaceFx(), landListingsByToken()]);
  const index = slimeIndex.getSlimeIndex(); // null while the first sweep runs

  // Same memo as Creatures, and LAND needs it more: without one, every request rebuilt a
  // row for all ~3,000 parcels before sorting and faceting them.
  const view = browseView('land', [index?.builtAt ?? 0, slimeListingsCache.at], f, () => {
    const rows = [];
    const seen = new Set();
    if (index) for (const s of index.items) { seen.add(String(s.tokenId)); rows.push(landRowOf(s, listings.get(String(s.tokenId)), fx.ethUsd)); }
    // Listed parcels missing from the catalogue still show for sale (completeness — a
    // marketplace must never hide a buyable item behind an unfinished index).
    for (const [tokenId, L] of listings) if (!seen.has(tokenId)) rows.push(listingRowOf(tokenId, L, fx.ethUsd));

    const wantAll = f.scope === 'all';
    const pool = wantAll ? rows : rows.filter(r => r.listed);
    const matched = pool.filter(it => browseMatch(it, f)).sort(BROWSE_SORTS[f.sort]);
    let lo = null, hi = null;
    for (const r of rows) {
      if (r.totalEth == null) continue;
      if (lo === null || r.totalEth < lo) lo = r.totalEth;
      if (hi === null || r.totalEth > hi) hi = r.totalEth;
    }
    // Attach a collection-wide rarity % to every trait value: the share of ALL catalogued
    // slimes that carry it. It's a stable property of the collection, so it's read from the
    // index's traitFreq (not the filtered pool) — `n` already tells "how many match now".
    const facets = index ? computeBrowseFacets(pool, f) : [];
    if (index && index.total) for (const facet of facets) for (const val of facet.values) {
      const c = index.traitFreq.get(`${facet.type}:${val.v}`);
      if (c != null) { val.total = c; val.pct = c / index.total; }
    }
    return {
      matched,
      // traits stay on the row (only a few small fields) so the modal needs no extra fetch.
      strip: ({ search, listedAt, ...pub }) => pub,
      facets,
      priceRange: lo === null ? null : { min: lo, max: hi },
      scope: wantAll ? 'all' : 'listed',
      // 'all' needs the full catalogue; until it's built we can only show listed parcels.
      indexing: !index,
      listedTotal: rows.reduce((n, r) => n + (r.listed ? 1 : 0), 0),
      collectionTotal: index ? index.total : null,
      fetchedAt: new Date(index?.builtAt || Date.now()).toISOString(),
    };
  });
  return browsePage(view, f, {
    scope: view.scope,
    indexing: view.indexing,
    listedTotal: view.listedTotal,
    collectionTotal: view.collectionTotal,
    ethUsd: fx.ethUsd,
    fxRates: fx.fxRates,
  });
}

// LAND sales feed (OpenSea collection events), briefly cached. Traits/rank are joined per
// request from the slime catalogue, so a parcel the sweep hasn't reached yet still shows
// its sale (price/date/wallets) — just without trait facets, same as LAND browse.
const LAND_SALES_TTL_MS = 3 * 60 * 1000;
const landSalesFeed = { data: null, at: 0, inFlight: null };
async function getLandSalesFeed() {
  const fresh = landSalesFeed.data && Date.now() - landSalesFeed.at < LAND_SALES_TTL_MS;
  if (!fresh && !landSalesFeed.inFlight) {
    landSalesFeed.inFlight = landMarket.collectionSales()
      .then(d => { landSalesFeed.data = d; landSalesFeed.at = Date.now(); return d; })
      .catch(err => {
        console.error('LAND sales feed build failed:', err.message);
        if (!landSalesFeed.data) throw err;
        return landSalesFeed.data;
      })
      .finally(() => { landSalesFeed.inFlight = null; });
  }
  return landSalesFeed.data || landSalesFeed.inFlight;
}

async function getLandSalesHistory(searchParams) {
  const f = parseBrowseQuery(searchParams);
  const sortKey = parseSalesSort(searchParams);
  const win = parseSalesWindow(searchParams);
  const [feed, fx, daily, listings] = await Promise.all([getLandSalesFeed(), getMarketplaceFx(), getEthUsdDaily(), landListingsByToken()]);
  const index = slimeIndex.getSlimeIndex(); // null while the first sweep runs
  const data = shapeSalesHistory(feed, f, sortKey, {
    kind: 'sales:land',
    stamps: [landSalesFeed.at, index?.builtAt ?? 0, feed.length],
    at: landSalesFeed.at,
    daily, ethUsd: fx.ethUsd, fxRates: fx.fxRates,
    listed: id => { const L = listings.get(String(id)); if (!L) return null; return L.currency === 'usdc' ? (fx.ethUsd ? Math.round(L.priceAmt / fx.ethUsd * 1e4) / 1e4 : null) : (L.priceEth ?? L.priceAmt ?? null); },
    // The OpenSea event already carries name/image/coords; the catalogue adds traits + rank.
    lookup: id => {
      const s = index?.byToken.get(String(id));
      return s ? { name: s.slimeName || s.parcelName, traits: s.traits, rank: s.rank,
        coords: s.coords, search: `${s.slimeName || ''} ${s.parcelName} ${s.coords?.x ?? ''} ${s.coords?.y ?? ''}` } : null;
    },
    fallbackName: id => `Highrise LAND #${id}`,
  }, win);
  // Attach a collection-wide trait % (as LAND browse does) so the shared filter bar shows
  // the same rarity tags on the Sales tab.
  if (index && index.total) for (const facet of data.facets || []) for (const val of facet.values) {
    const c = index.traitFreq.get(`${facet.type}:${val.v}`);
    if (c != null) { val.total = c; val.pct = c / index.total; }
  }
  return data;
}

// --- Wallet view: paste an address into Browse search → that wallet's holdings ------------
// Public on-chain data (the same owner index OpenSea/Immutable already expose, and the
// site already surfaces per-token). We show EVERY asset the wallet holds — listed AND
// unlisted — joined with any live listing so a for-sale item keeps its price and stays
// buyable. NOTE: only on-chain assets, never any off-chain identity (Discord/Highrise) —
// that mapping must never reach the client. Owned rows are cached briefly per address so
// paging (which re-requests the same wallet) doesn't re-hit the upstream indexer each page.
const ownedPoolCache = new Map(); // `${collKind}:${addr}` -> { at, rows }
const OWNED_POOL_TTL_MS = 45 * 1000;

// Every Creature a wallet holds, as browse rows. Listings/traits are keyed by the real
// on-chain token id, which MATCHES the account endpoint's id — so a wallet's listed items
// join cleanly for price + buyability. (The COLLECTION catalogue's ids differ, so its
// statistical rank is only a best-effort overlay; absent → the tile just shows no rank.)
async function ownedCreatureRows(addr) {
  const [{ items }, listIdx] = await Promise.all([getOwnedCreatures(addr), getBrowseIndex()]);
  const coll = getCollectionIndex();
  const byListing = new Map(listIdx.items.map(it => [String(it.tokenId), it]));
  return items.map(o => {
    const id = String(o.tokenId);
    const L = byListing.get(id);
    const known = coll?.byId.get(id);
    // Prefer the collection/listing index's NORMALIZED traits (the same clean, title-cased
    // set collection-mode browse uses) over the raw owned-metadata `o.traits`, which carries
    // duplicate lower-cased keys + an `attributes` blob and would pollute the facet list with
    // "aura"+"Aura" style dupes. Traits are immutable, so the index is authoritative; raw
    // metadata is only a last resort for a token the index hasn't catalogued yet.
    const traits = known?.traits || L?.traits || (Object.keys(o.traits || {}).length ? o.traits : {});
    return {
      tokenId: id,
      name: o.name || L?.name || known?.name || `Highrise Creature #${id}`,
      image: o.image || L?.image || known?.image || null,
      rarity: Object.entries(traits).find(([k]) => /rarity/i.test(k))?.[1] || null,
      rank: known?.rank ?? null,
      traits,
      listed: !!L,
      listingId: L?.listingId || null,
      seller: L?.seller || null,
      priceEth: L?.priceEth ?? null,
      totalEth: L?.totalEth ?? null,
      listedAt: L?.listedAt ?? 0,
    };
  });
}

// Every LAND parcel a wallet holds, as browse rows. Token ids come straight from the
// contract (see landOwnedOnChain); coords/traits/rank come from the slime sweep and the
// listing (price) from OpenSea — the same joins /land/owned and getLandBrowse already do.
// Estate-locked parcels live in the estate contract, so they're naturally absent here.
async function ownedLandRows(addr) {
  let items;
  try {
    items = await landOwnedOnChain(addr);
  } catch (err) {
    console.error('Wallet LAND chain read failed, falling back to OpenSea:', err.message);
    items = landMarket.configured() ? (await landMarket.ownedLand(addr)).items : [];
  }
  const [listings, fx] = await Promise.all([landListingsByToken(), getMarketplaceFx()]);
  const sidx = slimeIndex.getSlimeIndex();
  return items.map(it => {
    const id = String(it.tokenId);
    const s = sidx?.byToken.get(id);
    const L = listings.get(id);
    const parcelName = s?.coords ? `Highrise LAND (${s.coords.x}, ${s.coords.y})` : (it.name || `Highrise LAND #${id}`);
    return landRowOf({
      tokenId: id, coords: s?.coords || it.coords || { x: '', y: '' },
      slimeName: s?.slimeName || null, parcelName, traits: s?.traits || {}, rank: s?.rank ?? null,
    }, L, fx.ethUsd);
  });
}

// One wallet's owned rows, cached per address (so paging + multi-wallet unions don't
// re-hit the indexer). The cached rows are untagged; callers add wallet/source.
async function ownedRowsFor(collKind, addr) {
  const cacheKey = `${collKind}:${addr}`;
  const hit = ownedPoolCache.get(cacheKey);
  // Rows built while the enriching catalogue was cold carry degraded traits/names.
  // Once the catalogue warms, such an entry is stale regardless of TTL — rebuild it,
  // or the client's "indexing" re-poll would keep seeing the degraded copy.
  const warm = collKind === 'land' ? !!slimeIndex.getSlimeIndex() : !!getCollectionIndex();
  if (hit && Date.now() - hit.at < OWNED_POOL_TTL_MS && !(warm && hit.degraded)) return hit.rows;
  const rows = collKind === 'land' ? await ownedLandRows(addr) : await ownedCreatureRows(addr);
  if (ownedPoolCache.size > 300) ownedPoolCache.clear(); // bound memory from many distinct addresses
  ownedPoolCache.set(cacheKey, { at: Date.now(), rows, degraded: !warm });
  return rows;
}

// Holdings browse for ONE or MANY wallets. `opts.wallets` is [{wallet, source}] — the
// union is shown as one grid, each row tagged with its wallet + source so the client can
// badge/filter by "which wallet". Defaults to the single raw address typed in the search
// box. `opts.profile` (when a search matched a public profile) rides back as `ownerProfile`.
async function getWalletBrowse(collKind, f, opts = {}) {
  let walletSpec = (opts.wallets && opts.wallets.length)
    ? opts.wallets
    : [{ wallet: f.q, source: 'wallet' }];
  // De-dupe by address so a wallet listed twice can never fetch (and duplicate) its NFTs.
  const byAddr = new Map();
  for (const w of walletSpec) { const a = String(w.wallet).toLowerCase(); if (!byAddr.has(a)) byAddr.set(a, { ...w, wallet: a }); }
  walletSpec = [...byAddr.values()];
  const perWallet = await Promise.all(walletSpec.map(async w => {
    const owned = await ownedRowsFor(collKind, w.wallet);
    // Tag each row with its wallet + trust tier so the client can badge per tile.
    return owned.map(r => ({ ...r, wallet: w.wallet, verified: !!w.verified, highriseLinked: !!w.highriseLinked }));
  }));
  const rows = perWallet.flat();
  const fx = await getMarketplaceFx();
  const fq = { ...f, q: '' }; // the wallet(s) select the pool; q is not a name substring here
  const pool = f.scope === 'listed' ? rows.filter(r => r.listed) : rows;
  const matched = pool.filter(it => browseMatch(it, fq)).sort(BROWSE_SORTS[f.sort]);
  let lo = null, hi = null;
  for (const r of rows) { const p = r.totalEth; if (p == null) continue; if (lo === null || p < lo) lo = p; if (hi === null || p > hi) hi = p; }
  const listedCount = rows.reduce((n, r) => n + (r.listed ? 1 : 0), 0);
  // Match each collection's existing wire shape: LAND keeps `traits` on the row (its modal
  // reads them); Creatures strip them (their modal refetches token detail). Both keep the
  // new wallet/source tags via the spread.
  const strip = collKind === 'land'
    ? ({ search, listedAt, ...pub }) => pub
    : ({ traits, listedAt, ...pub }) => pub;
  // Paged and faceted like collection browse (facets on page 0 only), but not memoized:
  // the costly part is the upstream holdings read, and that already has its own pool cache.
  return browsePage({
    matched, strip,
    facets: computeBrowseFacets(pool, fq),
    priceRange: lo === null ? null : { min: lo, max: hi },
    fetchedAt: new Date().toISOString(),
  }, f, {
    scope: f.scope,
    owner: walletSpec.length === 1 && walletSpec[0].source === 'wallet' ? walletSpec[0].wallet : null,
    ownerProfile: opts.profile || null,
    walletCount: walletSpec.length,
    ownedTotal: rows.length,
    ownedListed: listedCount,
    // Traits/ranks (and LAND slime names) come from the background catalogues — until
    // they're warm this response degrades (raw/absent traits, parcel-only names), so
    // tell the client it's worth a quiet re-poll, same as collection-mode browse.
    indexing: collKind === 'land' ? !slimeIndex.getSlimeIndex() : !getCollectionIndex(),
    listedTotal: listedCount,
    collectionTotal: rows.length,
    ethUsd: fx.ethUsd,
    fxRates: fx.fxRates,
  });
}

// Public marketplace API — browse only (no auth, no wallet, nothing sensitive).
// --- Transak card on-ramp (secure widget URL) — CURRENTLY INACTIVE ------------------------
// This is the "mint through OUR OWN Transak partner account" path. It's NOT wired into the
// on-ramp handler: that routes through Immutable's hosted checkout instead (immutableOnrampUrl
// below), which rides Immutable's account and needs no creds of ours. Our account's session API
// returns 401 errorCode 1002 pending Transak activation / backend-IP allowlisting. Kept for a
// possible future switch to our own account (fee capture); see the on-ramp note in README.md.
//
// Transak deprecated query-param widget URLs (June 2026 migration): every direct
// global.transak.com/?apiKey=… link now fails with a generic error. The widget loads only
// with a sessionId minted by a backend call. We run Transak's two-step flow — refresh-token →
// create-session — entirely server-side (the secret never leaves here) and hand the client a
// short-lived (5 min, single-use) widget URL. Staging keys work only on the -stg hosts.
const TRANSAK_HOSTS = TRANSAK_ENV === 'staging'
  ? { auth: 'https://api-stg.transak.com', gateway: 'https://api-gateway-stg.transak.com' }
  : { auth: 'https://api.transak.com',     gateway: 'https://api-gateway.transak.com' };
const transakOnrampConfigured = () => !!(TRANSAK_API_KEY && TRANSAK_API_SECRET);

// Partner access token: valid ~7 days, but Transak honours only the LATEST issued token, so a
// refresh elsewhere can invalidate ours before it expires. We cache one and, on a 401/403 from
// the session call, bust + refresh once. The refresh call is the only one carrying the secret.
let transakToken = { value: null, expiresAtMs: 0 };
async function transakAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && transakToken.value && now < transakToken.expiresAtMs - 60_000) return transakToken.value;
  // Auth is the api-secret header + apiKey in the body (matches Transak's working partner
  // integrations). A real User-Agent/Accept is essential: Node's native fetch sends a bot-like
  // default UA that Transak's Cloudflare WAF 429s with an HTML challenge — the proven SDKs use
  // an HTTP client that sets a normal UA, which is the actual difference, not any auth header.
  const res = await fetch(`${TRANSAK_HOSTS.auth}/partners/api/v2/refresh-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'HighriseCreatureClub/1.0 (+https://highrisecreatureclub.com)',
      'api-secret': TRANSAK_API_SECRET,
    },
    body: JSON.stringify({ apiKey: TRANSAK_API_KEY }),
  });
  if (!res.ok) throw new Error(`transak refresh-token ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json().catch(() => ({}));
  const token = j?.data?.accessToken;
  const expSec = Number(j?.data?.expiresAt); // unix seconds
  console.log(`[transak] refresh ok: tokenLen=${token ? String(token).length : 0} keys=${Object.keys(j?.data || {}).join(',')} exp=${expSec}`); // TODO: drop after diagnosis
  if (!token) throw new Error('transak refresh-token: missing accessToken');
  transakToken = { value: token, expiresAtMs: Number.isFinite(expSec) ? expSec * 1000 : now + 6 * 86400 * 1000 };
  return token;
}

// Mint one widget URL. `network` is pinned ('immutablezkevm' | 'ethereum') so funds land on the
// right chain; cryptoCurrencyCode forces the token (and is required for defaultCryptoAmount to
// apply); disableWalletAddressForm locks the destination to the buyer's wallet. The access
// token is cached for its full ~7-day life — refresh-token is heavily rate-limited (429s on
// abuse), so we never auto-refresh on a transient 401; the cache expiry drives refreshes.
async function transakWidgetUrl(opts) {
  const { network, token, address, fiatUsd, referrerDomain } = opts;
  const accessToken = await transakAccessToken();
  const widgetParams = {
    apiKey: TRANSAK_API_KEY,
    referrerDomain,
    productsAvailed: 'BUY',
    network,
    cryptoCurrencyCode: token,
    walletAddress: address,
    disableWalletAddressForm: true,
  };
  // Prefill in fiat (the buyer pays in fiat anyway, and the crypto-amount field is integer-only).
  if (Number.isFinite(fiatUsd) && fiatUsd > 0) {
    widgetParams.defaultFiatAmount = Math.round(fiatUsd);
    widgetParams.defaultFiatCurrency = 'USD';
  }
  // The session call authenticates with the access-token header; same UA/Accept as refresh.
  const res = await fetch(`${TRANSAK_HOSTS.gateway}/api/v2/auth/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'HighriseCreatureClub/1.0 (+https://highrisecreatureclub.com)',
      'access-token': accessToken,
    },
    body: JSON.stringify({ widgetParams }),
  });
  if (!res.ok) throw new Error(`transak session ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json().catch(() => ({}));
  const url = j?.data?.widgetUrl;
  if (!url) throw new Error('transak session: missing widgetUrl');
  return url;
}

// --- Immutable-hosted on-ramp (zkEVM) -----------------------------------------------------
// This is the exact call Immutable's toolkit on-ramp page makes: it mints a Transak widget
// session through Immutable's OWN (zkEVM-enabled) Transak account, so it works without our
// partner account being provisioned — and still pins network + token + amount. We use it for
// zkEVM (Creatures); LAND stays on our own Transak account (Ethereum isn't offered here).
const IMMUTABLE_CHECKOUT_CONFIG_URL = 'https://checkout-api.immutable.com/v1/config';
const IMMUTABLE_CHECKOUT_WIDGET_URL = 'https://api.immutable.com/checkout/v1/widget-url';
const ONRAMP_UA = 'HighriseCreatureClub/1.0 (+https://hcc.highrise.game)';

// Immutable's public Transak key lives in their checkout config (keyed by provider id). Fetched
// + cached (6h) rather than hardcoded, so a rotation on their side doesn't break us.
let imxOnrampKey = { value: null, fetchedAtMs: 0 };
async function immutableOnrampKey() {
  const now = Date.now();
  if (imxOnrampKey.value && now < imxOnrampKey.fetchedAtMs + 6 * 3600 * 1000) return imxOnrampKey.value;
  const res = await fetch(IMMUTABLE_CHECKOUT_CONFIG_URL, { headers: { Accept: 'application/json', 'User-Agent': ONRAMP_UA } });
  if (!res.ok) throw new Error(`immutable config ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const key = Object.values(j?.onramp || {}).map(v => v?.publishableApiKey).find(Boolean);
  if (!key) throw new Error('immutable config: no onramp publishableApiKey');
  imxOnrampKey = { value: key, fetchedAtMs: now };
  return key;
}

// Mint a card on-ramp URL via Immutable's hosted checkout (rides Immutable's Transak account, so
// no creds of ours). It serves BOTH networks:
//   network 'immutablezkevm' → IMX (gas), ETH (the Creature price token) or USDC, all delivered
//                              natively to zkEVM. ETH here is what lets a buyer start from an
//                              empty wallet: no mainnet ETH, no bridge, no bridge fee.
//   network 'ethereum'       → ETH (the LAND price token) or USDC, delivered to Ethereum.
// fiatUsd prefills the buy amount (integer USD). The returned global.transak.com?sessionId=… URL
// is short-lived + single-use, so we mint on click.
async function immutableOnrampUrl({ network, token, address, fiatUsd, referrerDomain }) {
  const apiKey = await immutableOnrampKey();
  const body = {
    api_key: apiKey,
    network,
    products_availed: 'buy',
    default_payment_method: 'credit_debit_card',
    default_crypto_currency: token,
    crypto_currency_code: token, // lock the token so funds can't land as the wrong asset
    hide_menu: true,
    wallet_address: address,
    referrer_domain: referrerDomain,
  };
  if (Number.isFinite(fiatUsd) && fiatUsd > 0) {
    body.default_fiat_amount = Math.round(fiatUsd);
    body.default_fiat_currency = 'USD';
  }
  const res = await fetch(IMMUTABLE_CHECKOUT_WIDGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': ONRAMP_UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`immutable widget-url ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json().catch(() => ({}));
  if (!j.url) throw new Error('immutable widget-url: missing url');
  return j.url;
}

async function handleMarketplaceApi(request, response, url) {
  const { pathname } = url;

  // Bound upstream load from public browsing (per client IP). The pet-render endpoint
  // is image-like (a slime grid loads ~24 at once) and carries its OWN, looser limiter
  // below — so it's exempt from this tight per-call API budget, which is sized for the
  // JSON browse/detail calls, not an image wall.
  const ip = clientIp(request);
  const isPetRender = /^\/api\/market\/land\/pet\//.test(pathname);
  // Budget PER COLLECTION, not per client. One shared bucket meant a Creature outage —
  // which makes the client retry hard — burned the whole allowance and started 429ing the
  // LAND routes as well, so an Immutable problem looked like an OpenSea problem too.
  // Keeping the buckets apart is what lets one market stay usable while the other is down.
  const mktBucket = /^\/api\/market\/land\//.test(pathname) ? 'land'
    : /^\/api\/market\/creatures\//.test(pathname) ? 'creatures'
    : 'shared';
  if (!isPetRender) {
    const wait = rateLimited(`mkt:${mktBucket}:${ip}`, 90, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests.' }, { 'Retry-After': String(wait) }); return; }
  }

  // --- Health envelopes ---------------------------------------------------------
  // Every market READ answers with `health`, so the client can tell "this market is empty"
  // from "we could not reach this market". Declared here, above the routes, because both
  // collections need them and JS const has no hoisting.
  //
  // `ok` records the attempt in the ledger as a side effect, so a route only has to say
  // whether its upstream answered. `snapshotAt` is the age of any remembered data being
  // served, or null.
  const srcHealth = (coll, source, ok, snapshotAt = null, code = 'unavailable') => {
    if (ok) upstreamHealth.noteOk(coll, source);
    else upstreamHealth.noteFail(coll, source, code);
    return ok
      ? { state: 'live', asOf: Date.now(), ageMs: 0, error: null }
      : upstreamHealth.sourceState(coll, source, snapshotAt);
  };
  const errCode = err => (err?.code === 'rate_limited' || Number(err?.status ?? err?.statusCode) === 429 ? 'rate_limited'
    : err?.code === 'not_configured' ? 'not_configured' : 'unavailable');

  // Creature BROWSE health. Note this deliberately reports only the `listings` source: the
  // browse index and the order book are different clients, so a browse outage must not
  // pause trading (`trading` is derived from the offers source, which this route never
  // touches, and an unknown write source leaves trading open).
  const creatureBrowseHealth = (ok, snapshotAt = null, code = 'unavailable') =>
    upstreamHealth.collectionHealth('creatures', { listings: srcHealth('creatures', 'listings', ok, snapshotAt, code) });

  if (pathname === '/api/market/creatures/listings') {
    const cursor = url.searchParams.get('cursor') || '';
    const KEY = `creatures:listings:${cursor}`;
    try {
      upstreamHealth.throwIfFaulted('creatures', 'listings');
      const data = await getCreatureListings(cursor);
      if (!cursor) lastKnown.record(KEY, data); // first page only — see the browse route below
      sendJson(response, 200, { ...data, health: creatureBrowseHealth(true) }, { 'Cache-Control': 'public, max-age=30' }, { request, etagIgnore: HEALTH_CLOCK_KEYS });
    } catch (err) {
      console.error('Creature listings failed:', err.message);
      const snap = lastKnown.read(KEY, upstreamHealth.MAX_AGE_MS.creatures);
      const health = creatureBrowseHealth(false, snap?.at ?? null, errCode(err));
      // `fetchedAt` must report when the DATA was read, not when this response was built —
      // it was the one field quietly asserting freshness we did not have.
      sendJson(response, snap ? 200 : 503, snap
        ? { ...snap.data, fetchedAt: new Date(snap.at).toISOString(), items: (snap.data.items || []).map(i => ({ ...i, stale: true })), health }
        : { error: 'upstream_down', items: null, health },
        { 'Cache-Control': 'no-store' }, { request, compress: true });
    }
    return;
  }

  // Filterable explorer: name search, trait/rarity facets, price range, sort. A full
  // wallet address in `q` flips it to that wallet's holdings — an uncached upstream read,
  // so it carries its own modest per-IP budget (paging shares a 45s per-address pool cache).
  if (pathname === '/api/market/creatures/browse') {
    if (HEX_ADDRESS.test((url.searchParams.get('q') || '').trim().toLowerCase())) {
      const w = rateLimited(`mktwallet:${ip}`, 40, 60 * 1000);
      if (w) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(w) }); return; }
    }
    // No `stale-while-revalidate` on this route or /listings: the club's rule is that
    // listings show CURRENT status, and a background-revalidated copy would paint a
    // minute-old price with nothing marking it stale. The slow surfaces (traits, sales,
    // holders, market stats) do carry it — nothing there can go out of date mid-click.
    const KEY = `creatures:browse:${url.search || ''}`;
    try {
      upstreamHealth.throwIfFaulted('creatures', 'listings');
      const data = await getCreatureBrowse(url.searchParams);
      // Only the first page is worth keeping. It's the view every filter combo starts from,
      // and recording deep pages as well let one browsing session evict every snapshot in
      // the store before an outage ever arrived.
      if (data.page === 0) lastKnown.record(KEY, data);
      sendJson(response, 200, { ...data, health: creatureBrowseHealth(true) }, { 'Cache-Control': 'public, max-age=15' }, { request, etagIgnore: HEALTH_CLOCK_KEYS });
    } catch (err) {
      console.error('Creature browse failed:', err.message);
      const snap = lastKnown.read(KEY, upstreamHealth.MAX_AGE_MS.creatures);
      if (snap) {
        sendJson(response, 200, {
          ...snap.data,
          fetchedAt: new Date(snap.at).toISOString(),
          items: (snap.data.items || []).map(i => ({ ...i, stale: true })),
          health: creatureBrowseHealth(false, snap.at, errCode(err)),
        }, { 'Cache-Control': 'no-store' }, { request, compress: true });
        return;
      }
      // No snapshot. A WALLET view can still be rebuilt from chain data via Blockscout,
      // which is a different host on its own rate limit, so an Immutable outage doesn't
      // have to cost someone the sight of their own Creatures.
      //
      // These rows carry no prices, and their `listed: false` is a placeholder the tile
      // needs, NOT a statement that the token isn't for sale. That's why this only ever
      // answers under a degraded envelope with pricesUnavailable set: the banner has to be
      // the thing that tells the user we couldn't ask.
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (HEX_ADDRESS.test(q) && creatureFallback.available()) {
        const items = await creatureFallback.ownedBy(q);
        if (items.length) {
          console.warn(`Creature browse: served ${items.length} rows for ${maskWallet(q)} from the Blockscout fallback`);
          sendJson(response, 200, {
            items, total: items.length, page: 0, hasMore: false,
            scope: 'all', owner: q, ownedTotal: items.length,
            pricesUnavailable: true, source: 'blockscout',
            health: creatureBrowseHealth(false, Date.now(), errCode(err)),
          }, { 'Cache-Control': 'no-store' }, { request, compress: true });
          return;
        }
      }
      sendJson(response, 503, {
        error: 'upstream_down', items: null,
        health: creatureBrowseHealth(false, null, errCode(err)),
      }, { 'Cache-Control': 'no-store' });
    }
    return;
  }

  // Every trait in the collection, grouped by slot, each with a Creature that wears it —
  // the Collections › Creature Traits showcase. Built from the same in-memory indexes
  // Browse already keeps, so it costs no upstream calls at all.
  if (pathname === '/api/market/creatures/traits') {
    const data = await getCreatureTraits();
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=600' }, { request });
    return;
  }

  // Recent completed Creature sales, filtered by the same query as Browse (search / price /
  // traits), for the Sales History tab. Public on-chain data; short-cached like Browse.
  if (pathname === '/api/market/creatures/sales') {
    try {
      const data = await getCreatureSalesHistory(url.searchParams);
      // Sales are settled history, not a live book: they attach health for context but
      // must never move `trading`, so they report against the non-pricing `meta` source.
      sendJson(response, 200, {
        ...data,
        health: upstreamHealth.collectionHealth('creatures', { meta: srcHealth('creatures', 'meta', true) }),
      }, { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=150' }, { request, etagIgnore: HEALTH_CLOCK_KEYS });
    } catch (err) {
      console.error('Creature sales history failed:', err.message);
      sendJson(response, 503, {
        error: 'unavailable', sales: null,
        health: upstreamHealth.collectionHealth('creatures', { meta: srcHealth('creatures', 'meta', false, null, errCode(err)) }),
      }, { 'Cache-Control': 'no-store' });
    }
    return;
  }

  // One token's active listing, from the browse snapshot — powers ?token= deep links
  // (e.g. Discord new-listing pings), where the paged grid feed may not contain the
  // token. Same wire shape as a /listings item; null when the token isn't listed.
  const listingForMatch = pathname.match(/^\/api\/market\/creatures\/listing\/(\d{1,80})$/);
  if (listingForMatch) {
    try {
      upstreamHealth.throwIfFaulted('creatures', 'listings');
      const listIdx = await getBrowseIndex();
      const found = listIdx.items.find(it => String(it.tokenId) === listingForMatch[1]);
      let listing = null;
      if (found) { const { traits, listedAt, ...pub } = found; listing = pub; }
      sendJson(response, 200, { listing, health: creatureBrowseHealth(true) }, { 'Cache-Control': 'public, max-age=15' });
    } catch (err) {
      // A null listing here normally means "not for sale". While the index is unreachable
      // that would be a lie, and this route feeds ?token= deep links straight from Discord
      // pings, so answer 503 rather than telling someone their Creature is unlisted.
      console.error('Creature listing lookup failed:', err.message);
      sendJson(response, 503, {
        error: 'upstream_down', listing: null,
        health: creatureBrowseHealth(false, null, errCode(err)),
      }, { 'Cache-Control': 'no-store' });
    }
    return;
  }

  const tokenMatch = pathname.match(/^\/api\/market\/creatures\/token\/(\d{1,80})$/);
  if (tokenMatch) {
    try {
      upstreamHealth.throwIfFaulted('creatures', 'meta');
      const data = await getCreatureToken(tokenMatch[1]);
      sendJson(response, 200, { ...data, health: upstreamHealth.collectionHealth('creatures', { meta: srcHealth('creatures', 'meta', true) }) },
        { 'Cache-Control': 'public, max-age=120' });
    } catch (err) {
      // Token metadata is immutable per token, so Blockscout is a complete substitute here
      // rather than a partial one. Prices are not involved, so nothing can mislead.
      console.error('Creature token lookup failed:', err.message);
      const meta = creatureFallback.available() ? await creatureFallback.tokenMeta(tokenMatch[1]) : null;
      const health = upstreamHealth.collectionHealth('creatures', { meta: srcHealth('creatures', 'meta', false, meta ? Date.now() : null, errCode(err)) });
      if (meta) {
        sendJson(response, 200, { ...meta, source: 'blockscout', health }, { 'Cache-Control': 'no-store' });
      } else {
        sendJson(response, 503, { error: 'upstream_down', health }, { 'Cache-Control': 'no-store' });
      }
    }
    return;
  }

  // The buyer's ETH on Ethereum MAINNET — powers the friendly "your ETH just needs to
  // switch networks" guidance (the #1 source of confusion). Public on-chain data for the
  // caller's own address; the client can't read mainnet itself (CSP blocks external RPCs).
  const elsewhereMatch = pathname.match(/^\/api\/market\/creatures\/eth-elsewhere\/(0x[0-9a-fA-F]{40})$/);
  if (elsewhereMatch) {
    const addr = elsewhereMatch[1];
    // Both reads feed the funds/gas helpers: ETH (the price token to bridge) and IMX held
    // on mainnet (the gas coin — bridging that straight over is cheaper than swapping ETH).
    // Independent so one failing still yields the other.
    const [ethRes, imxRes] = await Promise.allSettled([
      ethGetBalance(ETH_BALANCE_RPC, addr),
      ethCall(ETH_RPC_URL, IMX_L1_TOKEN, SEL_BALANCE_OF + padUint(BigInt(addr))),
    ]);
    if (ethRes.status === 'rejected') console.error('Mainnet ETH balance failed:', ethRes.reason?.message);
    if (imxRes.status === 'rejected') console.error('Mainnet IMX balance failed:', imxRes.reason?.message);
    const mainnetEthWei = ethRes.status === 'fulfilled' ? ethRes.value : null;
    let mainnetImxWei = null;
    if (imxRes.status === 'fulfilled' && imxRes.value) {
      try { mainnetImxWei = BigInt(imxRes.value).toString(); } catch { /* leave null */ }
    }
    // ETH on the L2s we can fund from, so the source picker can show a balance beside each
    // chain instead of asking the member to remember where their money is. All settled
    // independently: one slow public node must not cost the others their figure, and a
    // missing balance renders as "unknown" rather than as zero.
    const l2Keys = Object.keys(FUND_CHAIN_RPC);
    const l2Res = await Promise.allSettled(l2Keys.map(k => ethGetBalance(FUND_CHAIN_RPC[k], addr)));
    const chains = {};
    l2Keys.forEach((k, i) => {
      const r = l2Res[i];
      if (r.status === 'rejected') { console.error(`${k} ETH balance failed:`, r.reason?.message); chains[k] = null; return; }
      try { chains[k] = BigInt(r.value).toString(); } catch { chains[k] = null; }
    });
    sendJson(response, 200, { mainnetEthWei, mainnetImxWei, chains }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Prepare a buy: returns the unsigned transactions (approval + fulfilment) for the
  // buyer's wallet to sign. No auth — the wallet signature is the real authorization;
  // the taker address only scopes the prepared transactions to that buyer.
  if (pathname === '/api/market/creatures/buy/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    // Order preparation hits the orderbook + RPC upstream — tighter cap than browsing.
    const bWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (bWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(bWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const listingId = String(body.listingId || '').toLowerCase();
    const taker = String(body.takerAddress || '').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(listingId)) {
      sendJson(response, 400, { error: 'bad_listing' }); return;
    }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }

    try {
      const prepared = await mktOrderbook.prepareBuy(listingId, taker);
      sendJson(response, 200, prepared);
    } catch (err) {
      // On a LISTING buy the "fulfiller" is the buyer — seaport's fulfiller-balance
      // error here just means the buyer lacks ETH, which the client turns into the
      // funds-help panel (balances + bridge quote), not a generic failure.
      const code = err.code === 'taker_float' ? 'insufficient' : err.code;
      sendJson(response, err.statusCode || 503, { error: code || 'unavailable' });
    }
    return;
  }

  // The seller's own Creatures (sell picker) and active listings (My listings).
  // Public on-chain data; the address is the caller's own connected wallet.
  const ownedMatch = pathname.match(/^\/api\/market\/creatures\/(owned|mine)\/(0x[0-9a-f]{40})$/);
  if (ownedMatch) {
    const data = ownedMatch[1] === 'owned'
      ? await getOwnedCreatures(ownedMatch[2])
      : await getMyListings(ownedMatch[2]);
    sendJson(response, 200, data, { 'Cache-Control': 'no-store' }); // wallet-keyed — never shared-cache it
    return;
  }

  // The "History" tab: a wallet's past (sold / cancelled / expired) Creature listings.
  // Heavier than owned/mine (several upstream queries + a meta batch), so it carries its
  // own modest per-IP limit on top of the shared budget. Wallet-keyed — never shared-cache.
  const historyMatch = pathname.match(/^\/api\/market\/creatures\/history\/(0x[0-9a-f]{40})$/);
  if (historyMatch) {
    const hWait = rateLimited(`mkthist:${ip}`, 15, 60 * 1000);
    if (hWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(hWait) }); return; }
    const data = await getMyListingHistory(historyMatch[1]);
    sendJson(response, 200, data, { 'Cache-Control': 'no-store' });
    return;
  }

  const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // Prepare a listing: NFT approval tx (first time only) + typed data to sign (gasless).
  if (pathname === '/api/market/creatures/sell/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const sWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (sWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(sWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    const tokenId = String(body.tokenId || '');
    // Currency: 'eth' (default, back-compat) or 'usdc'. Price arrives as `price` (+ currency);
    // legacy callers send `priceEth`. Amount is converted at the currency's own decimals.
    const cur = zkCurrency(body.currency || 'eth');
    const units = cur ? amountToUnits(body.price ?? body.priceEth, cur.decimals) : null;
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (!cur) { sendJson(response, 400, { error: 'bad_currency' }); return; }
    if (units == null || BigInt(units) <= 0n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      const prepared = await mktOrderbook.prepareSell({
        makerAddress: maker, sellContract: CREATURE_CONTRACT, tokenId,
        buyContract: cur.address, amountWei: units,
      });
      sendJson(response, 200, prepared);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the listing from the signed order (gasless; the orderbook verifies the
  // signature against the order's offerer, so a forged body can't list anyone's NFT).
  if (pathname === '/api/market/creatures/sell/create' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 64 * 1024);
    const { orderComponents, orderHash, signature } = body || {};
    if (!orderComponents || typeof orderComponents !== 'object'
      || !/^0x[0-9a-f]{64}$/i.test(String(orderHash || ''))
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    // Scope allowlist: this endpoint only relays orders selling THIS collection for
    // THIS payment token (mirrors what sell/prepare pins). The orderbook would verify
    // the signature anyway, but without this the endpoint is a generic Seaport relay.
    // The order must sell exactly one Creature and be priced in ONE allowed currency (ETH or
    // USDC) — every consideration item (proceeds + royalty) in that same token. This keeps the
    // endpoint from relaying an order priced in some arbitrary/worthless token.
    const offer = Array.isArray(orderComponents.offer) ? orderComponents.offer : [];
    const consideration = Array.isArray(orderComponents.consideration) ? orderComponents.consideration : [];
    const payCur = consideration.length ? zkCurrencyByAddr(consideration[0]?.token) : null;
    const scopeOk = offer.length === 1
      && String(offer[0]?.token || '').toLowerCase() === CREATURE_CONTRACT.toLowerCase()
      && payCur
      && consideration.every(c => String(c?.token || '').toLowerCase() === payCur.address.toLowerCase());
    if (!scopeOk) { sendJson(response, 400, { error: 'bad_order' }); return; }
    try {
      const created = await mktOrderbook.createSell({ orderComponents, orderHash, signature });
      listingsCache.clear(); // the new listing should appear in browse promptly
      sendJson(response, 200, created);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Gasless cancel: typed data to sign, then submit with the signature. Only the
  // order's creator can produce a valid signature — the orderbook enforces that.
  if ((pathname === '/api/market/creatures/cancel/prepare' || pathname === '/api/market/creatures/cancel')
      && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const kWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (kWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(kWait) }); return; }

    const body = await readJsonBody(request, 16 * 1024);
    const addr = String(body.accountAddress || '').toLowerCase();
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(s => String(s).toLowerCase()) : [];
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!orderIds.length || orderIds.length > 20 || !orderIds.every(id => ORDER_ID.test(id))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    try {
      if (pathname.endsWith('/prepare')) {
        sendJson(response, 200, await mktOrderbook.prepareCancel(orderIds, addr));
      } else {
        const signature = String(body.signature || '');
        if (!/^0x[0-9a-f]{60,2600}$/i.test(signature)) { sendJson(response, 400, { error: 'bad_signature' }); return; }
        const result = await mktOrderbook.submitCancel(orderIds, addr, signature);
        listingsCache.clear(); // cancelled listings should drop out of browse promptly
        sendJson(response, 200, result);
      }
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- Offers (bids): standing offers on a specific Creature, or collection-wide
  // ("floor") offers any holder can sell into. Same trust model as listings: the
  // bidder's signature is the authorization; the orderbook + Seaport verify it.

  // Read endpoints (public orderbook data). Each returns a MIXED-currency book — offers in
  // ETH and USDC merged, best first — with an ETH-equivalent + USD estimate on every row.
  // Health envelope for a Creature offers response. `snapshotAt` is the age of whatever
  // remembered book we are serving, or null when the data is live / there is none.
  const creatureOffersHealth = (failed, snapshotAt = null) => {
    const offersState = failed.length
      ? upstreamHealth.sourceState('creatures', 'offers', snapshotAt)
      : { state: 'live', asOf: Date.now(), ageMs: 0, error: null };
    return upstreamHealth.collectionHealth('creatures', { offers: offersState });
  };

  if (pathname === '/api/market/creatures/offers/collection') {
    if (!mktOrderbook.available()) {
      upstreamHealth.noteFail('creatures', 'offers', 'not_configured');
      sendJson(response, 503, { error: 'upstream_down', offers: null, health: creatureOffersHealth(['eth', 'usdc']) }, { 'Cache-Control': 'no-store' });
      return;
    }
    const fx = await getMarketplaceFx();
    const { offers, failed } = await zkOffersAllCurrencies(mktOrderbook.listCollectionOffers, { nftContract: CREATURE_CONTRACT }, fx.ethUsd);
    const KEY = 'creatures:offers:collection';

    if (!failed.length) {
      const funded = await fundedOffersOnly(offers);
      lastKnown.record(KEY, funded); // snapshot only ever written on the happy path
      sendJson(response, 200, { offers: funded, health: creatureOffersHealth([]) }, { 'Cache-Control': 'public, max-age=15' });
      return;
    }
    // Everything failed → serve the remembered book if it is recent enough, clearly marked
    // stale. Nothing recent → say we do not know, rather than "there are no offers".
    if (failed.length === Object.keys(ZK_CURRENCIES).length) {
      const snap = lastKnown.read(KEY, upstreamHealth.MAX_AGE_MS.creatures);
      const health = creatureOffersHealth(failed, snap?.at ?? null);
      sendJson(response, snap ? 200 : 503, {
        offers: snap ? snap.data.map(o => ({ ...o, stale: true })) : null,
        error: snap ? undefined : 'upstream_down',
        health,
      }, { 'Cache-Control': 'no-store' });
      return;
    }
    // One currency answered: the book is real but incomplete. Say so.
    sendJson(response, 200, {
      offers: await fundedOffersOnly(offers), partial: true, unavailableCurrencies: failed,
      health: creatureOffersHealth(failed, Date.now()),
    }, { 'Cache-Control': 'no-store' });
    return;
  }
  const offersTokenMatch = pathname.match(/^\/api\/market\/creatures\/offers\/token\/(\d{1,80})$/);
  if (offersTokenMatch) {
    if (!mktOrderbook.available()) {
      sendJson(response, 503, { error: 'upstream_down', offers: null, health: creatureOffersHealth(['eth', 'usdc']) }, { 'Cache-Control': 'no-store' });
      return;
    }
    const fx = await getMarketplaceFx();
    const { offers, failed } = await zkOffersAllCurrencies(mktOrderbook.listTokenOffers, { nftContract: CREATURE_CONTRACT, tokenId: offersTokenMatch[1] }, fx.ethUsd);
    // No remembered copy for a single token: a stale per-token book is what a seller reads
    // when deciding to accept, and one wrong row there is a bad trade.
    if (failed.length === Object.keys(ZK_CURRENCIES).length) {
      sendJson(response, 503, { error: 'upstream_down', offers: null, health: creatureOffersHealth(failed) }, { 'Cache-Control': 'no-store' });
      return;
    }
    sendJson(response, 200, {
      offers: await fundedOffersOnly(offers),
      ...(failed.length ? { partial: true, unavailableCurrencies: failed } : {}),
      health: creatureOffersHealth(failed, Date.now()),
    }, { 'Cache-Control': failed.length ? 'no-store' : 'public, max-age=15' });
    return;
  }
  const offersMineMatch = pathname.match(/^\/api\/market\/creatures\/offers\/mine\/(0x[0-9a-f]{40})$/);
  if (offersMineMatch) {
    if (!mktOrderbook.available()) {
      sendJson(response, 503, { error: 'upstream_down', offers: null, health: creatureOffersHealth(['eth', 'usdc']) }, { 'Cache-Control': 'no-store' });
      return;
    }
    const fx = await getMarketplaceFx();
    const { offers, failed } = await zkOffersAllCurrencies(mktOrderbook.listMyOffers, { nftContract: CREATURE_CONTRACT, accountAddress: offersMineMatch[1] }, fx.ethUsd);
    // `offers: null`, never []. An empty list here renders as "you have no offers out",
    // which invites the user to re-bid on top of a bid they already have standing.
    if (failed.length === Object.keys(ZK_CURRENCIES).length) {
      sendJson(response, 503, { error: 'upstream_down', offers: null, health: creatureOffersHealth(failed) }, { 'Cache-Control': 'no-store' });
      return;
    }
    // The user's OWN offers are annotated, not hidden — an unfunded one needs their
    // attention (top up or cancel), not silence.
    const annotated = await annotateOffersFunded(offers);
    sendJson(response, 200, {
      offers: annotated.map(({ grossWei, ...rest }) => rest),
      ...(failed.length ? { partial: true, unavailableCurrencies: failed } : {}),
      health: creatureOffersHealth(failed, Date.now()),
    }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Prepare an offer: ERC20 approval tx (first time only) + typed data to sign (gasless).
  if (pathname === '/api/market/creatures/offer/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const oWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (oWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(oWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    // Currency: 'eth' (default) or 'usdc'. Amount arrives as `price` (+ currency); legacy
    // callers send `priceEth`. Converted at the currency's own decimals.
    const cur = zkCurrency(body.currency || 'eth');
    const units = cur ? amountToUnits(body.price ?? body.priceEth, cur.decimals) : null;
    const tokenId = body.tokenId != null ? String(body.tokenId) : null;
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!cur) { sendJson(response, 400, { error: 'bad_currency' }); return; }
    if (units == null || BigInt(units) <= 0n) { sendJson(response, 400, { error: 'bad_price' }); return; }
    if (tokenId != null && !/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }

    try {
      const prepared = await mktOrderbook.prepareOffer({
        makerAddress: maker, sellContract: cur.address, amountWei: units,
        nftContract: CREATURE_CONTRACT, tokenId,
      });
      sendJson(response, 200, prepared);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the offer from the signed order. Scope allowlist mirrors sell/create, with
  // sides flipped: a bid OFFERS the ETH token and takes the Creature in consideration
  // (fee items ride along in ETH).
  if (pathname === '/api/market/creatures/offer/create' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 64 * 1024);
    const { orderComponents, orderHash, signature } = body || {};
    if (!orderComponents || typeof orderComponents !== 'object'
      || !/^0x[0-9a-f]{64}$/i.test(String(orderHash || ''))
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    // Scope allowlist mirrors sell/create, sides flipped: a bid OFFERS one allowed currency
    // (ETH or USDC) and takes the Creature in consideration (fee items ride along in that same
    // currency). Widened from ETH-only to {ETH, USDC} — still never an arbitrary token.
    const offer = Array.isArray(orderComponents.offer) ? orderComponents.offer : [];
    const consideration = Array.isArray(orderComponents.consideration) ? orderComponents.consideration : [];
    const creature = CREATURE_CONTRACT.toLowerCase();
    const payCur = offer.length === 1 ? zkCurrencyByAddr(offer[0]?.token) : null;
    const scopeOk = payCur
      && consideration.length >= 1
      && consideration.every(c => {
        const tk = String(c?.token || '').toLowerCase();
        return tk === creature || tk === payCur.address.toLowerCase();
      })
      && consideration.some(c => String(c?.token || '').toLowerCase() === creature);
    if (!scopeOk) { sendJson(response, 400, { error: 'bad_order' }); return; }

    try {
      const created = await mktOrderbook.createOffer({ orderComponents, orderHash, signature, collection: !!body.collection });
      sendJson(response, 200, created);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Recipient safety assessment for transfers (checksum, protocol-contract block,
  // on-chain activity) — read-only, never blocks on RPC blips.
  if (pathname === '/api/market/creatures/transfer/check' && request.method === 'POST') {
    const tWait = rateLimited(`mkt:${ip}`, 90, 60 * 1000);
    if (tWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(tWait) }); return; }
    const body = await readJsonBody(request, 4 * 1024);
    const chain = body.chain === 'ethereum' ? 'ethereum' : 'zkevm';
    sendJson(response, 200, await checkTransferRecipient(body.to, chain), { 'Cache-Control': 'no-store' });
    return;
  }

  // Exact-output bridge quote via Squid: "send X ETH on Ethereum, receive ≥ what you're
  // short on Immutable zkEVM", plus the ready-to-sign mainnet transaction. Quotes hit
  // Squid's API (integrator id from env), so the cap is tight; 'not_configured' tells
  // the client to fall back to the deep-link.
  if (pathname === '/api/market/creatures/bridge/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const qWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (qWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(qWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.needEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await squidBridge.quoteBridge(wei, addr));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Exact-output GAS top-up quote: "send X ETH on Ethereum, receive ≥ Y native IMX on
  // Immutable zkEVM". IMX (not the ETH ERC-20) is what pays gas, so a seller/transferrer
  // with no IMX can't sign their one on-chain action — this bridges a little over. The
  // in-panel tracker reuses /bridge/status (it keys on the tx hash, asset-agnostic).
  if (pathname === '/api/market/creatures/bridge/gas/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const gWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (gWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(gWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.needImx);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    // Cap it so a tampered request can't quote an enormous bridge. This was 50 IMX on the
    // reasoning that "a gas top-up is a few IMX" — true for a buy or a transfer, false for a
    // canonical cash-out, which prepays the Ethereum-side relay in IMX and ran 54-215 IMX
    // inside one hour when it was measured. The cap therefore sat below the requirement and
    // no top-up this endpoint would quote could unblock the member asking for one. Keep in
    // step with GAS_MAX_IMX in js/marketplace.js.
    if (wei == null || wei > 300n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }
    // Source asset: 'imx' bridges the user's existing mainnet IMX straight over (cheapest —
    // no swap); 'eth' (default) swaps a little mainnet ETH into IMX.
    const fromToken = body.from === 'imx' ? squidBridge.IMX_L1 : undefined;

    try {
      sendJson(response, 200, await squidBridge.quoteBridge(wei, addr, { toToken: squidBridge.ZK_IMX, fromToken }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- Gas assist: we pay the member's gas ------------------------------------------
  // Bridging or buying IMX is the fallback, not the answer. A Creature holder with an
  // empty wallet needs about $0.0001 of gas to move their asset and would otherwise have
  // to spend ~$30 acquiring IMX to get it. So we cover it. See lib/gas-faucet.js for the
  // policy and why it's shaped this way.
  //
  // Both routes act on the wallet the member has CONNECTED, passed as `address`. That is
  // the wallet that needs the gas, so it's the one we pay — but a connected wallet proves
  // nothing about who its owner is, so nothing is trusted to it. Identity comes from the
  // session (Discord account + the Highrise account behind it), and eligibility comes from
  // the Creatures that wallet holds, read from the chain. A claim is once per LIFETIME on
  // the Discord account, the Highrise account and the wallet, and it taints every Creature
  // in that wallet for a window, so a fresh wallet or a moved Creature buys nothing. The
  // member is told the window exists but never how long it runs — see gasAssistTermsHtml.

  // Can this member get their gas covered right now? Safe to call signed out; the answer
  // is then simply { available: false, reason: 'not_signed_in' }.
  if (pathname === '/api/market/creatures/gas/assist' && request.method === 'GET') {
    const out = (reason, extra = {}) => sendJson(response, 200,
      { available: false, reason, policy: gasFaucet.policy(), ...extra }, { 'Cache-Control': 'no-store' });

    if (!gasFaucet.live()) { out('disabled'); return; }
    const session = await db.getSession(auth.parseCookies(request)[auth.SESSION_COOKIE]);
    if (!session) { out('not_signed_in'); return; }

    const asked = String(url.searchParams.get('address') || '').toLowerCase();
    if (!HEX_ADDRESS.test(asked)) { out('no_wallet'); return; }

    try {
      const [owned, imxWei] = await Promise.all([
        getOwnedCreatures(asked),
        gasFaucet.walletBalance(asked),
      ]);
      const tokenIds = (owned.items || []).map(c => String(c.tokenId));
      if (!tokenIds.length) { out('no_creature'); return; }

      const amountWei = gasFaucet.amountFor(imxWei);
      if (amountWei === 0n) { out('has_gas'); return; }

      const status = await db.gasGrantStatus({
        discordId: session.discord_id,
        highriseId: session.profile?.highriseUserId || null,
        wallet: asked,
        tokenIds,
      });
      if (status.used) { out(status.used); return; }
      if (status.assetsUsed) { out('assets_used'); return; }
      if (status.grantsToday >= gasFaucet.DAILY_CAP) { out('daily_cap'); return; }

      sendJson(response, 200, {
        available: true,
        wallet: asked,          // echoing back what they sent, so the UI can name the destination
        creatures: tokenIds.length,
        amountImx: Number(amountWei) / 1e18,
        policy: gasFaucet.policy(),
      }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      console.error('gas assist status failed:', err.message);
      out('unavailable');
    }
    return;
  }

  // Do it. Signs a native IMX transfer from the faucet wallet to the wallet the member has
  // connected. Every gate is re-checked here against the chain and the ledger — the GET
  // above is a UI hint, never an authorisation.
  if (pathname === '/api/market/creatures/gas/assist' && request.method === 'POST') {
    if (!gasFaucet.live()) { sendJson(response, 503, { error: 'disabled' }); return; }

    const session = await db.getSession(auth.parseCookies(request)[auth.SESSION_COOKIE]);
    if (!session) { sendJson(response, 401, { error: 'not_signed_in' }); return; }

    // Tight per-account limit: a legitimate member clicks this once, ever, so anything
    // more is either a stuck UI or someone probing. Also limited per IP.
    const aWait = rateLimited(`gasassist:${session.discord_id}`, 5, 10 * 60 * 1000)
      || rateLimited(`gasassistip:${ip}`, 12, 10 * 60 * 1000);
    if (aWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(aWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const asked = String(body.address || '').toLowerCase();
    if (!HEX_ADDRESS.test(asked)) { sendJson(response, 400, { error: 'no_wallet' }); return; }

    try {
      // Authoritative reads: which Creatures this wallet holds right now, and its real
      // balance. The token ids are the eligibility gate AND what the claim spends.
      const [owned, imxWei] = await Promise.all([
        getOwnedCreatures(asked),
        gasFaucet.walletBalance(asked),
      ]);
      // getOwnedCreatures pages to a 500-Creature ceiling. A holder that big is not who
      // this is for, and the account/Highrise/wallet gates already allow only one claim
      // each, so locking the first page-run is enough.
      const tokenIds = (owned.items || []).map(c => String(c.tokenId));
      if (!tokenIds.length) { sendJson(response, 403, { error: 'no_creature' }); return; }

      const res = await gasFaucet.grant({
        db,
        discordId: session.discord_id,
        highriseId: session.profile?.highriseUserId || null,
        wallet: asked,
        tokenIds,
        walletImxWei: imxWei,
      });
      if (!res.ok) {
        // "You've already had it" is the member's answer to give; the rest are ours to fix.
        const soft = new Set(['has_gas', 'account_used', 'highrise_used', 'wallet_used', 'assets_used', 'daily_cap']);
        const status = soft.has(res.reason) ? 409 : res.reason === 'blocked' ? 403 : 503;
        sendJson(response, status, { error: res.reason });
        return;
      }
      sendJson(response, 200, {
        ok: true, txHash: res.txHash, amountImx: Number(res.amountWei) / 1e18,
      }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      console.error('gas assist failed:', err.message);
      sendJson(response, 503, { error: 'unavailable' });
    }
    return;
  }

  // In-site cash-out quote: the EXACT-INPUT reverse bridge — "send X of your zkEVM ETH,
  // receive ~Y native ETH on Ethereum mainnet" — plus the ready-to-sign zkEVM transaction
  // and the ERC-20 approval target. Powers the Token-Trove-style Move flow in the cash-out
  // modal, so sellers never have to leave the site to reach an exchange-friendly network.
  // Amount is the seller's own proceeds; capped so a tampered request can't quote a huge
  // bridge against our shared integrator id.
  if (pathname === '/api/market/creatures/cashout/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const cWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.amountEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await squidBridge.quoteCashout(wei, addr));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- Cash-out via Layerswap (the DEFAULT route) ------------------------------------
  // The canonical bridge above prepays Ethereum-side gas through Axelar, in IMX, up front:
  // 54-215 IMX for the same $211 move inside half an hour when it was measured, which
  // stranded any member holding ETH but no IMX. Layerswap instead takes its fee out of the
  // ETH, so the only gas needed is an ordinary zkEVM transfer. See lib/layerswap-bridge.js
  // for the full reasoning and the custody trade-off.
  //
  // Quoting and creating are split because creating registers a swap on Layerswap's side.
  // Quoting runs on every keystroke behind the client's debounce; creating happens once,
  // when the member commits.
  if (pathname === '/api/market/creatures/cashout/ls/quote' && request.method === 'POST') {
    if (!layerswapBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    // Its own bucket: Layerswap costs us nothing per call and has no shared integrator id
    // to protect, so quoting here must not eat the Squid budget (or be starved by it).
    const lqWait = rateLimited(`mktls:${ip}`, 30, 60 * 1000);
    if (lqWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(lqWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.amountEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await layerswapBridge.quoteCashout(wei, addr), { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Mint the transaction the member actually signs. The response carries Layerswap's
  // calldata verbatim; see createCashout for why it must not be rebuilt. Destination is
  // pinned to the source address server-side, so this can only ever pay the member's own
  // wallet on the other chain.
  if (pathname === '/api/market/creatures/cashout/ls/create' && request.method === 'POST') {
    if (!layerswapBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const lcWait = rateLimited(`mktlscreate:${ip}`, 10, 60 * 1000);
    if (lcWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(lcWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.amountEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await layerswapBridge.createCashout(wei, addr), { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- Funding through Layerswap: the same solver, run the other way ---------------------
  //
  // Getting ETH ONTO zkEVM, from Ethereum or from an L2 the member already holds. Measured
  // 2026-08-31, this beats the Squid funding route on both axes at once: $0.009 against
  // $0.11 and 7 seconds against 17 minutes from Ethereum, and from an L2 it is not close
  // ($1.28 against $17 on a $1,000 move, because Squid has to swap into thin zkEVM ETH).
  // The Squid route stays on offer: it is the canonical bridge, non-custodial end to end.
  //
  // Same split as the cash-out: quote runs on every keystroke, create registers a swap.
  if (pathname === '/api/market/creatures/topup/ls/sources' && request.method === 'GET') {
    if (!layerswapBridge.fundConfigured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    sendJson(response, 200, { sources: layerswapBridge.fundSources() }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (pathname === '/api/market/creatures/topup/ls/limits' && request.method === 'GET') {
    if (!layerswapBridge.fundConfigured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const tlWait = rateLimited(`mkttopuplim:${ip}`, 30, 60 * 1000);
    if (tlWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(tlWait) }); return; }
    try {
      sendJson(response, 200, await layerswapBridge.fundLimits(url.searchParams.get('source') || ''),
        { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  if (pathname === '/api/market/creatures/topup/ls/quote' && request.method === 'POST') {
    if (!layerswapBridge.fundConfigured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const tqWait = rateLimited(`mkttopupq:${ip}`, 30, 60 * 1000);
    if (tqWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(tqWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const wei = parseEthToWei(body.amountEth);
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }
    try {
      sendJson(response, 200, await layerswapBridge.quoteTopup(wei, body.source), { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Mint the transaction the member signs. Unlike the cash-out this is a NATIVE send, so the
  // money rides in `value` rather than inside calldata; createTopup decodes and checks the
  // recipient, the amount, the source chain and the memo length before any of it comes back.
  // Destination is pinned to the source address server-side: this can only pay the member's
  // own wallet on zkEVM.
  if (pathname === '/api/market/creatures/topup/ls/create' && request.method === 'POST') {
    if (!layerswapBridge.fundConfigured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const tcWait = rateLimited(`mkttopupc:${ip}`, 10, 60 * 1000);
    if (tcWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(tcWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.amountEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }
    try {
      sendJson(response, 200, await layerswapBridge.createTopup(wei, addr, body.source), { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Tracker poll. The swap id is opaque and carries no authority, so this needs no session:
  // it reveals only the state of a swap whose id you already hold. Direction-agnostic, so
  // the funding swaps above poll this same route.
  if (pathname === '/api/market/creatures/cashout/ls/status' && request.method === 'GET') {
    if (!layerswapBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const lsWait = rateLimited(`mktlsstatus:${ip}`, 60, 60 * 1000);
    if (lsWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(lsWait) }); return; }
    try {
      sendJson(response, 200, await layerswapBridge.getStatus(url.searchParams.get('id') || ''),
        { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- Canonical route health: the two hazards that live on Ethereum -------------------
  // Immutable's root bridge carries a global flow-rate guard. When it trips, EVERY withdrawal
  // is held for 24 hours regardless of size, and the member then has to send their own mainnet
  // transaction to finalise it. It trips on aggregate traffic, so someone withdrawing $20 can
  // be caught by strangers' volume, and it was active for roughly 92 hours over the first
  // eight months of 2026. Offering the canonical route blind during that window means promising
  // "a few minutes" and delivering a day plus a transaction they cannot afford.
  //
  // Separately, a single withdrawal above largeTransferThresholds is queued on its own.
  //
  // Both are plain view calls on the root bridge, which sits at the SAME address on Ethereum
  // as the child bridge does on zkEVM. Cached briefly: this is polled per cash-out screen and
  // the values change rarely.
  if (pathname === '/api/market/creatures/cashout/canonical/health' && request.method === 'GET') {
    const KEY = 'cashout:canonical:health';
    const cached = lastKnown.read(KEY, 60 * 1000);
    if (cached) { sendJson(response, 200, cached.data, { 'Cache-Control': 'public, max-age=30' }); return; }
    try {
      const [queueRaw, thrRaw] = await Promise.all([
        ethCall(ETH_RPC_URL, IMX_ROOT_BRIDGE, SEL_WITHDRAWAL_QUEUE_ACTIVATED),
        ethCall(ETH_RPC_URL, IMX_ROOT_BRIDGE, SEL_LARGE_TRANSFER_THRESHOLDS + IMX_NATIVE_ETH_SENTINEL),
      ]);
      const out = {
        queueActive: BigInt(queueRaw || '0x0') !== 0n,
        thresholdWei: BigInt(thrRaw || '0x0').toString(),
        checkedAt: new Date().toISOString(),
      };
      lastKnown.record(KEY, out);
      sendJson(response, 200, out, { 'Cache-Control': 'public, max-age=30' });
    } catch (err) {
      console.error('Canonical bridge health failed:', err.message);
      // Unknown must not read as safe. The client treats a null queueActive as "we could not
      // check" and says so, rather than quietly presenting the route as fine.
      sendJson(response, 200, { queueActive: null, thresholdWei: null, checkedAt: null },
        { 'Cache-Control': 'no-store' });
    }
    return;
  }

  // The move sizes Layerswap will accept right now, so the amount box can say so up front
  // rather than letting someone type a number that can only be refused.
  // The move sizes Layerswap will accept right now. The answer is the same for everybody and
  // it moves slowly, so it is held here rather than asked upstream once per caller: without a
  // cache this route is an open pipe pointed at Layerswap, and anyone could use our own server
  // to get us rate-limited off the route the cash-out defaults to.
  //
  // A dedicated cache rather than a slot in `lastKnown`. That store is a shared 128-key LRU
  // whose neighbours (creatures:browse:<query>, creatures:listings:<cursor>) mint a new key per
  // distinct query string, so a couple of minutes of ordinary browsing evicts anything written
  // only once every five minutes, which is precisely this. A cache that stops existing under
  // load is worse than none, because it reads as protection.
  if (pathname === '/api/market/creatures/cashout/ls/limits' && request.method === 'GET') {
    if (!layerswapBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const now = Date.now();
    // Anything we serve that is not a live read says so and says how old it is, the same way
    // the listings and browse routes label theirs.
    const stale = () => sendJson(response, 200,
      { ...lsLimits.data, stale: true, fetchedAt: new Date(lsLimits.at).toISOString() },
      { 'Cache-Control': 'no-store' });

    if (lsLimits.data && now - lsLimits.at < LS_LIMITS_TTL_MS) {
      sendJson(response, 200, lsLimits.data, { 'Cache-Control': 'public, max-age=60' });
      return;
    }
    // Upstream failed a moment ago. Lining every caller up behind the same timeout, to be
    // handed the same stale body at the end of it, is how a cache stops protecting the thing
    // it exists to protect at exactly the moment that thing is unhealthy.
    if (lsLimits.data && now - lsLimits.failedAt < LS_LIMITS_FAIL_MS) { stale(); return; }

    const llWait = rateLimited(`mktlslimits:${ip}`, 20, 60 * 1000);
    // A stale range beats a 429 from a route whose entire job is to state the range.
    if (llWait && lsLimits.data) { stale(); return; }
    if (llWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(llWait) }); return; }

    try {
      const limits = await layerswapBridge.limits();
      lsLimits = { data: limits, at: Date.now(), failedAt: 0 };
      sendJson(response, 200, limits, { 'Cache-Control': 'public, max-age=60' });
    } catch (err) {
      lsLimits.failedAt = Date.now();
      if (lsLimits.data) { stale(); return; }
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Standalone "Add funds" quote: the EXACT-INPUT funding move — "send X of your mainnet
  // ETH, receive ~Y ETH on Immutable zkEVM". The checkout-shortfall bridge (bridge/quote,
  // exact-output) stays for buys; this one powers the wallet-bar modal where the user
  // picks the amount themselves. Same cap + rate bucket as the cash-out quote.
  if (pathname === '/api/market/creatures/topup/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const tqWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (tqWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(tqWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.amountEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await squidBridge.quoteTopup(wei, addr));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Fiat on-ramp: mint a fresh, single-use card-on-ramp session via Immutable's hosted checkout
  // (rides Immutable's Transak account — no creds of ours, no dependency on our account being
  // provisioned).
  //   chain=zkevm    → network 'immutablezkevm': IMX (gas), ETH (the Creature price token) or
  //                    USDC. ETH here lands ON zkEVM, so a buyer starting from nothing needs no
  //                    mainnet ETH and no bridge. This contradicts an older note in this file
  //                    claiming Transak had no fiat→zkEVM-ETH product; Transak's own currency
  //                    list marks ETH buyable on immutablezkevm, and a minted session shows
  //                    "Immutablezkevm Network / ETH" in the widget. Re-check before narrowing.
  //   chain=ethereum → network 'ethereum', ETH (the LAND price token) or USDC.
  // `fiat` prefills the buy amount in USD (editable). The minted URL is single-use + expires in
  // ~5 min, so the client mints on click. On failure the client falls back (zkEVM → Immutable's
  // keyless hosted page; ethereum → hides the CTA).
  if (pathname === '/api/market/onramp' && request.method === 'GET') {
    const oWait = rateLimited(`mktonramp:${ip}`, 20, 60 * 1000);
    if (oWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(oWait) }); return; }

    const chain = String(url.searchParams.get('chain') || '');
    const addr = String(url.searchParams.get('address') || '').toLowerCase();
    const reqToken = String(url.searchParams.get('token') || 'ETH').toUpperCase();
    const fiatUsd = Number(url.searchParams.get('fiat'));
    // Delivery is pinned by network. zkEVM takes ETH (the Creature price token, delivered on
    // zkEVM so no bridge is involved), IMX (gas) and USDC; Ethereum takes ETH (the LAND price
    // token) and USDC. USDC delivery depends on Transak offering it for that network — if not,
    // the widget still opens and the buyer picks manually; the client falls back to Immutable's
    // keyless page (zkEVM) or hides the CTA (ethereum).
    const network = chain === 'zkevm' ? 'immutablezkevm' : chain === 'ethereum' ? 'ethereum' : null;
    const ALLOWED = { zkevm: ['ETH', 'IMX', 'USDC'], ethereum: ['ETH', 'USDC'] };
    if (!network) { sendJson(response, 400, { error: 'bad_chain' }); return; }
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!(ALLOWED[chain] || []).includes(reqToken)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    const token = reqToken;

    // referrerDomain: the request host (strip port) unless explicitly overridden.
    const referrerDomain = TRANSAK_REFERRER_DOMAIN
      || String(request.headers.host || '').split(':')[0]
      || 'localhost';
    try {
      const widgetUrl = await immutableOnrampUrl({ network, token, address: addr, fiatUsd, referrerDomain });
      sendJson(response, 200, { url: widgetUrl }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      console.error('On-ramp mint failed:', err.message);
      sendJson(response, 502, { error: 'onramp_unavailable' });
    }
    return;
  }

  // Live bridge progress for the in-panel tracker. Squid's status API is the primary
  // signal; before Squid indexes the tx (~1 min) we fall back to the source-chain
  // receipt so the tracker can still show "confirmed on Ethereum". `dir=out` flips the
  // chain pair for cash-out (zkEVM → mainnet) transactions — same stages, zkEVM receipt.
  if (pathname === '/api/market/creatures/bridge/status') {
    const sWait = rateLimited(`mktbst:${ip}`, 30, 60 * 1000);
    if (sWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(sWait) }); return; }

    const tx = String(url.searchParams.get('tx') || '').toLowerCase();
    const quoteId = String(url.searchParams.get('quoteId') || '').slice(0, 100);
    const requestId = String(url.searchParams.get('requestId') || '').slice(0, 100);
    const reverse = url.searchParams.get('dir') === 'out';
    if (!/^0x[0-9a-f]{64}$/.test(tx)) { sendJson(response, 400, { error: 'bad_tx' }); return; }
    if ((quoteId && !/^[\w-]+$/.test(quoteId)) || (requestId && !/^[\w-]+$/.test(requestId))) {
      sendJson(response, 400, { error: 'bad_request' }); return;
    }

    let squid = null;
    if (squidBridge.configured()) {
      try { squid = await squidBridge.getStatus({ txHash: tx, quoteId, requestId, reverse }); }
      catch (err) { console.error('Squid status failed:', err.message); }
    }
    const MAP = { success: 'arrived', ongoing: 'bridging', needs_gas: 'needs_gas', partial_success: 'failed', refund: 'failed' };
    let stage = MAP[squid?.squidStatus] || null;
    let destUrl = squid?.destUrl || null;
    // Squid's status indexer can lag a FINISHED bridge by 30+ minutes (a live cash-out
    // sat on "Crossing" while Axelar showed it executed after 72s) — so whenever Squid
    // hasn't given a terminal answer, ask Axelar's GMP API directly. Both bridge
    // directions ride Axelar, so this covers funding too.
    if (stage !== 'arrived' && stage !== 'failed' && stage !== 'needs_gas') {
      try {
        const ax = await squidBridge.getAxelarStatus(tx, { reverse });
        if (ax?.stage) { stage = ax.stage; destUrl = destUrl || ax.destUrl; }
      } catch (err) {
        console.error('Axelar status failed:', err.message);
      }
    }
    if (!stage) { // not indexed anywhere yet — check the source-chain receipt
      try {
        const rec = await ethGetTxReceipt(reverse ? ZK_RPC_URL : ETH_RPC_URL, tx);
        stage = rec ? (rec.status === '0x1' ? 'src_confirmed' : 'failed_src') : 'submitted';
      } catch (err) {
        console.error('Bridge receipt check failed:', err.message);
        stage = 'submitted'; // tracker stays at step 1 rather than erroring
      }
    }
    sendJson(response, 200, {
      stage,
      axelarUrl: squid?.axelarUrl || `https://axelarscan.io/gmp/${tx}`,
      srcUrl: squid?.srcUrl || null,
      destUrl,
    });
    return;
  }

  // Accept an offer (the holder sells into it): unsigned NFT-approval + fill txs.
  // For collection offers, tokenId picks which Creature is sold into the bid.
  if (pathname === '/api/market/creatures/offer/accept/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const aWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (aWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(aWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const offerId = String(body.offerId || '').toLowerCase();
    const taker = String(body.takerAddress || '').toLowerCase();
    const tokenId = body.tokenId != null ? String(body.tokenId) : null;
    // Multi-unit collection bids (buy.amount > 1) are filled one Creature at a time.
    const amountToFill = body.amountToFill != null ? String(body.amountToFill) : null;
    if (!ORDER_ID.test(offerId)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (tokenId != null && !/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (amountToFill != null && !/^[1-9]\d{0,2}$/.test(amountToFill)) { sendJson(response, 400, { error: 'bad_request' }); return; }

    try {
      const prepared = await mktOrderbook.prepareFulfill(offerId, taker, tokenId, amountToFill);
      sendJson(response, 200, prepared);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- LAND (Ethereum mainnet, via OpenSea) ---
  // Same shape as the Creature endpoints; different chain + protocol underneath.
  if (pathname === '/api/market/land/listings') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const [data, fx] = await Promise.all([
      landMarket.listListings(url.searchParams.get('cursor') || ''),
      getMarketplaceFx(),
    ]);
    sendJson(response, 200, { ...data, ethUsd: fx.ethUsd, fxRates: fx.fxRates }, { 'Cache-Control': 'public, max-age=30' });
    return;
  }
  // Active collection-wide offers ("standing offers") on LAND, best first. Read-only:
  // surfaces existing OpenSea demand so holders can see the floor bid. WETH-denominated.
  // Health envelope for a LAND response. `listings` is LAND's write-path source (the same
  // osFetch the buy/sell routes use), so it is what gates `trading` for this collection.
  const landHealth = (ok, snapshotAt = null, code = 'unavailable') => {
    if (ok) upstreamHealth.noteOk('land', 'listings');
    else upstreamHealth.noteFail('land', 'listings', code);
    const state = ok
      ? { state: 'live', asOf: Date.now(), ageMs: 0, error: null }
      : upstreamHealth.sourceState('land', 'listings', snapshotAt);
    return upstreamHealth.collectionHealth('land', { listings: state });
  };

  if (pathname === '/api/market/land/offers/collection') {
    if (!landMarket.configured()) {
      sendJson(response, 503, { error: 'not_configured', offers: null, health: landHealth(false, null, 'not_configured') }, { 'Cache-Control': 'no-store' });
      return;
    }
    const KEY = 'land:offers:collection';
    try {
      upstreamHealth.throwIfFaulted('land', 'listings');
      const [data, fx] = await Promise.all([landMarket.listCollectionOffers(), getMarketplaceFx()]);
      // Mixed book (WETH≈ETH + USDC): add an ETH-equivalent + USD estimate, re-rank best first.
      const offers = enrichZkOffers(data.offers, fx.ethUsd).sort((a, b) => (b.priceEth ?? 0) - (a.priceEth ?? 0));
      lastKnown.record(KEY, offers);
      sendJson(response, 200, { offers, health: landHealth(true) }, { 'Cache-Control': 'public, max-age=30' });
    } catch (err) {
      console.error('LAND collection offers failed:', err.message);
      const snap = lastKnown.read(KEY, upstreamHealth.MAX_AGE_MS.land);
      const health = landHealth(false, snap?.at ?? null, err.code === 'rate_limited' ? 'rate_limited' : 'unavailable');
      sendJson(response, snap ? 200 : (err.statusCode || 503), {
        offers: snap ? snap.data.map(o => ({ ...o, stale: true })) : null,
        ...(snap ? {} : { error: err.code || 'unavailable' }),
        health,
      }, { 'Cache-Control': 'no-store' });
    }
    return;
  }
  // Unified LAND browse: every parcel via its Slime — trait facets, rarity rank,
  // price when listed. (LAND and its Slime are one NFT — one browse, not two.)
  if (pathname === '/api/market/land/browse') {
    if (HEX_ADDRESS.test((url.searchParams.get('q') || '').trim().toLowerCase())) {
      const w = rateLimited(`mktwallet:${ip}`, 40, 60 * 1000);
      if (w) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(w) }); return; }
    }
    // The parcel catalogue is worth showing even when the OpenSea price layer is missing,
    // so a failure here degrades the listing data rather than 503ing the whole browse.
    try {
      upstreamHealth.throwIfFaulted('land', 'listings');
      const data = await getLandBrowse(url.searchParams);
      // getLandBrowse deliberately survives a missing price layer and still returns the
      // parcel catalogue. That is the right call for browsing, but it must not be reported
      // as a healthy market: with no OpenSea key every parcel reads as "not for sale".
      const priced = landMarket.configured();
      sendJson(response, 200, {
        ...data,
        health: priced ? landHealth(true) : landHealth(false, null, 'not_configured'),
      }, { 'Cache-Control': priced ? 'public, max-age=15' : 'no-store' }, { request, compress: true, etagIgnore: HEALTH_CLOCK_KEYS });
    } catch (err) {
      console.error('LAND browse failed:', err.message);
      sendJson(response, err.statusCode || 503, {
        error: err.code || 'unavailable',
        health: landHealth(false, null, err.code === 'rate_limited' ? 'rate_limited' : 'unavailable'),
      }, { 'Cache-Control': 'no-store' });
    }
    return;
  }
  // Recent completed LAND sales (OpenSea), filtered like the LAND Browse. Needs the OpenSea
  // key; without it (or on an upstream hiccup) the client shows a graceful "unavailable".
  if (pathname === '/api/market/land/sales') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    try {
      const data = await getLandSalesHistory(url.searchParams);
      sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=30' }, { request });
    } catch (err) {
      console.error('LAND sales history failed:', err.message);
      sendJson(response, 503, { error: 'unavailable' });
    }
    return;
  }
  const landTokenMatch = pathname.match(/^\/api\/market\/land\/token\/(\d{1,80})$/);
  if (landTokenMatch) {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const data = await landMarket.getToken(landTokenMatch[1]);
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=300' });
    return;
  }
  const landOwnedMatch = pathname.match(/^\/api\/market\/land\/owned\/(0x[0-9a-f]{40})$/);
  if (landOwnedMatch) {
    // Token ids come straight from the LAND contract (see landOwnedOnChain) — zero indexer
    // lag, no 200-parcel page cap. OpenSea remains only as the fallback for an RPC hiccup.
    let data;
    try {
      data = { items: await landOwnedOnChain(landOwnedMatch[1]), truncated: false };
    } catch (err) {
      console.error('Chain read of owned LAND failed, falling back to OpenSea:', err.message);
      if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
      data = await landMarket.ownedLand(landOwnedMatch[1]);
    }
    // Attach coords + slime traits + rank from the background sweep so the Sell/Transfer
    // pickers show the parcel's slime pet and filter like Browse. Sync peek (no build) —
    // sparse until the parcel is swept.
    const sidx = slimeIndex.getSlimeIndex();
    if (sidx) for (const it of (data.items || [])) {
      const s = sidx.byToken.get(String(it.tokenId));
      it.traits = s?.traits || {};
      it.rank = s?.rank ?? null;
      if (!it.coords && s?.coords) it.coords = s.coords;
      // Chain items carry a placeholder "#id" name — swap in the familiar "(x, y)" one.
      if (s?.coords && /#\d+$/.test(it.name || '')) it.name = `Highrise LAND (${s.coords.x}, ${s.coords.y})`;
    }
    sendJson(response, 200, data, { 'Cache-Control': 'no-store' });
    return;
  }
  // The parcel's attached Slime pet, rendered server-side from Highrise's public
  // pet-part assets into one self-contained SVG (see lib/land-pets.js). 404 when the
  // parcel has no pet — the client falls back to the plot image. Coords are the only
  // input and are pinned to integers, so this can't be used as an open proxy.
  const landPetMatch = pathname.match(/^\/api\/market\/land\/pet\/(-?\d{1,4})\/(-?\d{1,4})$/);
  if (landPetMatch) {
    const petWait = rateLimited(`landpet:${ip}`, 900, 60 * 1000); // image-grid budget; renders are cached + ETagged
    if (petWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(petWait) }); return; }
    try {
      const pet = await landPets.renderPet(Number(landPetMatch[1]), Number(landPetMatch[2]));
      if (pet.status !== 'ok') { sendJson(response, 404, { error: 'no_pet' }); return; }
      // CSP + sandbox neutralize any active content if the SVG is opened as a page
      // (as an <img> it's inert anyway); pets change rarely, so short-cache + ETag.
      const headers = {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600, must-revalidate',
        'ETag': pet.etag,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      };
      if (request.headers['if-none-match'] === pet.etag) {
        response.writeHead(304, headers);
        response.end();
      } else {
        response.writeHead(200, headers);
        response.end(pet.svg);
      }
    } catch (err) {
      console.error(`LAND pet ${landPetMatch[1]}:${landPetMatch[2]} render failed:`, err.message);
      sendJson(response, 503, { error: 'unavailable' });
    }
    return;
  }
  if (pathname === '/api/market/land/buy/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const bWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (bWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(bWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const orderHash = String(body.orderHash || '').toLowerCase();
    const protocolAddress = String(body.protocolAddress || '').toLowerCase();
    const taker = String(body.takerAddress || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderHash)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(protocolAddress)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareBuy({ orderHash, protocolAddress, taker }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Prepare accepting a LAND collection offer (sell a parcel INTO a standing bid): the
  // one-time conduit approval (if needed) + the Seaport fulfilment, both bound to the seller.
  if (pathname === '/api/market/land/offer/accept/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const aWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (aWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(aWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const orderHash = String(body.orderHash || '').toLowerCase();
    const protocolAddress = String(body.protocolAddress || '').toLowerCase();
    const tokenId = String(body.tokenId || '');
    const taker = String(body.takerAddress || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderHash)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(protocolAddress)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareAcceptOffer({ orderHash, protocolAddress, tokenId, taker }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Prepare a LAND listing: one-time conduit approval (if needed) + the Seaport order
  // typed-data the seller signs. Same trust model as the Creature sell flow; the order
  // is built server-side so the client can't smuggle a different collection or recipient.
  if (pathname === '/api/market/land/sell/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.sellEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const sWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (sWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(sWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    const tokenId = String(body.tokenId || '');
    // Currency: 'eth' (default, back-compat) or 'usdc'. Price arrives as `price` (+ currency);
    // legacy callers send `priceEth`. Converted at the currency's own decimals (ETH 18, USDC 6).
    const cur = landMarket.currency(body.currency || 'eth');
    const units = cur ? amountToUnits(body.price ?? body.priceEth, cur.decimals) : null;
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (!cur) { sendJson(response, 400, { error: 'bad_currency' }); return; }
    if (units == null || BigInt(units) <= 0n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareListing({
        tokenId, currency: cur.code, priceUnits: units, maker, durationDays: body.durationDays,
      }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the LAND listing from the signed order (relayed to OpenSea). The scope guard
  // in createListing keeps our API key from posting anything but LAND listings.
  if (pathname === '/api/market/land/sell/create' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.sellEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 32 * 1024);
    const { orderParameters, signature } = body || {};
    if (!orderParameters || typeof orderParameters !== 'object'
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    try {
      const created = await landMarket.createListing({ orderParameters, signature });
      // The new listing should appear on the "On sale" browse promptly. Drop the cached
      // listings snapshot now, and force-refresh it ~10s out — by then OpenSea has indexed
      // the order, so the refresh captures it (a plain re-fetch right now could re-cache a
      // still-missing snapshot for a full TTL). See landListingsByToken(force).
      slimeListingsCache.data = null;
      setTimeout(() => { landListingsByToken(true).catch(() => {}); }, 10000);
      sendJson(response, 200, created);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Prepare a LAND collection offer: WETH wrap/approval (if needed) + the Seaport order
  // (orderType 3 + OpenSea zone) the maker signs. The order is built server-side so the
  // client can't smuggle a different collection, recipient or fee.
  if (pathname === '/api/market/land/offer/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.offerEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const oWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (oWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(oWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    // Currency 'eth' (→WETH on-chain) or 'usdc'. Amount arrives as `price` (+ currency); legacy
    // callers send `priceEth`. ETH/USDC decimals match the listing registry (18 / 6).
    const cur = landMarket.currency(body.currency || 'eth');
    const units = cur ? amountToUnits(body.price ?? body.priceEth, cur.decimals) : null;
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!cur) { sendJson(response, 400, { error: 'bad_currency' }); return; }
    if (units == null || BigInt(units) <= 0n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareOffer({ makerAddress: maker, currency: cur.code, priceUnits: units, durationDays: body.durationDays }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the LAND offer from the signed order (relayed to OpenSea). createOffer's scope
  // guard keeps our API key from posting anything but a LAND collection offer.
  if (pathname === '/api/market/land/offer/create' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.offerEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 32 * 1024);
    const { orderParameters, signature, criteria } = body || {};
    if (!orderParameters || typeof orderParameters !== 'object'
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    try {
      sendJson(response, 200, await landMarket.createOffer({ orderParameters, signature, criteria }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // The caller's own active LAND listings (for "my listings" + cancel). Public on-chain
  // data keyed to the connected wallet — no-store so it's never shared-cached.
  const landMineMatch = pathname.match(/^\/api\/market\/land\/mine\/(0x[0-9a-f]{40})$/);
  if (landMineMatch) {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    try {
      const data = await landMarket.myListings(landMineMatch[1]);
      // Attach coords + slime traits (same sweep join as /owned) so "My listings" shows the
      // parcel's slime pet, matching the grid + pickers rather than the flat plot tile.
      const sidx = slimeIndex.getSlimeIndex();
      if (sidx) for (const it of (data.items || [])) {
        const s = sidx.byToken.get(String(it.tokenId));
        if (s) { it.coords = s.coords; it.traits = s.traits; it.rank = s.rank ?? null; }
      }
      sendJson(response, 200, data, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // The "History" tab for LAND: the wallet's past buys, sales and transfers, from OpenSea's
  // account events feed. Heavier than mine/owned (a bounded multi-page scan), so it carries
  // its own modest per-IP limit. Wallet-keyed — never shared-cache.
  const landHistoryMatch = pathname.match(/^\/api\/market\/land\/history\/(0x[0-9a-f]{40})$/);
  if (landHistoryMatch) {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const hWait = rateLimited(`mkthist:${ip}`, 15, 60 * 1000);
    if (hWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(hWait) }); return; }
    try {
      sendJson(response, 200, await landMarket.myHistory(landHistoryMatch[1]), { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // The caller's own active LAND offers (for "your offers" + cancel). Public on-chain data
  // keyed to the connected wallet — no-store so it's never shared-cached.
  const landOffersMineMatch = pathname.match(/^\/api\/market\/land\/offers\/mine\/(0x[0-9a-f]{40})$/);
  if (landOffersMineMatch) {
    if (!landMarket.configured()) {
      sendJson(response, 503, { error: 'not_configured', offers: null, health: landHealth(false, null, 'not_configured') }, { 'Cache-Control': 'no-store' });
      return;
    }
    try {
      upstreamHealth.throwIfFaulted('land', 'listings');
      const [data, fx] = await Promise.all([landMarket.myOffers(landOffersMineMatch[1]), getMarketplaceFx()]);
      sendJson(response, 200, { offers: enrichZkOffers(data.offers, fx.ethUsd), health: landHealth(true) }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      // `offers: null`, never [] — see the Creature equivalent. "You have no offers out"
      // when we simply could not ask invites a duplicate bid.
      console.error('LAND my offers failed:', err.message);
      sendJson(response, err.statusCode || 503, {
        error: err.code || 'unavailable', offers: null,
        health: landHealth(false, null, err.code === 'rate_limited' ? 'rate_limited' : 'unavailable'),
      }, { 'Cache-Control': 'no-store' });
    }
    return;
  }

  // Prepare an on-chain Seaport cancel for one of the caller's own LAND listings. Only
  // the order's offerer can produce a valid cancel — Seaport enforces it, and we re-check.
  if (pathname === '/api/market/land/cancel/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const kWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (kWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(kWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const orderHash = String(body.orderHash || '').toLowerCase();
    const maker = String(body.accountAddress || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderHash)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    try {
      sendJson(response, 200, await landMarket.prepareCancel({ orderHash, maker }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

// --- Council auth + eligibility API ---
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds, mirrors db.js SESSION_TTL_MS

// The public read payloads here are big — the trait showcase is ~160KB, market stats
// ~37KB, a browse page ~20KB — and they gzip to roughly a sixth. Passing `opts.request`
// opts a response into that: the request is what lets us read Accept-Encoding and answer
// a conditional GET with a 304.
//
// Compression is deliberately NOT blanket. When a response mixes a secret with
// attacker-supplied input, its compressed SIZE leaks the secret (BREACH). Only responses
// already marked `public` compress — every user-scoped response on this server is
// `no-store` — plus the big public payloads that must stay no-store (the degraded market
// snapshots), which opt in explicitly with `compress: true`.
// The health envelope re-stamps these every time it is built, so they are the only reason
// two otherwise identical market responses differ. Excluded from the validator (never from
// the body) so revalidation can actually 304 — see `etagIgnore` below.
const HEALTH_CLOCK_KEYS = ['checkedAt', 'asOf', 'ageMs'];
const JSON_GZIP_MIN_BYTES = 1024; // below this, gzip costs more than it saves
const JSON_GZIP_CACHE_MAX = 64;
const jsonGzipCache = new Map();  // etag -> gzipped Buffer; snapshot-backed bodies repeat a lot

function sendJson(response, status, obj, extraHeaders = {}, opts = {}) {
  const request = opts.request;
  const cacheControl = extraHeaders['Cache-Control'] ?? 'no-store';
  const isPublic = String(cacheControl).split(',').some(p => p.trim() === 'public');
  const body = Buffer.from(JSON.stringify(obj), 'utf8');

  // Weak, content-derived and encoding-agnostic, so one validator covers both the gzipped
  // and identity copies — the same convention the static handler uses. Only cacheable
  // responses get one: a `no-store` client can never send If-None-Match back.
  //
  // `etagIgnore` names keys whose value moves on every request even when the answer is
  // identical (the health envelope's liveness clock). Left in, they made the validator
  // useless: no two responses ever matched. Only clocks belong in that list — everything
  // that changes what the client DOES (health.state, trading, error) stays in the hash, so
  // a 304 can only ever repeat a response the client can still act on.
  const etagSource = request && opts.etagIgnore
    ? Buffer.from(JSON.stringify(obj, (k, v) => (opts.etagIgnore.includes(k) ? undefined : v)), 'utf8')
    : body;
  const etag = request && isPublic && status === 200
    ? 'W/"' + crypto.createHash('sha1').update(etagSource).digest('base64').slice(0, 27) + '"'
    : null;
  // Vary tracks whether this body COULD differ by encoding, not what this caller accepts —
  // otherwise a shared cache could hand an identity copy to a client that wanted gzip.
  const compressible = body.length >= JSON_GZIP_MIN_BYTES && (isPublic || opts.compress === true);
  const gzipWanted = compressible && !!request
    && String(request.headers['accept-encoding'] || '').includes('gzip');

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
    ...(etag ? { ETag: etag } : {}),
    ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
  };

  if (etag && request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const sendRaw = () => {
    response.writeHead(status, { ...headers, 'Content-Length': String(body.length) });
    response.end(body);
  };
  if (!gzipWanted) { sendRaw(); return; }

  const sendGz = gz => {
    response.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': String(gz.length) });
    response.end(gz);
  };
  const cached = etag ? jsonGzipCache.get(etag) : null;
  if (cached) { sendGz(cached); return; }
  zlib.gzip(body, (err, gz) => {
    if (response.writableEnded || response.destroyed) return;
    if (err || gz.length >= body.length) { sendRaw(); return; }
    if (etag) {
      if (jsonGzipCache.size >= JSON_GZIP_CACHE_MAX) jsonGzipCache.delete(jsonGzipCache.keys().next().value);
      jsonGzipCache.set(etag, gz);
    }
    sendGz(gz);
  });
}

// Who is calling, for rate-limiting purposes.
//
// Every bucket on this site keys off this, so getting it wrong doesn't weaken a limit, it
// deletes it. The old expression — take the FIRST entry of X-Forwarded-For — read a header
// the caller writes: send a different forged address per request and you get a fresh bucket
// each time, so 6-a-minute becomes unlimited. Our proxy APPENDS the address it actually saw,
// which puts the only trustworthy entry at the RIGHT-hand end, one place per proxy in front
// of us. So count from the right. TRUSTED_PROXY_HOPS is 1 for Railway; set it to 0 when
// nothing fronts this process (the header is then pure fiction and the socket is the truth),
// or 2 if a CDN is ever put in front of Railway.
// Parsed strictly, because the two ways of being wrong are not symmetric. A blank Railway
// variable or a typo used to land on 0 — `Number('')` is 0, and `NaN || 0` is 0 — which is the
// deliberate "nothing fronts this process" setting. Behind a proxy that means every visitor
// keys to the proxy's own address, so every bucket on the site silently becomes one global
// counter and a handful of people 429 everybody else, with nothing in the logs to say why.
// Anything unparseable falls back to the default and says so out loud.
const TRUSTED_PROXY_HOPS = (() => {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0 || n > 8) {
    console.error(`[proxy] TRUSTED_PROXY_HOPS is "${raw}", which is not a hop count — using 1. Set it to 0 only when nothing fronts this process.`);
    return 1;
  }
  return n;
})();
function clientIp(request) {
  const socket = request.socket?.remoteAddress || 'unknown';
  if (!TRUSTED_PROXY_HOPS) return socket;
  const chain = String(request.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  // Fewer entries than there are proxies means this request did not come through them — a
  // direct hit, a local run, a health probe. The header is then whatever the caller invented,
  // so ignore it and use the socket.
  if (chain.length < TRUSTED_PROXY_HOPS) return socket;
  const hop = chain[chain.length - TRUSTED_PROXY_HOPS];
  // A proxy only ever writes an address here. Anything else is forged, and letting it become
  // a bucket key would hand a caller both a fresh limit and a place to store megabytes.
  return /^[0-9a-fA-F:.[\]]{3,45}$/.test(hop) ? hop : socket;
}

// Crude in-memory fixed-window rate limiter (resets on restart). Returns the
// Retry-After seconds if the key is over `max` within `windowMs`, else 0.
const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
  b.count++;
  return b.count > max ? Math.max(1, Math.ceil((b.reset - now) / 1000)) : 0;
}

// Where the OAuth round-trip lands back on the site. Sign-in buttons live on more
// than one page now (Council › Apply & Vote, Polls & Votes), so the login endpoint
// remembers which one started the flow in a short-lived cookie — allowlisted paths
// only, so a crafted link can never turn the callback into an open redirect.
const RETURN_COOKIE = 'hcc_return';
const RETURN_PATHS = new Set(['/council/vote', '/polls', '/trade']);
// Validate an untrusted return target against the allowlist; anything else falls back
// to the Council vote page. Shared by login (reads it from the round-trip cookie) and
// logout (reads it straight from the ?return= query param).
function safeReturnPath(raw) {
  return RETURN_PATHS.has(raw) ? raw : '/council/vote';
}
function returnPathFrom(cookies) {
  return safeReturnPath(cookies?.[RETURN_COOKIE]);
}

// Send the user back to the panel that started the sign-in; `error` (if set) is
// read by the front-end (apply.js / polls.js render it as a friendly alert).
function redirectToApp(request, response, error) {
  const cookies = auth.parseCookies(request);
  const base = returnPathFrom(cookies);
  const location = error ? `${base}?auth=${encodeURIComponent(error)}` : base;
  response.writeHead(302, {
    Location: location,
    'Set-Cookie': auth.serializeCookie(RETURN_COOKIE, '', { maxAge: 0, secure: auth.isSecure(request) }),
    'Cache-Control': 'no-store',
  });
  response.end();
}

// True when the holdings-derived parts of two eligibility snapshots differ.
function eligibilityChanged(a, b) {
  return a.creatureCount !== b.creatureCount
    || a.landCount !== b.landCount
    || a.totalCount !== b.totalCount
    || a.bracket !== b.bracket
    || a.canRun !== b.canRun
    || a.isMember !== b.isMember
    || a.holdsNow !== b.holdsNow;
}

// Recompute a session's eligibility against the CURRENT holder snapshot, so holdings
// changes (buys/sells, estate moves, or a cold-cache login) reflect without re-login.
// Cheap: getWalletHoldings reads the in-memory holder cache (warming it once if needed)
// — no chain or Highrise calls. Returns the stored snapshot UNCHANGED when there's no
// linked wallet, the holder data isn't available, or the lookup fails, so a transient
// outage can never wrongly downgrade a real holder to "0 assets". When holdings did
// change, it converges the session, the public applicant row, and the audit trail
// (out of band, so the response is never blocked on those writes).
async function refreshEligibility(session, sid) {
  const stored = session.eligibility || {};
  if (!stored.ethWallet) return stored; // no linked wallet — nothing to recompute

  let holdings;
  try { holdings = await getWalletHoldings(stored.ethWallet); }
  catch (err) { console.error('Eligibility refresh failed:', err.message); return stored; }
  if (!holdings.holdersAvailable) return stored; // can't determine right now — keep last known

  const fresh = {
    linked: stored.linked,
    ethWallet: stored.ethWallet,
    holdersAvailable: true,
    ...computeEligibility(holdings),
  };
  if (!eligibilityChanged(stored, fresh)) return fresh;

  session.eligibility = fresh; // keep the in-request copy consistent
  (async () => {
    try {
      if (sid) await db.updateSessionEligibility(sid, fresh);
      await db.upsertApplicant({
        discordId: session.discord_id,
        discordUsername: session.profile?.username,
        ethWallet: fresh.ethWallet,
        creatureCount: fresh.creatureCount,
        landCount: fresh.landCount,
        totalCount: fresh.totalCount,
        bracket: fresh.bracket,
        canRun: fresh.canRun,
      });
      db.recordEvent({
        event: 'eligibility.changed',
        discordId: session.discord_id,
        detail: {
          from: { totalCount: stored.totalCount ?? null, bracket: stored.bracket ?? null, canRun: !!stored.canRun },
          to:   { totalCount: fresh.totalCount, bracket: fresh.bracket, canRun: fresh.canRun },
        },
      });
    } catch (err) { console.error('Eligibility persist failed:', err.message); }
  })();
  return fresh;
}

// Shape a session profile for the client. ONLY the fields the UI renders are sent —
// the Discord id, Highrise user id, guild flag and raw server/Highrise names stay
// server-side. They're identifiers the front-end never needs, and the Highrise user
// id in particular must never reach a browser (it keys the Highrise wallet/profile API).
function publicProfile(p) {
  if (!p) return {};
  return {
    username: p.username || null,
    avatar: p.avatar || null,
    highriseIcon: p.highriseIcon || null,
  };
}

async function handleAuthApi(request, response, url) {
  const { pathname } = url;

  // Step 1 — begin OAuth: redirect to Discord with a CSRF state cookie. An optional
  // ?return= names the page that started the flow (allowlisted — see RETURN_PATHS)
  // so the callback can land the user back where they were.
  if (pathname === '/api/auth/discord/login') {
    if (!auth.isConfigured()) { sendJson(response, 503, { error: 'Discord login is not configured.' }); return; }
    const { location, stateCookie } = auth.buildLoginRedirect(request);
    const wanted = url.searchParams.get('return') || '';
    const secure = auth.isSecure(request);
    const returnCookie = RETURN_PATHS.has(wanted)
      ? auth.serializeCookie(RETURN_COOKIE, wanted, { maxAge: 600, secure })
      : auth.serializeCookie(RETURN_COOKIE, '', { maxAge: 0, secure });
    response.writeHead(302, { Location: location, 'Set-Cookie': [stateCookie, returnCookie], 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  // Step 2 — OAuth callback: verify state, exchange code, look up wallet + eligibility.
  if (pathname === '/api/auth/discord/callback') {
    const cookies = auth.parseCookies(request);
    if (url.searchParams.get('error')) {
      db.recordEvent({ event: 'auth.denied', ok: false, detail: { error: url.searchParams.get('error') } });
      return redirectToApp(request, response, 'denied');
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== cookies[auth.STATE_COOKIE]) {
      db.recordEvent({ event: 'auth.state_mismatch', ok: false });
      return redirectToApp(request, response, 'state');
    }

    // Track which step fails so the logs pinpoint config/connectivity issues
    // (token exchange, Discord, Highrise, holder lookup, or DB).
    let stage = 'exchangeCode';
    try {
      const token = await auth.exchangeCode(code, request);
      stage = 'fetchDiscordUser';
      const profile = await auth.fetchDiscordUser(token.access_token);
      stage = 'fetchGuildMember';
      const guild = await auth.fetchGuildDisplayName(token.access_token);
      stage = 'fetchHighriseWallet';
      const wallet = await auth.fetchHighriseWallet(profile.id);

      let holdings = { creatureCount: 0, landCount: 0, holdersAvailable: false };
      if (wallet.ethWallet) { stage = 'getWalletHoldings'; holdings = await getWalletHoldings(wallet.ethWallet); }

      // Highrise profile (avatar pic + in-game name) by user_id from the wallet lookup.
      stage = 'fetchHighriseProfile';
      const highrise = await auth.fetchHighriseProfile(wallet.userId);

      const eligibility = {
        linked: wallet.linked,
        ethWallet: wallet.ethWallet,
        holdersAvailable: holdings.holdersAvailable,
        ...computeEligibility(holdings),
      };

      // Ballot name = Highrise username (falls back to Highrise Discord display/global name).
      const sessionProfile = {
        id: profile.id,
        username: profile.username,
        avatar: profile.avatar,
        serverName: guild.serverName,
        inGuild: guild.inGuild,
        highriseName: highrise?.name || null,
        highriseIcon: highrise?.iconUrl || null,
        highriseUserId: wallet.userId || null,
      };
      stage = 'createSession';
      const sid = await db.createSession(profile.id, sessionProfile, eligibility);
      stage = 'upsertApplicant';
      await db.upsertApplicant({
        discordId: profile.id,
        discordUsername: profile.username,
        ethWallet: wallet.ethWallet,
        creatureCount: eligibility.creatureCount,
        landCount: eligibility.landCount,
        totalCount: eligibility.totalCount,
        bracket: eligibility.bracket,
        canRun: eligibility.canRun,
      });
      // Self-heal a candidate's stored avatar on every login (best-effort, no await).
      db.updateApplicationAvatar(profile.id, safeIconUrl(sessionProfile.highriseIcon));

      // Self-heal an opted-in holder profile too: the Highrise name, icon and linked
      // wallet can all change between visits, and the public page must track them. A
      // wallet that's been UNLINKED removes the page outright — with no wallet there's
      // nothing to show, and keeping the old one public would misattribute whoever
      // holds that wallet next. Best-effort, off the response path.
      (async () => {
        try {
          const hp = await db.getHolderProfileByDiscord(profile.id);
          if (!hp) return;
          if (!wallet.linked || !wallet.ethWallet) { await db.deleteHolderProfile(profile.id); return; }
          const anchor = String(wallet.ethWallet).toLowerCase();
          await db.upsertHolderProfile({
            discordId: profile.id,
            slug: await holderProfileSlug(sessionProfile, profile.id),
            displayName: holderDisplayName(sessionProfile),
            avatar: safeIconUrl(sessionProfile.highriseIcon),
            ethWallet: anchor,
          });
          // Keep the Highrise wallet anchored in the showcase wallet set too.
          db.setHighriseAnchor(profile.id, anchor).catch(() => {});
        } catch (err) { console.error('Holder profile self-heal failed:', err.message); }
      })();

      db.recordEvent({
        event: 'auth.login',
        discordId: profile.id,
        detail: {
          username: profile.username,
          highriseName: highrise?.name || null,
          inGuild: guild.inGuild,
          linked: wallet.linked,
          ethWallet: wallet.ethWallet,
          creatureCount: eligibility.creatureCount,
          landCount: eligibility.landCount,
          totalCount: eligibility.totalCount,
          bracket: eligibility.bracket,
          canRun: eligibility.canRun,
          holdersAvailable: eligibility.holdersAvailable,
        },
      });

      const secure = auth.isSecure(request);
      response.writeHead(302, {
        Location: returnPathFrom(cookies),
        'Set-Cookie': [
          auth.serializeCookie(auth.SESSION_COOKIE, sid, { maxAge: SESSION_MAX_AGE, secure }),
          auth.serializeCookie(auth.STATE_COOKIE, '', { maxAge: 0, secure }),
          auth.serializeCookie(RETURN_COOKIE, '', { maxAge: 0, secure }),
        ],
        'Cache-Control': 'no-store',
      });
      response.end();
    } catch (err) {
      console.error(`OAuth callback failed at stage "${stage}":`, err.message);
      db.recordEvent({ event: 'auth.callback_error', ok: false, detail: { stage, message: err.message } });
      redirectToApp(request, response, 'failed');
    }
    return;
  }

  // Current session + eligibility for the logged-in user.
  if (pathname === '/api/me') {
    const cookies = auth.parseCookies(request);
    const sid = cookies[auth.SESSION_COOKIE];
    const session = await db.getSession(sid);
    if (!session) { sendJson(response, 200, { authenticated: false }); return; }
    // Own holder-profile state (enabled + slug only) so the marketplace toggle can
    // render without a second round-trip. Never anyone else's row.
    const holderProfile = await db.getHolderProfileByDiscord(session.discord_id).catch(() => null);
    // The caller's own showcase wallets, so the marketplace manage-wallets UI renders without
    // a second round-trip. Own data only — never anyone else's linked wallets.
    const linkedWallets = holderProfile
      ? await db.getLinkedWallets(session.discord_id, session.eligibility?.ethWallet).catch(() => [])
      : [];
    sendJson(response, 200, {
      authenticated: true,
      profile: publicProfile(session.profile),
      // Election phase (non-sensitive — same flags the public board exposes) so the
      // eligibility card can hide "Run for a seat" once candidacy closes and steer
      // eligible holders to the ballot once voting opens.
      phase: { applicationsOpen: APPLICATIONS_OPEN, votingOpen: VOTING_OPEN, resultsOpen: RESULTS_OPEN },
      // Recompute against current holdings so the panel reflects buys/sells without re-login.
      eligibility: await refreshEligibility(session, sid),
      holderProfile: holderProfile
        ? { enabled: true, slug: holderProfile.slug, wallets: linkedWallets }
        : { enabled: false },
    });
    return;
  }

  // Dev-only login (optional local module; absent from the deployed build).
  if (pathname === '/api/auth/dev-login') {
    if (devLogin) return devLogin(request, response, url);
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  // Logout. Returns the user to the page they logged out from (?return=, allowlisted)
  // so signing out on Polls doesn't bounce them over to Council; defaults to the
  // Council vote page. All these pages render fine signed-out (they show the sign-in
  // gate), so returning in place is the least surprising behaviour.
  if (pathname === '/api/auth/logout') {
    const cookies = auth.parseCookies(request);
    const sid = cookies[auth.SESSION_COOKIE];
    const endingSession = await db.getSession(sid);
    await db.deleteSession(sid);
    db.recordEvent({ event: 'auth.logout', discordId: endingSession?.discord_id || null });
    response.writeHead(302, {
      Location: safeReturnPath(url.searchParams.get('return')),
      'Set-Cookie': auth.serializeCookie(auth.SESSION_COOKIE, '', { maxAge: 0, secure: auth.isSecure(request) }),
      'Cache-Control': 'no-store',
    });
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

// --- Public holder profiles (opt-in showcase pages) ---
// The ONE place the site ever links a wallet to an off-chain identity in public —
// and only because the holder explicitly turned it on. Everything here is derived
// server-side from the session (never client-supplied), the public payload carries
// no Discord id / Highrise user_id (same rule as publicProfile), and disabling
// hard-deletes the row (see lib/db.js).

// Display name mirrors the ballot-name precedence: Highrise username →
// Highrise-guild nickname → Discord username.
function holderDisplayName(p) {
  return String(p?.highriseName || p?.serverName || p?.username || '').slice(0, 40);
}

// URL slug from the display name: lowercase, runs of anything outside [a-z0-9]
// collapse to '-'. Must satisfy the clean-route charset (see TAB_ROUTES serving) so
// /profile/{slug} serves the app shell. A name that slugs to nothing (e.g. an
// all-emoji name) falls back to a short stable hash of the Discord id, same trick
// as candidateId — the hash reveals nothing.
function slugifyHolderName(name, discordId) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || crypto.createHash('sha256').update(`hp:${discordId}`).digest('hex').slice(0, 8);
}

// Final slug: distinct names can collapse to the same slug ("a.b" and "a_b" → "a-b"),
// so a clash owned by ANOTHER account gets a short stable suffix instead of failing.
async function holderProfileSlug(sessionProfile, discordId) {
  const base = slugifyHolderName(holderDisplayName(sessionProfile), discordId);
  const clash = await db.getHolderProfileBySlug(base);
  if (!clash || clash.discord_id === discordId) return base;
  return `${base}-${crypto.createHash('sha256').update(`hp:${discordId}`).digest('hex').slice(0, 6)}`;
}

const PROFILE_SLUG_RE = /^[a-z0-9-]{1,40}$/;
const HEX_ADDR_RE = /^0x[0-9a-f]{40}$/;

// Wallet-link challenges: one single-use, short-lived nonce per member. The FULL message
// is minted and stored server-side and verified against the stored copy, so the client
// can't tamper with what was signed. Signing proves control; it never authorizes a
// transaction. The message names the claiming Discord account on purpose: if a scammer
// tries to phish someone else into signing their challenge, the victim's wallet prompt
// spells out whose profile would claim the wallet — and even a successfully phished
// signature only squats until the true owner re-signs (verifyWallet is latest-proof-wins).
const walletNonces = new Map(); // discord_id -> { message, exp }
const WALLET_NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_LINKED_WALLETS = 10;

function walletLinkMessage(nonce, accountName, discordId) {
  return 'Highrise Creature Club\n\n'
    + 'Link this wallet to your public holder profile.\n'
    + 'Signing proves you control this wallet. It does NOT approve any transaction or spend.\n\n'
    + `Discord account: ${accountName || 'unknown'} (${discordId})\n`
    + `Nonce: ${nonce}`;
}

// Sum authoritative holdings across a profile's showcase wallets. SHOWCASE ONLY — this
// never feeds Council eligibility or voting, which stay bound to the single Highrise wallet.
async function aggregateWalletHoldings(wallets) {
  const results = await Promise.all((wallets || []).map(w => getWalletHoldings(w.wallet).catch(() => null)));
  let creatureCount = 0, landCount = 0;
  for (const h of results) { if (h) { creatureCount += h.creatureCount || 0; landCount += h.landCount || 0; } }
  return { creatureCount, landCount };
}

async function handleProfileApi(request, response, url) {
  const { pathname } = url;
  const ip = clientIp(request);

  // Turn the caller's OWN profile on. Requires a session with a linked Highrise
  // wallet — the wallet is what the page shows, so without one there's no profile.
  if ((pathname === '/api/profile/enable' || pathname === '/api/profile/disable') && request.method === 'POST') {
    const cookies = auth.parseCookies(request);
    const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
    if (!session) { sendJson(response, 401, { error: 'not_signed_in' }); return; }

    if (pathname === '/api/profile/disable') {
      await db.deleteHolderProfile(session.discord_id);
      db.recordEvent({ event: 'profile.disabled', discordId: session.discord_id });
      sendJson(response, 200, { enabled: false }, { 'Cache-Control': 'no-store' });
      return;
    }

    const elig = session.eligibility || {};
    if (!elig.linked || !elig.ethWallet) { sendJson(response, 400, { error: 'no_wallet' }); return; }
    const slug = await holderProfileSlug(session.profile, session.discord_id);
    const highriseWallet = String(elig.ethWallet).toLowerCase();
    await db.upsertHolderProfile({
      discordId: session.discord_id,
      slug,
      displayName: holderDisplayName(session.profile),
      avatar: safeIconUrl(session.profile?.highriseIcon),
      ethWallet: highriseWallet,
    });
    // Anchor the Highrise wallet in linked_wallets so it's the always-present, non-removable
    // first wallet on the showcase (best-effort — the profile works from eth_wallet regardless).
    db.setHighriseAnchor(session.discord_id, highriseWallet).catch(() => {});
    db.recordEvent({ event: 'profile.enabled', discordId: session.discord_id, detail: { slug } });
    sendJson(response, 200, { enabled: true, slug }, { 'Cache-Control': 'no-store' });
    return;
  }

  // --- Manage the showcase wallets (session required throughout) ---

  // Issue a single-use challenge for the caller to sign with the wallet they want to add.
  if (pathname === '/api/profile/wallets/nonce' && request.method === 'POST') {
    const cookies = auth.parseCookies(request);
    const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
    if (!session) { sendJson(response, 401, { error: 'not_signed_in' }); return; }
    const wait = rateLimited(`wnonce:${session.discord_id}`, 20, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(wait) }); return; }
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = walletLinkMessage(nonce, holderDisplayName(session.profile), session.discord_id);
    walletNonces.set(session.discord_id, { message, exp: Date.now() + WALLET_NONCE_TTL_MS });
    sendJson(response, 200, { message }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Verify a wallet by proving control: the recovered signer IS the wallet we verify — we
  // never trust a client-supplied address. Signing the Highrise wallet is allowed and simply
  // upgrades it to verified (true ownership). Nonce is single-use and rebuilt server-side.
  if (pathname === '/api/profile/wallets/link' && request.method === 'POST') {
    const cookies = auth.parseCookies(request);
    const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
    if (!session) { sendJson(response, 401, { error: 'not_signed_in' }); return; }
    // Bad signatures don't consume the nonce (a fumbled wallet prompt shouldn't force a
    // re-mint), so cap attempts per member — keeps ecrecover from being hammered for free.
    const wait = rateLimited(`wlink:${session.discord_id}`, 20, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(wait) }); return; }
    const challenge = walletNonces.get(session.discord_id);
    if (!challenge || challenge.exp < Date.now()) { sendJson(response, 400, { error: 'nonce_expired' }); return; }
    const body = await readJsonBody(request, 4 * 1024).catch(() => null);
    const signature = body && typeof body.signature === 'string' ? body.signature : '';
    const signer = recoverPersonalSignAddress(challenge.message, signature);
    if (!signer || !HEX_ADDR_RE.test(signer)) { sendJson(response, 400, { error: 'bad_signature' }); return; }
    walletNonces.delete(session.discord_id); // single-use, win or lose
    const anchor = String(session.eligibility?.ethWallet || '').toLowerCase();
    const existing = await db.getLinkedWallets(session.discord_id, anchor);
    if (existing.length >= MAX_LINKED_WALLETS && !existing.some(w => w.wallet === signer)) {
      sendJson(response, 400, { error: 'too_many' }); return;
    }
    const res = await db.verifyWallet(session.discord_id, signer);
    if (!res.ok) { sendJson(response, 409, { error: 'wallet_taken' }); return; } // concurrent-verify backstop
    db.recordEvent({ event: 'profile.wallet_verified', discordId: session.discord_id, detail: { wallet: maskWallet(signer) } });
    // A transfer means the previous holder just lost the badge to a fresh key proof —
    // log both sides so any squatting/reclaim dispute has a server-side trail.
    if (res.reclaimedFrom) {
      db.recordEvent({
        event: 'profile.wallet_reclaimed', discordId: session.discord_id,
        detail: { wallet: maskWallet(signer), from: res.reclaimedFrom },
      });
    }
    sendJson(response, 200, { linked: true, wallets: await db.getLinkedWallets(session.discord_id, anchor) }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Remove a connected wallet (the Highrise anchor is protected in the DB layer).
  if (pathname === '/api/profile/wallets/unlink' && request.method === 'POST') {
    const cookies = auth.parseCookies(request);
    const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
    if (!session) { sendJson(response, 401, { error: 'not_signed_in' }); return; }
    const body = await readJsonBody(request, 4 * 1024).catch(() => null);
    const wallet = body && typeof body.wallet === 'string' ? body.wallet.toLowerCase() : '';
    if (!HEX_ADDR_RE.test(wallet)) { sendJson(response, 400, { error: 'bad_wallet' }); return; }
    await db.unlinkWallet(session.discord_id, wallet);
    db.recordEvent({ event: 'profile.wallet_unlinked', discordId: session.discord_id, detail: { wallet: maskWallet(wallet) } });
    sendJson(response, 200, { wallets: await db.getLinkedWallets(session.discord_id, session.eligibility?.ethWallet) }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Public read — "who holds this wallet", for the marketplace asset card so a buyer
  // knows who to message. Same consent model as the profile page: only holders who
  // opted in appear, and only their already-public display fields (never a Discord id).
  // Ambiguity is resolved conservatively: the signature-verified owner wins; failing
  // that, a lone Highrise-link is shown (flagged unverified); two or more competing
  // unverified claims resolve to nothing rather than naming the wrong member.
  const bw = pathname.match(/^\/api\/profile\/by-wallet\/(0x[0-9a-fA-F]{40})$/);
  if (bw && request.method === 'GET') {
    const wait = rateLimited(`profwallet:${ip}`, 120, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(wait) }); return; }
    const claims = await db.getProfilesForWallet(bw[1].toLowerCase()).catch(() => []);
    const verified = claims.find(c => c.verified) || null;
    const unverified = claims.filter(c => !c.verified);
    const pick = verified || (unverified.length === 1 ? unverified[0] : null);
    sendJson(response, 200, { profile: pick, claims: claims.length }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Public read — the payload behind /profile/{slug}. Only rows that exist (= holders
  // who opted in), only display fields + the wallet they chose to showcase. Counts
  // come from the same authoritative per-wallet read the Council eligibility uses
  // (includes estate-locked LAND, which the browse feed deliberately omits).
  const m = pathname.match(/^\/api\/profile\/([a-z0-9-]{1,40})$/);
  if (m && request.method === 'GET') {
    const wait = rateLimited(`profile:${ip}`, 60, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(wait) }); return; }
    if (!PROFILE_SLUG_RE.test(m[1])) { sendJson(response, 404, { error: 'not_found' }); return; }
    const resolved = await db.getProfileWalletsBySlug(m[1]);
    // no-store both ways: a just-disabled profile must 404 on the very next load.
    if (!resolved) { sendJson(response, 404, { error: 'not_found' }, { 'Cache-Control': 'no-store' }); return; }
    const { profile: row, wallets } = resolved;
    const holdings = await aggregateWalletHoldings(wallets);
    sendJson(response, 200, {
      slug: row.slug,
      name: row.display_name,
      avatar: row.avatar || null,
      wallet: row.eth_wallet,                                   // primary (Highrise anchor) — hero display
      // All showcase wallets, public by consent, with trust tiers. `verifiedElsewhere` names the
      // profile that signature-owns a wallet this profile only Highrise-links (the anti-scam flag).
      wallets: wallets.map(w => ({ wallet: w.wallet, highriseLinked: w.highriseLinked, verified: w.verified, verifiedElsewhere: w.verifiedElsewhere || null })),
      creatureCount: holdings.creatureCount,                    // summed across wallets
      landCount: holdings.landCount,
      since: row.created_at || null,
    }, { 'Cache-Control': 'no-store' });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

// --- Candidate application API ---
// Candidacy window. Closed by default — no draft, submit, or AI-draft is accepted
// until APPLICATIONS_OPEN=1 is set (the eligibility check stays live regardless).
const APPLICATIONS_OPEN = envFlag(process.env.APPLICATIONS_OPEN);

// Voting-phase flag — distinct from APPLICATIONS_OPEN. While voting hasn't started, the
// matcher is an ANONYMISED preview: candidate names are NEVER sent to the client (only
// bracket, pitch and match %), so the application phase shows how voting will look and a
// preview of the field without revealing who's who. Names are revealed once VOTING_OPEN=1.
const VOTING_OPEN = envFlag(process.env.VOTING_OPEN);

// Results phase — set RESULTS_OPEN=1 once voting has closed to publish per-race
// tallies and outcomes on /api/election. Aggregates only — individual ballots are
// never exposed, and there is no live tally while VOTING_OPEN (publishing a running
// count would invite pile-ons in a confirmation race).
const RESULTS_OPEN = envFlag(process.env.RESULTS_OPEN);

// --- Unopposed races: the confirmation-vote rule ---
// A race with no more candidates than seats is NOT auto-won. Its ballot becomes a
// choice between "Seat the candidate(s)" and "Reopen nominations":
//   • Seat wins a majority of votes cast on that race → seated with a real mandate.
//   • Reopen wins a STRICT majority → that bracket's candidacy window reopens once
//     (set REOPENED_BRACKETS + REOPEN_DEADLINE). A new candidate entering makes the
//     re-run a normal contested race (bump VOTE_ROUND=2 for the re-vote). If nobody
//     new enters by the deadline, the original candidates are seated by rule.
// Rejection therefore has to be CONSTRUCTIVE — the only way to unseat an unopposed
// candidate is to field someone who beats them. A hostile voting bloc can force a
// real contest but can never vote a bracket's representation into a vacancy, which
// closes the gatekeeping/sabotage exploit. Ties favour seating for the same reason.
const VOTE_ROUND = Math.max(1, parseInt(process.env.VOTE_ROUND, 10) || 1);
const REOPENED_BRACKETS = String(process.env.REOPENED_BRACKETS || '')
  .split(',').map(s => s.trim()).filter(id => BRACKETS.some(b => b.id === id));
const REOPEN_DEADLINE_MS = Date.parse(process.env.REOPEN_DEADLINE || '') || 0;

// Confirmation-ballot choice tokens as stored on ballot rows (never candidate ids).
const SEAT_TOKEN = '__seat__';
const REOPEN_TOKEN = '__reopen__';

// --- Runoff: a constrained re-vote for a single vacated seat ---
// When a winner of a CONTESTED race steps down, the seat is NOT refilled by a full
// bracket re-run (that would discard valid ballots and re-contest the seats already
// won). Instead a narrow runoff is held — only the next-in-line candidates, only the
// vacated seat, on the SAME frozen electorate — and the round-1 winners who kept their
// seats carry over into the final result untouched. Config (inert unless RUNOFF_BRACKET
// is set):
//   RUNOFF_BRACKET     bracket holding the runoff (e.g. 'single')
//   RUNOFF_ROUND       ballot round for the runoff (default 2 — kept distinct from the
//                      concluded round-1 ballots/tallies/receipts, never collides)
//   RUNOFF_SEATS       seats the runoff fills (default 1)
//   RUNOFF_CANDIDATES  comma-separated Discord ids of the candidates ON the runoff ballot
//   RUNOFF_SEATED      comma-separated Discord ids of round-1 winners who KEEP their seat
//                      (carried into the final result; not on the runoff ballot)
//   RUNOFF_DEADLINE    ISO timestamp shown as the close time (the hard stop is flipping
//                      VOTING_OPEN — this is for display)
const RUNOFF = (() => {
  const bracket = String(process.env.RUNOFF_BRACKET || '').trim();
  if (!bracket || !BRACKETS.some(b => b.id === bracket)) return null;
  const ids = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  return {
    bracket,
    round: Math.max(2, parseInt(process.env.RUNOFF_ROUND, 10) || 2),
    seats: Math.max(1, parseInt(process.env.RUNOFF_SEATS, 10) || 1),
    candidates: new Set(ids(process.env.RUNOFF_CANDIDATES)),
    seated: ids(process.env.RUNOFF_SEATED),
    deadlineMs: Date.parse(process.env.RUNOFF_DEADLINE || '') || 0,
  };
})();
const runoffActive = bracket => !!RUNOFF && RUNOFF.bracket === bracket;

// The candidates actually on a bracket's ballot, and the seat count that ballot fills —
// both narrowed to the runoff during one. Everywhere else: the full field + configured seats.
function ballotCandidates(bracket, cands) {
  return runoffActive(bracket) ? cands.filter(c => RUNOFF.candidates.has(c.discord_id)) : cands;
}
function ballotSeats(bracket) {
  const seats = BRACKETS.find(b => b.id === bracket)?.seats ?? 0;
  return runoffActive(bracket) ? RUNOFF.seats : seats;
}
// A bracket's race is concluded (its ballot read-only) when a later round is live and
// this bracket isn't the one being re-voted: during a runoff only the runoff bracket
// accepts votes; otherwise it's the reopen path (VOTE_ROUND bumped past round 1).
function concludedFor(bracket) {
  if (RUNOFF) return !runoffActive(bracket);
  return VOTE_ROUND > 1 && !REOPENED_BRACKETS.includes(bracket);
}

// True while a bracket's one-time post-rejection nomination window is open.
function reopenActiveFor(bracket) {
  return REOPENED_BRACKETS.includes(bracket) && Date.now() < REOPEN_DEADLINE_MS;
}

// The candidacy window for a bracket: the global window, or that bracket's reopen.
function applicationWindowOpenFor(bracket) {
  return APPLICATIONS_OPEN || (!!bracket && reopenActiveFor(bracket));
}

// How long a SUBMITTED application stays editable: through the candidacy window and
// the quiet period after it, locking only once voting begins (VOTING_OPEN — or
// RESULTS_OPEN, so the lock holds through the phases after). A bracket's
// post-rejection reopen counts as its window, so its candidates can edit for the
// re-run even though the wider election has moved on.
function applicationEditableFor(bracket) {
  return (!VOTING_OPEN && !RESULTS_OPEN) || applicationWindowOpenFor(bracket);
}

// The round a bracket's race is decided in: reopened brackets re-vote in round 2
// (once VOTE_ROUND is bumped); every other race concluded in round 1.
function roundFor(bracket) {
  if (runoffActive(bracket)) return RUNOFF.round;
  return REOPENED_BRACKETS.includes(bracket) ? VOTE_ROUND : 1;
}

// 'confirmation' when the field is unopposed (0 < candidates ≤ seats), 'contested'
// when there are more runners than seats, null while the field is empty.
function raceMode(candidateCount, seats) {
  if (!candidateCount) return null;
  return candidateCount <= seats ? 'confirmation' : 'contested';
}

// --- The frozen electorate (continuous-holding rule, enforceable form) ---
// True continuous holding can't be proven from a single chain read, so it's enforced
// as TWO checkpoints: when VOTER_SNAPSHOT=<label> is set, voting requires the voter's
// wallet to be (1) in that snapshot — the holder set frozen when the election was
// announced — AND (2) holding at vote time (the live eligibility check). Assets bought
// after the announcement can't vote in this election. The snapshot is captured ONCE,
// at startup, from the bulk holder data, unioned with the authoritative per-wallet
// reads in `applicants` (covers holders the bulk snapshot's indexer missed); re-runs
// are no-ops because the existing snapshot is found and reused. FAIL-CLOSED: while
// the flag is set but the snapshot isn't captured yet, ballots are rejected.
const VOTER_SNAPSHOT = String(process.env.VOTER_SNAPSHOT || '').trim();
let voterSnapshotInfo = null; // { wallets, capturedAt } once captured/loaded

async function ensureVoterSnapshot() {
  if (!VOTER_SNAPSHOT) return;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      // Local testing seed — honored only when the gitignored dev-login helper is
      // loaded (the same trust gate as dev-login itself), so it can't exist in prod.
      if (devLogin && process.env.VOTER_SNAPSHOT_SEED) {
        const rows = process.env.VOTER_SNAPSHOT_SEED.split(',').map(s => s.trim()).filter(Boolean)
          .map(wallet => ({ wallet, creatureCount: 1, landCount: 0 }));
        await db.saveVoterSnapshot(VOTER_SNAPSHOT, rows);
        voterSnapshotInfo = await db.getVoterSnapshotInfo(VOTER_SNAPSHOT);
        console.warn(`[snapshot] '${VOTER_SNAPSHOT}' seeded with ${voterSnapshotInfo?.wallets ?? 0} dev wallets (dev-login present).`);
        return;
      }
      const existing = await db.getVoterSnapshotInfo(VOTER_SNAPSHOT);
      if (existing) {
        // Captured on a previous boot — the electorate stays frozen across restarts.
        voterSnapshotInfo = existing;
        console.log(`[snapshot] '${VOTER_SNAPSHOT}' already captured: ${existing.wallets} wallets (${existing.capturedAt}).`);
        return;
      }
      if (holderCounts.fetchedAt > 0) {
        const byWallet = new Map();
        const add = (w, key, n) => {
          const r = byWallet.get(w) || { wallet: w, creatureCount: 0, landCount: 0 };
          r[key] = Math.max(r[key], n | 0); // union keeps the higher count per source
          byWallet.set(w, r);
        };
        for (const [w, n] of holderCounts.creature) add(w.toLowerCase(), 'creatureCount', n);
        for (const [w, n] of holderCounts.land) add(w.toLowerCase(), 'landCount', n);
        for (const a of await db.getApplicantWallets()) {
          add(a.wallet.toLowerCase(), 'creatureCount', a.creature_count);
          add(a.wallet.toLowerCase(), 'landCount', a.land_count);
        }
        const rows = [...byWallet.values()].filter(r => r.creatureCount + r.landCount > 0);
        await db.saveVoterSnapshot(VOTER_SNAPSHOT, rows);
        voterSnapshotInfo = await db.getVoterSnapshotInfo(VOTER_SNAPSHOT);
        db.recordEvent({ event: 'snapshot.captured', detail: { label: VOTER_SNAPSHOT, wallets: rows.length } });
        console.log(`[snapshot] '${VOTER_SNAPSHOT}' captured: ${rows.length} holder wallets.`);
        return;
      }
    } catch (err) {
      console.error('[snapshot] capture attempt failed:', err.message);
    }
    await new Promise(r => setTimeout(r, 15000)); // holder data / DB not ready yet — retry
  }
  console.error(`[snapshot] '${VOTER_SNAPSHOT}' could NOT be captured — ballots stay blocked (fail-closed).`);
}
ensureVoterSnapshot();

// --- Election status (public) ---
// A cached snapshot of the race: submitted candidates per holding bracket, the seats
// each bracket elects, and whether the candidacy window is open. Public — it's the
// same picture voters see, so no auth or wallet is needed. The count is cheap (one
// grouped query) but short-cached so repeated polling can't hammer the DB; a fresh
// submission clears the cache (see handleApplicationApi) so the board updates at once.
const APPOINTED_SEATS = 3;                       // appointed for continuity (see Roadmap → First Election)
const RACE_ORDER = ['single', 'mid', 'whale'];   // smallest-holder bracket first, mirroring the eligibility card
const electionCache = { data: null, at: 0 };
const ELECTION_CACHE_TTL_MS = 30 * 1000;

async function getElectionStatus() {
  if (electionCache.data && Date.now() - electionCache.at < ELECTION_CACHE_TTL_MS) {
    return electionCache.data;
  }
  const counts = await db.getCandidateCounts();
  const seatsFor = id => BRACKETS.find(b => b.id === id)?.seats ?? 0;
  const races = RACE_ORDER.map(id => {
    // During a runoff the bracket's public card shows the narrowed contest (the two
    // next-in-line candidates for the one vacated seat), not the full original field.
    if (runoffActive(id)) {
      return {
        bracket: id,
        seats: RUNOFF.seats,
        candidates: RUNOFF.candidates.size,
        mode: raceMode(RUNOFF.candidates.size, RUNOFF.seats),
        runoff: true,
        runoffDeadline: RUNOFF.deadlineMs ? new Date(RUNOFF.deadlineMs).toISOString() : null,
        reopened: false,
        reopenDeadline: null,
      };
    }
    return {
      bracket: id,
      seats: seatsFor(id),
      candidates: counts[id] || 0,
      mode: raceMode(counts[id] || 0, seatsFor(id)),
      reopened: reopenActiveFor(id),
      reopenDeadline: reopenActiveFor(id) ? new Date(REOPEN_DEADLINE_MS).toISOString() : null,
    };
  });
  const data = {
    applicationsOpen: APPLICATIONS_OPEN,
    votingOpen: VOTING_OPEN,
    resultsOpen: RESULTS_OPEN,
    // Electorate transparency: the size + capture date of the frozen voter snapshot
    // (count only — never the wallet list).
    voterSnapshot: VOTER_SNAPSHOT && voterSnapshotInfo
      ? { wallets: voterSnapshotInfo.wallets, capturedAt: voterSnapshotInfo.capturedAt }
      : null,
    races,
    totalCandidates: races.reduce((n, r) => n + r.candidates, 0),
    // True elected-seat total (whole brackets), independent of a runoff narrowing one
    // card to the single vacated seat — so the footnote's seat count stays correct.
    electedSeats: RACE_ORDER.reduce((n, id) => n + seatsFor(id), 0),
    appointedSeats: APPOINTED_SEATS,
    lastUpdated: new Date().toISOString(),
  };
  if (RESULTS_OPEN) data.results = await computeElectionResults();
  electionCache.data = data;
  electionCache.at = Date.now();
  return data;
}

// Final per-race results — published on /api/election only once RESULTS_OPEN. Reads
// ONLY aggregate tallies (no voter identities) and resolves each race per the rules
// above. Candidate names are public by this point (voting has opened), so seated
// names + per-candidate counts are included.
async function computeElectionResults() {
  const [candidates, tallies, allReceipts] = await Promise.all([
    db.getCandidates(), db.getBallotTallies(), db.getBallotReceipts(),
  ]);
  return RACE_ORDER.map(id => {
    const seats = BRACKETS.find(b => b.id === id)?.seats ?? 0;
    // getCandidates() orders by submitted_at ASC — kept as the transparent tie-break
    // (first to declare wins a dead heat).
    const cands = candidates.filter(c => c.bracket === id);
    const round = roundFor(id);
    const roundTallies = tallies.filter(t => t.bracket === id && Number(t.round) === round);
    const turnout = roundTallies.reduce((n, t) => n + t.n, 0);
    const votesFor = choice => roundTallies.find(t => t.choice === choice)?.n || 0;

    // Inclusion verifiability: the race's receipt codes are published with the result
    // (codes only — random, linked to neither voter nor choice, sorted neutrally).
    // Every voter can find their own code, and receipts.length must equal turnout.
    const receipts = allReceipts
      .filter(r => r.bracket === id && Number(r.round) === round)
      .map(r => r.receipt);

    // Runoff bracket: the final seats = the round-1 winner(s) who carried over PLUS the
    // runoff winner(s). Only the runoff candidates are tallied (round = RUNOFF.round);
    // the carried winner keeps their seat without re-running. Submission-order tie-break
    // is preserved (getCandidates() is submitted_at ASC + a stable sort).
    if (runoffActive(id)) {
      const rows = cands
        .filter(c => RUNOFF.candidates.has(c.discord_id))
        .map(c => ({ name: c.display_name || '', votes: votesFor(c.discord_id) }))
        .sort((a, b) => b.votes - a.votes);
      rows.forEach((r, i) => { r.seated = i < RUNOFF.seats; });
      const carried = cands.filter(c => RUNOFF.seated.includes(c.discord_id)).map(c => c.display_name || '');
      return {
        bracket: id, seats, round, turnout, receipts,
        mode: 'contested', runoff: true, status: 'seated', rows, carried,
        seated: [...carried, ...rows.filter(r => r.seated).map(r => r.name)],
      };
    }

    const mode = raceMode(cands.length, seats);
    const base = { bracket: id, seats, mode, round, turnout, receipts };
    if (!mode) return { ...base, status: 'vacant', seated: [] }; // empty field → appointment track

    if (mode === 'contested') {
      // A reopened race that gained candidates is contested, but its re-vote lives in
      // round 2 — until VOTE_ROUND is bumped the round-1 tallies are confirmation
      // tokens, not candidate votes, so the result is still pending.
      if (REOPENED_BRACKETS.includes(id) && round === 1) {
        return { ...base, status: 'revote', seated: [] };
      }
      const rows = cands
        .map(c => ({ name: c.display_name || '', votes: votesFor(c.discord_id) }))
        .sort((a, b) => b.votes - a.votes); // stable sort → submission order breaks ties
      rows.forEach((r, i) => { r.seated = i < seats; });
      return { ...base, status: 'seated', rows, seated: rows.filter(r => r.seated).map(r => r.name) };
    }

    // Confirmation race: "Seat" vs "Reopen nominations".
    const seatVotes = votesFor(SEAT_TOKEN);
    const reopenVotes = votesFor(REOPEN_TOKEN);
    const names = cands.map(c => c.display_name || '');
    const conf = { ...base, seatVotes, reopenVotes };
    if (reopenVotes <= seatVotes) {
      // Majority (or tie — status quo favours seating) to seat.
      return { ...conf, status: 'seated', seated: names };
    }
    if (reopenActiveFor(id)) {
      // Reopen won and the window is live: nominations are open right now.
      return { ...conf, status: 'reopened', seated: [], reopenDeadline: new Date(REOPEN_DEADLINE_MS).toISOString() };
    }
    if (REOPENED_BRACKETS.includes(id) && REOPEN_DEADLINE_MS && Date.now() >= REOPEN_DEADLINE_MS) {
      // Window came and went with no new entrant (the field is still ≤ seats, or we'd
      // be in the contested branch) → the original candidates are seated by rule.
      return { ...conf, status: 'seatedByRule', seated: names };
    }
    // Reopen won but the window hasn't been scheduled yet.
    return { ...conf, status: 'reopenPending', seated: [] };
  });
}

// Draft open questions for the self-nomination form (owner will refine the copy;
// these ids must match the front-end in js/application.js).
const APPLICATION_QUESTIONS = ['track', 'theme', 'gen2', 'value', 'roadmap', 'communication', 'represent', 'seat'];
const APP_LIMITS = { displayName: 40, pitch: 240, answer: 1200 };

function readJsonBody(request, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, aborted = false; const chunks = [];
    request.on('data', chunk => {
      if (aborted) return; // over the cap — discard further chunks (bounded memory), don't reset the socket
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true; chunks.length = 0;
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON.'), { statusCode: 400 })); }
    });
    request.on('error', err => { if (!aborted) reject(err); });
  });
}

// Shape an application row for the client (never leaks DB-internal fields).
function publicApplication(a) {
  if (!a) return null;
  return {
    displayName: a.display_name || '',
    pitch: a.pitch || '',
    answers: a.answers || {},
    positions: a.positions || {},
    bracket: a.bracket || null,
    status: a.status || 'draft',
    submittedAt: a.submitted_at || null,
    updatedAt: a.updated_at || null,
  };
}

// Affinity between a voter's stances and a candidate's positions: per shared
// proposition, agreement = 1 − |Δstance| / 4 (scale 1–5), averaged. Pure function.
function affinity(voterPos, candPositions) {
  let sum = 0, n = 0;
  for (const id of PROPOSITION_IDS) {
    const v = voterPos[id];
    const c = candPositions?.[id]?.stance;
    if (v >= 1 && v <= 5 && c >= 1 && c <= 5) { sum += 1 - Math.abs(v - c) / 4; n++; }
  }
  return n ? { pct: Math.round((sum / n) * 100), n } : null;
}

// Validate a client-sent voter ballot into { propId: stance 1-5 }, known props only.
function cleanVoterPositions(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const id of PROPOSITION_IDS) {
      const s = parseInt(raw[id], 10);
      if (s >= 1 && s <= 5) out[id] = s;
    }
  }
  return out;
}

// Opaque, stable per-candidate id for the client to reference a candidate (e.g. to open
// their profile) WITHOUT ever exposing the Discord id. A truncated SHA-256 — not
// reversible to the Discord id, stable across restarts.
function candidateId(discordId) {
  return crypto.createHash('sha256').update(String(discordId)).digest('hex').slice(0, 16);
}

// A candidate avatar is served only if it's a Highrise CDN URL — both on the way into
// the DB (server-derived from the session, never the client) and on the way out, so a
// bad stored value can never reach a page (CSP img-src is the second fence).
function safeIconUrl(u) {
  return typeof u === 'string' && /^https:\/\/cdn\.highrisegame\.com\//.test(u) ? u : null;
}

// Highrise icon URLs are versioned (…/{version}_icon.png) and the old URL is deleted —
// it starts returning 404 — the moment a user restyles their avatar. Avatars are only
// captured at apply/login, so over a multi-week election a candidate's stored URL goes
// stale and the ballot shows a broken image. Periodically re-fetch each submitted
// candidate's current icon from the Highrise profile API and refresh the stored value.
// Same trust model as login: server-derived, cdn.highrisegame.com-only via safeIconUrl.
// Best-effort — never throws, skips any candidate it can't resolve, and only writes
// when the value actually changed.
let avatarRefreshRunning = false;
async function refreshCandidateAvatars() {
  if (avatarRefreshRunning) return;
  avatarRefreshRunning = true;
  let updated = 0;
  try {
    const candidates = await db.getCandidates();
    for (const c of candidates) {
      try {
        // The Highrise user_id is embedded in the stored icon URL (…/user/{id}/…), so a
        // refresh usually needs no extra call. Fall back to the wallet lookup for
        // candidates whose avatar was never captured (the empty ones).
        let userId = (typeof c.avatar === 'string' && (c.avatar.match(/\/user\/([0-9a-f]+)\//i) || [])[1]) || null;
        if (!userId) {
          const wallet = await auth.fetchHighriseWallet(c.discord_id).catch(() => null);
          userId = wallet?.userId || null;
        }
        if (!userId) continue;
        const profile = await auth.fetchHighriseProfile(userId);
        const icon = safeIconUrl(profile?.iconUrl);
        if (icon && icon !== c.avatar) {
          await db.updateApplicationAvatar(c.discord_id, icon);
          updated++;
        }
        await new Promise(r => setTimeout(r, 150)); // gentle on the Highrise API
      } catch { /* skip this candidate; keep the others going */ }
    }
    if (updated) console.log(`[avatars] refreshed ${updated} candidate avatar(s)`);
  } catch (err) {
    console.error('[avatars] refresh failed:', err.message);
  } finally {
    avatarRefreshRunning = false;
  }
}

// Same staleness problem, same cure, for public holder profiles: their avatar is a
// versioned Highrise icon URL captured at enable/login time, so restyles 404 it.
// Shares the schedule below; separate run-guard so one loop can't starve the other.
let holderAvatarRefreshRunning = false;
async function refreshHolderProfileAvatars() {
  if (holderAvatarRefreshRunning) return;
  holderAvatarRefreshRunning = true;
  let updated = 0;
  try {
    const profiles = await db.getHolderProfiles();
    for (const p of profiles) {
      try {
        let userId = (typeof p.avatar === 'string' && (p.avatar.match(/\/user\/([0-9a-f]+)\//i) || [])[1]) || null;
        if (!userId) {
          const wallet = await auth.fetchHighriseWallet(p.discord_id).catch(() => null);
          userId = wallet?.userId || null;
        }
        if (!userId) continue;
        const profile = await auth.fetchHighriseProfile(userId);
        const icon = safeIconUrl(profile?.iconUrl);
        if (icon && icon !== p.avatar) {
          await db.updateHolderProfileAvatar(p.discord_id, icon);
          updated++;
        }
        await new Promise(r => setTimeout(r, 150)); // gentle on the Highrise API
      } catch { /* skip this profile; keep the others going */ }
    }
    if (updated) console.log(`[avatars] refreshed ${updated} holder profile avatar(s)`);
  } catch (err) {
    console.error('[avatars] holder profile refresh failed:', err.message);
  } finally {
    holderAvatarRefreshRunning = false;
  }
}

// Warm shortly after boot (backfills stale/empty avatars on deploy) then hourly, so
// avatars stay current as candidates keep restyling through the election.
setTimeout(() => { refreshCandidateAvatars(); refreshHolderProfileAvatars(); }, 15 * 1000).unref();
setInterval(() => { refreshCandidateAvatars(); refreshHolderProfileAvatars(); }, 60 * 60 * 1000).unref();

// A single candidate's public profile for the click-through detail view. Consented
// fields only — never wallet or Discord id. During the CANDIDACY phase it's an
// anonymous preview: pitch + VAA positions (the matchable part) are shown, but the
// candidate's NAME and free-text open-question ANSWERS are withheld until voting opens,
// at which point the full profile becomes public.
function publicCandidateProfile(c) {
  const profile = {
    id: candidateId(c.discord_id),
    bracket: c.bracket || null,
    pitch: c.pitch || '',
    positions: c.positions || {},
  };
  if (VOTING_OPEN) {
    profile.name = c.display_name || '';
    profile.avatar = safeIconUrl(c.avatar);
    profile.answers = c.answers || {};
  }
  return profile;
}

// /api/vote — the voting-advice matcher, computed ENTIRELY server-side so candidate
// positions never reach the browser (the client only ever sees ranked names + match %).
// Gated to signed-in, voting-eligible holders.
//   GET  → { propositions, candidateCount } (to render the questionnaire).
//   POST { positions } → { results: [{ name, bracket, pitch, pct, n }], candidateCount }.
// PRIVACY: the gate reads the STORED eligibility snapshot (no recompute side-effects),
// and the handler writes NOTHING and logs NOTHING about the voter's answers — they're
// matched in memory and discarded. No DB row, no audit event, so there's no persistent
// trace of who matched or how they voted. POST is lightly rate-limited per voter to
// blunt attempts to infer candidate positions by probing many crafted ballots.
async function handleVoteApi(request, response) {
  const cookies = auth.parseCookies(request);
  const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { sendJson(response, 401, { error: 'Sign in to find your match.' }); return; }
  const elig = session.eligibility || {};
  if (!elig.canVotePendingHoldTime) { sendJson(response, 403, { error: 'Only eligible voters can use the matcher.' }); return; }

  if (request.method === 'GET') {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const cid = url.searchParams.get('candidate');

    // Click-through: one candidate's full profile (positions + answers) on demand.
    // Lazy + per-candidate (not bulk), and like the match it writes/logs nothing about
    // which profile was viewed, so a voter's interest stays untraceable.
    if (cid) {
      const wait = rateLimited(`profile:${session.discord_id}`, 240, 60 * 60 * 1000);
      if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }
      const cand = (await db.getCandidates()).find(c => candidateId(c.discord_id) === cid);
      if (!cand) { sendJson(response, 404, { error: 'Candidate not found.' }); return; }
      sendJson(response, 200, { candidate: publicCandidateProfile(cand) });
      return;
    }

    const candidates = await db.getCandidates();
    sendJson(response, 200, { propositions: PROPOSITIONS, candidateCount: candidates.length, votingOpen: VOTING_OPEN });
    return;
  }

  if (request.method === 'POST') {
    const wait = rateLimited(`match:${session.discord_id}`, 60, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many match requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const voterPos = cleanVoterPositions(body.positions);
    const candidates = await db.getCandidates();
    const results = Object.keys(voterPos).length
      ? candidates
          .map(c => {
            const m = affinity(voterPos, c.positions);
            // `id` is the opaque handle the client uses to open this candidate's profile.
            const row = { id: candidateId(c.discord_id), bracket: c.bracket || null, pitch: c.pitch || '', pct: m ? m.pct : null, n: m ? m.n : 0 };
            // Candidate names (and avatars — equally identifying) are withheld until
            // the voting phase opens — never sent during the anonymous preview.
            if (VOTING_OPEN) {
              row.name = c.display_name || '';
              row.avatar = safeIconUrl(c.avatar);
            }
            return row;
          })
          .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
      : [];
    sendJson(response, 200, { results, candidateCount: candidates.length, votingOpen: VOTING_OPEN });
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

// /api/ballot — the OFFICIAL vote (the matcher above is advisory and casts nothing).
// Gated to signed-in, voting-eligible holders; the 3-month continuous-hold rule is
// verified against the candidacy-window snapshot, as on the rest of the panel.
//   GET  → phase + the voter's races: candidates (opaque id, name once voting is
//          open, pitch), each race's mode, and the caller's own ballot if cast.
//   POST { bracket, choice } → casts the ballot. Votes are FINAL once cast (the
//          published rule) — storage is insert-only and re-votes get a 409.
// PRIVACY: the ballot row (voter ↔ choice) exists only to enforce one vote per race;
// it never leaves the server. The audit event records THAT a ballot was cast, never
// the choice. Tallies are published only as aggregates once RESULTS_OPEN.
async function handleBallotApi(request, response) {
  const cookies = auth.parseCookies(request);
  const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { sendJson(response, 401, { error: 'Sign in to vote.' }); return; }
  // LIVE eligibility — recompute against current holdings (same as the application
  // API) so a wallet emptied since login can't vote on a stale session snapshot.
  const elig = await refreshEligibility(session, cookies[auth.SESSION_COOKIE]);
  if (!elig.canVotePendingHoldTime) { sendJson(response, 403, { error: 'Only eligible holders can vote.' }); return; }

  // Checkpoint two of the continuous-holding rule: the wallet must be in the frozen
  // electorate. Fail-closed while the snapshot flag is set but capture hasn't landed.
  const snapshotActive = !!VOTER_SNAPSHOT;
  const snapshotReady = !snapshotActive || !!(voterSnapshotInfo && voterSnapshotInfo.wallets);
  const inSnapshot = !snapshotActive
    || (snapshotReady && await db.isInVoterSnapshot(VOTER_SNAPSHOT, elig.ethWallet));

  if (request.method === 'GET') {
    const [candidates, own] = await Promise.all([
      db.getCandidates(),
      db.getBallotsFor(session.discord_id),
    ]);
    // Map a stored choice to its client-safe form: confirmation tokens become
    // 'seat'/'reopen'; a candidate Discord id becomes the opaque hash.
    const clientChoice = c => c === SEAT_TOKEN ? 'seat' : c === REOPEN_TOKEN ? 'reopen' : candidateId(c);
    const races = RACE_ORDER.map(id => {
      const cands = ballotCandidates(id, candidates.filter(c => c.bracket === id)); // runoff narrows the field
      const seats = ballotSeats(id);                                                // runoff fills only the vacated seat(s)
      const round = roundFor(id);
      const mode = raceMode(cands.length, seats);
      // All of the voter's picks in this race (up to `seats`).
      const mine = own.filter(b => b.bracket === id && Number(b.round) === round);
      const picks = mine.map(b => ({ choice: clientChoice(b.choice), receipt: b.receipt, castAt: b.cast_at || null }));
      return {
        bracket: id,
        seats,
        mode,
        round,
        runoff: runoffActive(id) || undefined,
        runoffDeadline: runoffActive(id) && RUNOFF.deadlineMs ? new Date(RUNOFF.deadlineMs).toISOString() : undefined,
        // Concluded races are read-only: the other brackets while a runoff is live, or
        // round-1 races once a later round is running.
        concluded: concludedFor(id),
        candidates: cands.map(c => ({
          id: candidateId(c.discord_id),
          pitch: c.pitch || '',
          // Names + avatars are public from the moment voting opens, results included.
          ...(VOTING_OPEN || RESULTS_OPEN ? { name: c.display_name || '', avatar: safeIconUrl(c.avatar) } : {}),
        })),
        picks,
        // How many more picks this voter may still cast in this race.
        picksRemaining: mode ? Math.max(0, seats - picks.length) : 0,
      };
    });
    sendJson(response, 200, {
      votingOpen: VOTING_OPEN,
      resultsOpen: RESULTS_OPEN,
      round: VOTE_ROUND,
      snapshot: snapshotActive
        ? { active: true, ready: snapshotReady, in: inSnapshot, capturedAt: voterSnapshotInfo?.capturedAt || null }
        : { active: false },
      races,
    });
    return;
  }

  if (request.method === 'POST') {
    if (!VOTING_OPEN) { sendJson(response, 403, { error: 'Voting is not open.' }); return; }
    if (snapshotActive && !snapshotReady) {
      sendJson(response, 503, { error: 'The voter snapshot isn\'t ready yet — try again in a moment.' });
      return;
    }
    if (!inSnapshot) {
      sendJson(response, 403, { error: 'Voting is limited to wallets in the official holder snapshot.' });
      return;
    }
    // 3 races and final votes — a low cap comfortably covers honest use.
    const wait = rateLimited(`ballot:${session.discord_id}`, 20, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const bracket = RACE_ORDER.includes(body.bracket) ? body.bracket : null;
    if (!bracket) { sendJson(response, 400, { error: 'Unknown race.' }); return; }
    if (concludedFor(bracket)) {
      sendJson(response, 403, { error: 'This race has already concluded.' });
      return;
    }

    // During a runoff only the two runoff candidates are accepted, and only one pick.
    const cands = ballotCandidates(bracket, (await db.getCandidates()).filter(c => c.bracket === bracket));
    const seats = ballotSeats(bracket);
    const mode = raceMode(cands.length, seats);
    if (!mode) { sendJson(response, 400, { error: 'This race has no candidates.' }); return; }

    // Resolve the client choice into the stored value, validating it against the mode.
    const rawChoice = String(body.choice || '');
    let choice = null;
    if (mode === 'confirmation') {
      if (rawChoice === 'seat') choice = SEAT_TOKEN;
      else if (rawChoice === 'reopen') choice = REOPEN_TOKEN;
    } else {
      choice = cands.find(c => candidateId(c.discord_id) === rawChoice)?.discord_id || null;
    }
    if (!choice) { sendJson(response, 400, { error: 'That choice isn\'t on this ballot.' }); return; }

    const receipt = crypto.randomBytes(5).toString('hex').toUpperCase();
    // A voter may cast up to `seats` distinct picks in this race (the Member race
    // elects 2; single-seat and confirmation races cap at 1).
    const { row: saved, reason, count } = await db.castBallot({
      discordId: session.discord_id,
      bracket,
      round: roundFor(bracket),
      choice,
      receipt,
      maxPicks: seats,
    });
    if (!saved) {
      // seats === 1 → any rejection just means "already voted here". seats > 1 → tell
      // them whether it's a duplicate candidate or they're out of votes.
      const msg = seats <= 1
        ? 'You already voted in this race — votes are final once cast.'
        : reason === 'duplicate'
          ? 'You already voted for that candidate — pick a different one for your other vote.'
          : `You've used all ${seats} of your votes in this race.`;
      sendJson(response, 409, { error: msg });
      return;
    }

    // Audit THAT a pick was cast (turnout traceability) — never the choice.
    db.recordEvent({ event: 'ballot.cast', discordId: session.discord_id, detail: { bracket, round: saved.round, mode, pick: count, seats } });
    sendJson(response, 200, { ok: true, bracket, receipt: saved.receipt, castAt: saved.cast_at || null, picksRemaining: Math.max(0, seats - count) });
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

// /api/polls — official community polls (lib/polls.js), the Council's mechanism for
// sending a big call to an HCC-wide vote. Same trust chain as the election ballot:
// Discord sign-in → Highrise-linked wallet → live holder check. One holder, one vote
// (enforced per account AND per wallet), insert-only with a private receipt.
//   GET  → viewer context (signed-in? holder?) + every poll's status, options,
//          turnout, the caller's own vote, and — once closed — the final tallies
//          with the published receipt-code list (inclusion verifiability, as on
//          the election board).
//   POST /api/polls/vote { poll, choice } → casts the vote. FINAL once cast —
//          storage is insert-only and re-votes get a 409.
// PRIVACY: the vote row (voter ↔ choice) exists only to enforce the one-vote rule;
// it never leaves the server. The audit event records THAT a vote was cast, never
// the choice. No running tally while a poll is open (same rule as the election).
// Read the raw request body as a Buffer (bounded). The ingest route needs the exact
// bytes to verify the HMAC, so it can't go through readJsonBody (which parses).
function readRawBody(request, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, aborted = false; const chunks = [];
    request.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true; chunks.length = 0;
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    request.on('error', err => { if (!aborted) reject(err); });
  });
}

// Constant-time hex compare that never throws on malformed input.
function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// Verify the ingest HMAC: sha256(secret, rawBody). The header may be bare hex or
// prefixed 'sha256='. Replay of a captured request is harmless — every write is an
// idempotent upsert/delete keyed on the message id — so no timestamp/nonce is needed.
function verifyIngestSignature(rawBody, headerVal) {
  if (!ANNOUNCEMENTS_INGEST_SECRET) return false;
  const provided = String(headerVal || '').trim().replace(/^sha256=/i, '');
  const expected = crypto.createHmac('sha256', ANNOUNCEMENTS_INGEST_SECRET).update(rawBody).digest('hex');
  return safeEqualHex(provided, expected);
}

const DISCORD_IMG_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
// Keep only https URLs served from Discord's own CDNs (matches the page CSP img-src).
// Anything else is dropped so a malformed/hostile payload can't point an <img> off-site.
function safeDiscordImg(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && DISCORD_IMG_HOSTS.has(u.host) ? u.href : null;
  } catch { return null; }
}
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;
function isImageAttachment(att) {
  return /^image\//i.test(att?.content_type || '') || IMAGE_EXT_RE.test(att?.filename || att?.url || '');
}

function discordMessageUrl(messageId) {
  return `https://discord.com/channels/${DISCORD_GUILD_ID}/${ANNOUNCEMENTS_CHANNEL_ID}/${messageId}`;
}

// --- image mirroring --------------------------------------------------------------------
// Discord attachment URLs are signed and die ~24h after issuance, so an image left on its
// Discord URL stops loading the day after we mirror it ("This content is no longer
// available."). To keep the feed permanent we copy the bytes to our own domain at ingest,
// while the URL is still fresh, and rewrite the attachment to /api/announcements/media/<id>
// (served by us, never expires). img-src 'self' already allows the same-origin URL.
const MEDIA_ROUTE = '/api/announcements/media/';
// Key is either a Discord attachment id (pure snowflake) or a `<messageId>-<index>` fallback
// used when the payload carries no attachment id — both are digits/one hyphen.
const MEDIA_PATH_RE = /^\/api\/announcements\/media\/\d{1,25}(?:-\d{1,3})?$/;
const MIRROR_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — Discord's standard upload cap; covers big GIFs/hi-res PNGs.
// Anything larger falls back to the (expiring) Discord URL rather than storing a huge blob.
const MIRRORABLE_CT_RE = /^image\/(png|jpe?g|gif|webp|avif)$/i;

// Fetch an image from a (Discord-CDN-validated) URL and return its bytes + a content hash.
// The URL is always one safeDiscordImg() already vetted, so this can't be turned into an
// open proxy. We trust the RESPONSE content-type, not the attachment metadata, and accept
// only known raster types, so a mislabelled upload can't get stored and served as active
// content (the serve route also sends nosniff + a locked-down CSP).
async function downloadImageBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!MIRRORABLE_CT_RE.test(ct)) throw new Error(`unexpected content-type: ${ct || 'none'}`);
  if ((Number(res.headers.get('content-length')) || 0) > MIRROR_MAX_BYTES) throw new Error('too large (declared)');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('empty body');
  if (bytes.length > MIRROR_MAX_BYTES) throw new Error(`too large: ${bytes.length}`);
  const etag = '"' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '"';
  return { contentType: ct, bytes, size: bytes.length, etag };
}

// Mirror every image attachment on a normalized message, rewriting each url to our route.
// Runs at ingest, before the row is stored, so the DB persists the permanent URL. Best
// effort per image: a download failure leaves the original Discord URL in place (it still
// works for ~24h) and logs, so one bad fetch never blocks the announcement from posting.
// Already-mirrored attachments (a re-send or edit) skip the download entirely.
// NOTE: embed images (embeds[].image) still use their expiring Discord URL — announcements
// here are native uploads, not link embeds, so this covers the reported case.
async function mirrorAnnouncementImages(norm) {
  const atts = norm.attachments || [];
  for (let i = 0; i < atts.length; i++) {
    const att = atts[i];
    if (!att || !isImageAttachment(att)) continue;
    const src = safeDiscordImg(att.url);
    if (!src) continue;
    // Prefer the Discord attachment id (stable across edits; a replaced image gets a new id
    // → it re-mirrors). Fall back to `<messageId>-<index>` when the payload has no id, so a
    // missing field can NEVER silently no-op the mirror the way it did before.
    const key = att.id || `${norm.messageId}-${i}`;
    try {
      if (!(await db.announcementMediaExists(key))) {
        const media = await downloadImageBytes(src);
        await db.saveAnnouncementMedia({ id: key, messageId: norm.messageId, ...media });
      }
      att.url = MEDIA_ROUTE + key; // point at our permanent copy (only reached once bytes are stored)
    } catch (err) {
      console.error(`[announcements] image mirror failed for ${key}:`, err.message);
    }
  }
}

// A feed image is either our own mirrored copy (permanent, same-origin) or, as a fallback
// when mirroring failed, a Discord CDN URL (expires ~24h). Anything else is dropped.
function safeFeedImg(url) {
  const s = String(url || '');
  return MEDIA_PATH_RE.test(s) ? s : safeDiscordImg(s);
}

// Bound + normalize an incoming Discord message into the row our DB stores. Trusted
// source (the bot), but still capped so one bad payload can't bloat the table.
function normalizeAnnouncementMessage(msg) {
  const clip = (s, n) => String(s ?? '').slice(0, n);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 10).map(a => ({
    id: /^\d{1,25}$/.test(String(a?.id ?? '')) ? String(a.id) : null,
    url: clip(a.url, 600),
    filename: clip(a.filename, 200),
    content_type: clip(a.content_type, 100),
    width: Number(a.width) || null,
    height: Number(a.height) || null,
    size: Number(a.size) || null,
  })) : [];
  const embeds = Array.isArray(msg.embeds) ? msg.embeds.slice(0, 10).map(e => ({
    title: clip(e.title, 400),
    description: clip(e.description, 4000),
    url: clip(e.url, 600),
    image: clip(e.image?.url || e.image, 600),
    thumbnail: clip(e.thumbnail?.url || e.thumbnail, 600),
  })) : [];
  // Resolved mention names, keyed by snowflake id. Bounded and type-checked so a bad
  // payload can't bloat the row; names are escaped at render time, never trusted as HTML.
  const mentions = {};
  const rawMentions = (msg.mentions && typeof msg.mentions === 'object' && !Array.isArray(msg.mentions)) ? msg.mentions : {};
  let mcount = 0;
  for (const [id, val] of Object.entries(rawMentions)) {
    if (mcount >= 200) break;
    if (!/^\d{1,25}$/.test(id) || !val) continue;
    const type = ['role', 'user', 'channel'].includes(val.type) ? val.type : 'user';
    mentions[id] = { type, name: clip(val.name, 100) };
    mcount++;
  }
  return {
    messageId: String(msg.id),
    channelId: String(msg.channel_id),
    authorId: msg.author?.id ? String(msg.author.id) : null,
    authorName: clip(msg.author?.username, 200) || null,
    authorDisplay: clip(msg.author?.display_name || msg.author?.global_name, 200) || null,
    authorAvatar: clip(msg.author?.avatar, 600) || null,
    content: clip(msg.content, 8000),
    attachments,
    embeds,
    mentions,
    postedAt: msg.timestamp,
    editedAt: msg.edited_timestamp || null,
  };
}

// Merge announcements that are one post split across several back-to-back messages.
// Consecutive rows by the SAME author within ANNOUNCEMENTS_GROUP_WINDOW_MS collapse into
// one row: texts joined in order, attachments/embeds/mentions concatenated, timestamp =
// the first message (when the announcement began), edited = the latest edit in the group,
// and message_id = the first message so "View on Discord" opens where it starts. Purely a
// read-time transform — stored rows remain individual, so edits/deletes still work and a
// deleted middle message just drops out and the group re-forms. Input is newest-first (as
// db returns); output is newest-first too.
function groupAnnouncementRows(rows) {
  if (ANNOUNCEMENTS_GROUP_WINDOW_MS <= 0) return rows;
  const asc = rows.slice().sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
  const groups = [];
  for (const r of asc) {
    const g = groups[groups.length - 1];
    const prev = g && g[g.length - 1];
    const sameAuthor = prev && r.author_id && prev.author_id && String(r.author_id) === String(prev.author_id);
    const gap = prev ? (new Date(r.posted_at) - new Date(prev.posted_at)) : Infinity;
    if (prev && sameAuthor && gap >= 0 && gap <= ANNOUNCEMENTS_GROUP_WINDOW_MS) g.push(r);
    else groups.push([r]);
  }
  const merged = groups.map(g => {
    if (g.length === 1) return g[0];
    const first = g[0];
    const mentions = {};
    for (const r of g) Object.assign(mentions, (r.mentions && typeof r.mentions === 'object') ? r.mentions : {});
    const editTimes = g.map(r => r.edited_at).filter(Boolean).map(t => new Date(t).getTime());
    return {
      ...first,
      content: g.map(r => r.content || '').join('\n\n'),
      attachments: g.flatMap(r => Array.isArray(r.attachments) ? r.attachments : []),
      embeds: g.flatMap(r => Array.isArray(r.embeds) ? r.embeds : []),
      mentions,
      posted_at: first.posted_at,
      edited_at: editTimes.length ? new Date(Math.max(...editTimes)) : null,
    };
  });
  merged.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));
  return merged;
}

/* Each announcement is its own page. The feed was one URL for everything the club has
   ever posted, so a link to a specific announcement could only ever be a link to Discord.
   Now every post has an address of its own that survives a reload and a share.

   The address is <slug>-<message id>. The id is the truth and the only thing resolved,
   the same way this file already treats a Creature's number and its 39-digit token id: a
   post can be edited in Discord, its title can change with it, and every link ever shared
   still lands. The slug is there so the URL says what it points at.

   The title comes from the post itself, in the order Discord authors actually write:
   a markdown heading, then a bold opening line, then the first line of text. */

// Discord markup, out. Custom emoji, pings, links, emphasis and headings all become the
// words a reader would say out loud.
function plainDiscord(text) {
  return String(text || '')
    .replace(/<@[!&]?\d+>|@(everyone|here)/g, '')       // pings, first: a club post opens
    .replace(/<a?:(\w+):\d+>/g, '')                    // custom emoji, and a heading
    .replace(/<#\d+>/g, '')                             // channel links, sits after them
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')       // [text](url) keeps the text
    .replace(/^[ 	]*#{1,6}\s+/gm, '')                  // headings
    .replace(/[*_~`|]/g, '')                            // emphasis, spoilers, code ticks
    .replace(/\s+/g, ' ')
    .trim();
}

function trimWords(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '');
}

// The title, and whether the post carried one of its own. A heading or a bold opening
// line is a title and the body starts after it; a post that just starts talking has its
// first words used as a title, and then the body has to start at the beginning or the
// card opens mid-sentence.
function announcementParts(row) {
  const lines = String(row.content || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/<@[!&]?\d+>|@(everyone|here)/g, '').replace(/<a?:\w+:\d+>/g, '').trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const bold = heading ? null : /^\*\*(.+?)\*\*[\s.:!]*$/.exec(line);
    const rest = () => plainDiscord(lines.slice(i + 1).join(' '));
    if (heading) return { title: trimWords(plainDiscord(heading[1]), 80), titled: true, body: rest() };
    if (bold) return { title: trimWords(plainDiscord(bold[1]), 80), titled: true, body: rest() };
    const plain = plainDiscord(line);
    if (plain) {
      return { title: trimWords(plain, 80), titled: false,
               body: plainDiscord(lines.slice(i).join(' ')) };
    }
  }
  return { title: '', titled: false, body: '' };
}

function announcementTitle(row) {
  return announcementParts(row).title;
}

function announcementPath(row) {
  const id = String(row.message_id || '');
  const full = entitySlug(announcementTitle(row) || '');
  // Cut on a hyphen so the slug ends on a whole word. It is decoration either way, but a
  // URL that stops mid-word looks like it was truncated by accident.
  let slug = full.slice(0, 60);
  if (full.length > 60) slug = slug.slice(0, slug.lastIndexOf('-') + 1);
  slug = slug.replace(/-+$/, '');
  return slug && slug !== 'x' ? `/announcements/${slug}-${id}` : `/announcements/${id}`;
}

// The id is the last long run of digits, so a slug that carries its own numbers ("gen-2",
// "update-6") can never be mistaken for it. A bare id works too, for a link made by hand.
function announcementRouteOf(pathname) {
  const m = /^\/announcements\/(?:.*?-)?(\d{15,25})\/?$/.exec(pathname);
  return m ? m[1] : null;
}

async function announcementPageMeta(id, origin) {
  let row = null;
  try { row = await db.getAnnouncementById(id); } catch { row = null; }
  // A deleted post drops off the site, so its link falls back to the feed's own card
  // rather than claiming an announcement that is no longer there.
  if (!row) return sectionPageMeta('/announcements', origin);
  const { title, body } = announcementParts(row);
  // Only a picture this server holds. Discord's own attachment URLs expire within a day,
  // and a card is scraped once and cached for everyone, so an expiring link would leave
  // a broken image on every share made after it.
  const shot = (Array.isArray(row.attachments) ? row.attachments : [])
    .filter(isImageAttachment)
    .map(a => safeFeedImg(a.url))
    .find(u => u && MEDIA_PATH_RE.test(u));
  return {
    title: !title || title === SITE_NAME ? SITE_NAME : `${title} · ${SITE_NAME}`,
    description: trimWords(body, 180) || trimWords(plainDiscord(row.content || ''), 180),
    image: shot ? origin + shot : null,
    url: origin + announcementPath(row),
  };
}

// Shape a stored row for the public feed. Announcements are already public in Discord,
// so nothing here is sensitive — but URLs are still constrained to Discord's CDNs and
// image/file attachments are split so the client renders each correctly.
function shapeAnnouncement(row) {
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  const attachments = atts.map(a => {
    if (isImageAttachment(a)) {
      const src = safeFeedImg(a.url);
      return src ? { type: 'image', url: src, name: a.filename || '', width: a.width || null, height: a.height || null } : null;
    }
    // Non-image files render as a download chip; the href is a plain link (not an <img>).
    return a.url ? { type: 'file', url: String(a.url), name: a.filename || 'attachment', size: a.size || null } : null;
  }).filter(Boolean);

  const embeds = (Array.isArray(row.embeds) ? row.embeds : []).map(e => ({
    title: e.title || '',
    description: e.description || '',
    url: /^https?:\/\//i.test(e.url || '') ? e.url : '',
    image: safeDiscordImg(e.image) || safeDiscordImg(e.thumbnail) || '',
  })).filter(e => e.title || e.description || e.image);

  return {
    id: row.message_id,
    url: discordMessageUrl(row.message_id),
    // Built here so the browser never has to derive it: one implementation, no drift.
    title: announcementTitle(row),
    path: announcementPath(row),
    author: {
      name: row.author_display || row.author_name || 'Highrise Creature Club',
      avatar: safeDiscordImg(row.author_avatar) || null,
    },
    content: row.content || '',
    attachments,
    embeds,
    mentions: (row.mentions && typeof row.mentions === 'object') ? row.mentions : {},
    postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
  };
}

// Announcements feed API.
//   GET  /api/announcements          → public feed (live rows, newest first)
//   POST /api/announcements/ingest   → the bot mirrors create/edit/delete here.
// INGEST CONTRACT (see the config block near the top of this file):
//   Auth: header `X-HCC-Signature: sha256=<hmac>` where hmac = HMAC-SHA256(secret, rawBody).
//   Body: a single `{ type, message }` or a batch `{ events: [{ type, message }, ...] }`.
//     type 'upsert' (default) stores/updates; 'delete' soft-deletes by message id.
//   GUARDS: a message is only stored when it belongs to ANNOUNCEMENTS_CHANNEL_ID and
//   carries no thread_id — so thread replies under an announcement, and anything from
//   another channel, are refused. Upsert is keyed on the message id, so an edited
//   message updates its one card instead of ever creating a second.
// One item picture. The art id is a hash of the bytes it names, which is why these
// responses may cache hard while the rest of the site revalidates: the bytes behind an id
// can never change, so there is nothing to go stale.
async function handleCollectionArt(request, response, variant, artId) {
  if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed.' }); return; }
  const ip = clientIp(request);
  // Deliberately high. One screen of strips is ~60 pictures, scrolling the whole timeline
  // is ~500, and opening a few big grabs adds a few hundred more, so a curious visitor
  // can legitimately ask for over a thousand in a minute — and several people behind one
  // office IP share this bucket. An earlier 1500 tripped on an ordinary browse. Guessing
  // an id isn't a threat (16 hex, and collections.json lists them anyway), so this is
  // only here to bound abuse, not to keep anything secret.
  const wait = rateLimited(`col-art:${ip}`, 12000, 60 * 1000);
  if (wait) { sendJson(response, 429, { error: 'Too many requests.' }, { 'Retry-After': String(wait) }); return; }

  const art = variant === 'trait'
    ? await db.getTraitArt(artId)
    : await db.getCollectionArt(artId, variant);
  if (!art) { sendJson(response, 404, { error: 'Not found' }); return; }
  const headers = {
    'Content-Type': art.content_type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': art.etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", // inert as an <img>
  };
  if (request.headers['if-none-match'] === art.etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': String(art.size) });
  response.end(art.bytes);
}

async function handleAnnouncementsApi(request, response, url) {
  const { pathname } = url;

  // Mirrored attachment image bytes, served from our own domain so they never expire the
  // way Discord's signed CDN URLs do. Bytes are immutable per attachment id; we still send
  // an ETag + must-revalidate (per the caching policy) so repeat loads 304 cheaply.
  const mediaMatch = pathname.match(/^\/api\/announcements\/media\/(\d{1,25}(?:-\d{1,3})?)$/);
  if (mediaMatch) {
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed.' }); return; }
    const ip = clientIp(request);
    const wait = rateLimited(`ann-media:${ip}`, 1200, 60 * 1000); // generous — a full feed load is well under this
    if (wait) { sendJson(response, 429, { error: 'Too many requests.' }, { 'Retry-After': String(wait) }); return; }

    const media = await db.getAnnouncementMedia(mediaMatch[1]);
    if (!media) { sendJson(response, 404, { error: 'Not found' }); return; }
    const headers = {
      'Content-Type': media.content_type,
      'Cache-Control': 'public, max-age=86400, must-revalidate',
      'ETag': media.etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", // inert as an <img>; neutralized if opened as a page
    };
    if (request.headers['if-none-match'] === media.etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Length': String(media.size) });
    response.end(media.bytes);
    return;
  }

  if (pathname === '/api/announcements' && request.method === 'GET') {
    const rows = await db.getAnnouncements({ limit: 50 });
    sendJson(response, 200, {
      channelUrl: `https://discord.com/channels/${DISCORD_GUILD_ID}/${ANNOUNCEMENTS_CHANNEL_ID}`,
      announcements: groupAnnouncementRows(rows).map(shapeAnnouncement),
    }, { 'Cache-Control': 'public, max-age=60' });
    return;
  }

  // One announcement by id, for a link to a post that has scrolled off the feed. It reads
  // a wider window and groups it exactly as the feed does, so a permalink to a post that
  // was split across several Discord messages shows the whole thing, not its first part.
  const oneMatch = pathname.match(/^\/api\/announcements\/(\d{15,25})$/);
  if (oneMatch && request.method === 'GET') {
    const rows = await db.getAnnouncements({ limit: 200 });
    const one = groupAnnouncementRows(rows).find(r => String(r.message_id) === oneMatch[1]);
    if (!one) { sendJson(response, 404, { error: 'not_found' }); return; }
    sendJson(response, 200, { announcement: shapeAnnouncement(one) },
      { 'Cache-Control': 'public, max-age=60' });
    return;
  }

  if (pathname === '/api/announcements/ingest' && request.method === 'POST') {
    if (!ANNOUNCEMENTS_INGEST_SECRET) {
      sendJson(response, 503, { error: 'Announcement ingest is not configured.' });
      return;
    }
    // Light rate limit — the bot batches, so this only ever trips on abuse.
    const wait = rateLimited(`ann-ingest:${request.socket.remoteAddress || 'unknown'}`, 240, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests.' }, { 'Retry-After': String(wait) }); return; }

    let raw;
    try { raw = await readRawBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    if (!verifyIngestSignature(raw, request.headers['x-hcc-signature'])) {
      db.recordEvent({ event: 'announcement.ingest', ok: false, detail: { reason: 'bad_signature' } });
      sendJson(response, 401, { error: 'Invalid signature.' });
      return;
    }

    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { sendJson(response, 400, { error: 'Invalid JSON.' }); return; }

    const events = Array.isArray(body.events) ? body.events
      : (body.message || body.type) ? [{ type: body.type, message: body.message }] : [];
    if (!events.length) { sendJson(response, 400, { error: 'No events.' }); return; }
    if (events.length > 200) { sendJson(response, 413, { error: 'Too many events in one request.' }); return; }

    let upserted = 0, deleted = 0, skipped = 0;
    for (const ev of events) {
      const msg = ev?.message || {};
      const type = ev?.type === 'delete' ? 'delete' : 'upsert';
      const messageId = msg.id != null ? String(msg.id) : null;
      if (!messageId) { skipped++; continue; }

      if (type === 'delete') {
        // Safe to delete by id alone: only ids we actually stored exist in the table,
        // and thread replies were never stored, so this can't touch anything but a
        // real announcement.
        await db.deleteAnnouncement(messageId);
        deleted++;
        continue;
      }

      // Upsert guards: right channel, and NOT a thread reply.
      if (String(msg.channel_id) !== ANNOUNCEMENTS_CHANNEL_ID || msg.thread_id) { skipped++; continue; }
      if (!msg.timestamp) { skipped++; continue; }
      const norm = normalizeAnnouncementMessage(msg);
      await mirrorAnnouncementImages(norm); // copy image bytes to our domain while Discord URLs are fresh
      await db.upsertAnnouncement(norm);
      upserted++;
    }

    db.recordEvent({ event: 'announcement.ingest', ok: true, detail: { upserted, deleted, skipped } });
    sendJson(response, 200, { ok: true, upserted, deleted, skipped });
    return;
  }

  sendJson(response, request.method === 'GET' || request.method === 'POST' ? 404 : 405,
    { error: request.method === 'GET' || request.method === 'POST' ? 'Not found' : 'Method not allowed.' });
}

async function handlePollsApi(request, response, url) {
  const { pathname } = url;
  const cookies = auth.parseCookies(request);
  const sid = cookies[auth.SESSION_COOKIE];
  const session = await db.getSession(sid);

  if (pathname === '/api/polls' && request.method === 'GET') {
    // Viewer context for the page's gates. Eligibility is recomputed against the
    // current holder snapshot (cheap in-memory read) so buys/sells reflect
    // without a re-login — same behaviour as the eligibility card.
    let viewer = { authenticated: false };
    let myVotes = [];
    if (session) {
      const elig = await refreshEligibility(session, sid);
      viewer = {
        authenticated: true,
        profile: publicProfile(session.profile),
        linked: !!(elig.linked && elig.ethWallet),
        holdersAvailable: !!elig.holdersAvailable,
        holder: !!elig.canVotePendingHoldTime,
      };
      myVotes = await db.getPollVotesFor(session.discord_id);
    }

    const tallies = await db.getPollTallies();
    const polls = [];
    for (const p of POLLS) {
      const status = pollStatus(p);
      const mine = myVotes.find(v => v.poll_id === p.id);
      const row = {
        id: p.id,
        key: p.i18nKey,
        options: p.options,
        status,
        opensAt: p.opensAt ? new Date(p.opensAt).toISOString() : null,
        closesAt: p.closesAt ? new Date(p.closesAt).toISOString() : null,
        // Participation count is public while open (motivating, reveals no choice);
        // per-option counts wait for the close.
        turnout: tallies.filter(t => t.poll_id === p.id).reduce((n, t) => n + t.n, 0),
        myVote: mine ? { choice: mine.choice, receipt: mine.receipt, castAt: mine.cast_at || null } : null,
      };
      if (status === 'closed') {
        const counts = {};
        for (const opt of p.options) {
          counts[opt] = tallies.find(t => t.poll_id === p.id && t.choice === opt)?.n || 0;
        }
        row.results = { counts, receipts: await db.getPollReceipts(p.id) };
      }
      polls.push(row);
    }
    sendJson(response, 200, { viewer, polls });
    return;
  }

  if (pathname === '/api/polls/vote' && request.method === 'POST') {
    if (!session) { sendJson(response, 401, { error: 'Sign in to vote.' }); return; }
    // LIVE eligibility — recompute against current holdings so a wallet emptied
    // since login can't vote on a stale session snapshot (same as the ballot).
    const elig = await refreshEligibility(session, sid);
    if (!elig.canVotePendingHoldTime || !elig.ethWallet) {
      sendJson(response, 403, { error: 'Only HCC holders can vote in official polls.' });
      return;
    }

    const wait = rateLimited(`poll:${session.discord_id}`, 20, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const poll = POLLS.find(p => p.id === String(body.poll || ''));
    if (!poll) { sendJson(response, 400, { error: 'Unknown poll.' }); return; }
    const status = pollStatus(poll);
    if (status !== 'open') {
      sendJson(response, 403, { error: status === 'closed' ? 'This poll has closed.' : 'This poll isn\'t open yet.' });
      return;
    }
    const choice = poll.options.includes(String(body.choice || '')) ? String(body.choice) : null;
    if (!choice) { sendJson(response, 400, { error: 'That choice isn\'t on this poll.' }); return; }

    const receipt = crypto.randomBytes(5).toString('hex').toUpperCase();
    const { row: saved, reason } = await db.castPollVote({
      pollId: poll.id,
      discordId: session.discord_id,
      wallet: elig.ethWallet,
      choice,
      receipt,
    });
    if (!saved) {
      const msg = reason === 'wallet'
        ? 'Your linked wallet already voted in this poll — one holder, one vote.'
        : 'You already voted in this poll — votes are final once cast.';
      sendJson(response, 409, { error: msg });
      return;
    }

    // Audit THAT a vote was cast (turnout traceability) — never the choice.
    db.recordEvent({ event: 'poll.cast', discordId: session.discord_id, detail: { poll: poll.id } });
    sendJson(response, 200, { ok: true, poll: poll.id, receipt: saved.receipt, castAt: saved.cast_at || null });
    return;
  }

  sendJson(response, pathname === '/api/polls' || pathname === '/api/polls/vote' ? 405 : 404,
    { error: pathname === '/api/polls' || pathname === '/api/polls/vote' ? 'Method not allowed.' : 'Not found' });
}

// Validate a client-sent positions map into { id: { stance 1-5, rationale } }.
function cleanPositions(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const id of PROPOSITION_IDS) {
      const p = raw[id];
      if (p && typeof p === 'object') {
        const stance = parseInt(p.stance, 10);
        if (stance >= 1 && stance <= 5) {
          out[id] = { stance, rationale: String(p.rationale || '').trim().slice(0, 200) };
        }
      }
    }
  }
  return out;
}

async function handleApplicationApi(request, response) {
  const cookies = auth.parseCookies(request);
  const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { sendJson(response, 401, { error: 'Sign in to apply.' }); return; }
  // Live eligibility — recompute against current holdings so the form's gate matches the
  // panel and reflects any change since login (estates, buys/sells) without re-login.
  const elig = await refreshEligibility(session, cookies[auth.SESSION_COOKIE]);

  // Ballot name is server-authoritative: the candidate's Highrise username (the identity
  // voters recognise), falling back to their Highrise Discord display name then global
  // Discord name only if the Highrise profile is unavailable. Never taken from the client.
  const ballotName = (session.profile?.highriseName || session.profile?.serverName || session.profile?.username || '').slice(0, APP_LIMITS.displayName);

  const pathname = request.url.split('?')[0];

  // AI-draft positions from the candidate's current answers (review-before-save).
  if (pathname === '/api/application/derive') {
    if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed.' }); return; }
    if (!applicationWindowOpenFor(elig.bracket)) {
      // Outside the window, only a submitted candidate who can still edit (i.e.
      // voting hasn't begun) keeps the AI draft — it exists to polish their live profile.
      const existing = await db.getApplication(session.discord_id);
      if (!(existing?.status === 'submitted' && applicationEditableFor(elig.bracket))) {
        sendJson(response, 403, { error: 'Applications are not open yet.' });
        return;
      }
    }
    if (!elig.canRun) { sendJson(response, 403, { error: 'You are not eligible to run for a seat.' }); return; }
    if (!derive.isConfigured()) { sendJson(response, 503, { error: 'AI drafting is not configured.' }); return; }
    // Rate limit the paid AI endpoint per user (cost / abuse protection).
    const wait = rateLimited(`derive:${session.discord_id}`, 20, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many AI drafts. Try again later.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const answers = {};
    for (const id of APPLICATION_QUESTIONS) {
      const v = body.answers && typeof body.answers[id] === 'string' ? body.answers[id] : '';
      answers[id] = v.trim().slice(0, APP_LIMITS.answer);
    }
    const positions = await derive.derivePositions(answers);
    db.recordEvent({ event: 'application.derive', discordId: session.discord_id, detail: { answered: Object.values(answers).filter(Boolean).length } });
    sendJson(response, 200, { positions });
    return;
  }

  if (request.method === 'GET') {
    const application = await db.getApplication(session.discord_id);
    sendJson(response, 200, {
      eligibleToRun: !!elig.canRun,
      // Per-user window: the global candidacy phase, or this holder's bracket having
      // its one-time reopen after a "reopen nominations" outcome.
      applicationsOpen: applicationWindowOpenFor(elig.bracket),
      // Whether a submitted application can still be edited — true until voting begins.
      canEdit: applicationEditableFor(elig.bracket),
      bracket: elig.bracket || null,
      ballotName,
      avatar: session.profile?.highriseIcon || null,
      inGuild: !!session.profile?.inGuild,
      propositions: PROPOSITIONS,
      application: publicApplication(application),
    });
    return;
  }

  if (request.method === 'POST') {
    // Server-side gate — never trust the client about eligibility.
    if (!elig.canRun) {
      db.recordEvent({ event: 'application.forbidden', discordId: session.discord_id, ok: false, detail: { bracket: elig.bracket || null, totalCount: elig.totalCount ?? null } });
      sendJson(response, 403, { error: 'You are not eligible to run for a seat.' });
      return;
    }
    // Light rate limit on writes (per user) — prevents draft-spam / DB abuse.
    const wait = rateLimited(`save:${session.discord_id}`, 120, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    // Editing a live candidacy: once submitted, an application STAYS submitted — a
    // "draft" save must never silently pull the candidate out of the race — and it
    // stays editable until voting begins, then freezes so the field voters see
    // can't shift mid-vote. Every edit re-runs full validation.
    const existing = await db.getApplication(session.discord_id);
    const alreadySubmitted = existing?.status === 'submitted';
    if (alreadySubmitted && !applicationEditableFor(elig.bracket)) {
      db.recordEvent({ event: 'application.edit_blocked', discordId: session.discord_id, ok: false, detail: { reason: 'voting_open' } });
      sendJson(response, 403, { error: 'Voting has begun — your submitted application is locked.' });
      return;
    }

    const status = (alreadySubmitted || body.status === 'submitted') ? 'submitted' : 'draft';
    // Candidacy window closed — drafts are allowed (so candidates can prepare),
    // but a FIRST submission is blocked until the window (global or the bracket's
    // post-rejection reopen) is open. Edits to an already-submitted application
    // passed the editable gate above instead.
    if (status === 'submitted' && !alreadySubmitted && !applicationWindowOpenFor(elig.bracket)) {
      db.recordEvent({ event: 'application.submit_blocked', discordId: session.discord_id, ok: false, detail: { reason: 'applications_closed' } });
      sendJson(response, 403, { error: 'Applications are not open for submission yet.' });
      return;
    }
    const displayName = ballotName; // not editable by the candidate
    const pitch = String(body.pitch || '').trim().slice(0, APP_LIMITS.pitch);
    const answers = {};
    for (const id of APPLICATION_QUESTIONS) {
      const v = body.answers && typeof body.answers[id] === 'string' ? body.answers[id] : '';
      answers[id] = v.trim().slice(0, APP_LIMITS.answer);
    }
    const positions = cleanPositions(body.positions);

    if (status === 'submitted') {
      const missing = [];
      if (!displayName) missing.push('displayName');
      if (!pitch) missing.push('pitch');
      for (const id of APPLICATION_QUESTIONS) if (!answers[id]) missing.push(id);
      for (const id of PROPOSITION_IDS) if (!positions[id]) missing.push(`pos:${id}`);
      if (body.consent !== true) missing.push('consent');
      if (missing.length) {
        db.recordEvent({ event: 'application.submit_rejected', discordId: session.discord_id, ok: false, detail: { missing } });
        sendJson(response, 422, { error: 'Complete every field and the acknowledgements before submitting.', missing });
        return;
      }
    }

    const saved = await db.saveApplication({
      discordId: session.discord_id,
      discordUsername: session.profile?.username,
      ethWallet: elig.ethWallet || null,
      bracket: elig.bracket || null,
      avatar: safeIconUrl(session.profile?.highriseIcon),
      displayName, pitch, answers, positions, status,
    });

    // A new (or re-)submission changes the public race counts — drop the cached
    // election snapshot so the status board reflects it on the next load.
    if (status === 'submitted') electionCache.at = 0;

    // Drafts autosave often, so log a light summary. Submissions log the full
    // point-in-time snapshot — preserving exactly what each candidate submitted even
    // if they edit later, and making every submission individually traceable.
    if (status === 'submitted') {
      db.recordEvent({
        event: 'application.submit',
        discordId: session.discord_id,
        detail: {
          bracket: elig.bracket || null,
          ethWallet: elig.ethWallet || null,
          submittedAt: saved.submitted_at || null,
          resubmission: alreadySubmitted,
          snapshot: { displayName, pitch, answers, positions },
        },
      });
    } else {
      db.recordEvent({
        event: 'application.save_draft',
        discordId: session.discord_id,
        detail: {
          bracket: elig.bracket || null,
          hasPitch: !!pitch,
          answered: Object.values(answers).filter(Boolean).length,
          positions: Object.keys(positions).length,
        },
      });
    }

    sendJson(response, 200, { ok: true, application: publicApplication(saved) });
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

// --- Static file serving ---
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

// Strict allowlist for static serving. ONLY these top-level directories and root
// files are reachable — everything else (.env, .git, server-side code in lib/,
// server.js, package.json, node_modules, etc.) returns 404. This is the primary
// guard against leaking secrets or source on an open-source, self-hostable repo.
const PUBLIC_DIRS  = new Set(['css', 'js', 'img', 'assets', 'fonts', 'locales']);
const PUBLIC_FILES = new Set(['index.html', 'changelog.json', 'gen2-progress.json', 'gen2-pets-progress.json', 'collections.json', 'favicon.ico', 'robots.txt', 'sitemap.xml']);
// Gzip candidates: text formats plus raw OpenType/TrueType fonts (~45% smaller).
// WOFF/WOFF2 and images are already compressed — recompressing wastes CPU for ~0%.
const COMPRESSIBLE_EXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.otf', '.ttf']);
const gzipCache = new Map(); // filePath → { etag, body } — one gzipped copy per content version
// Clean tab URLs (/council, /roadmap/gen2, …) all serve the app shell; the client
// router in js/app.js opens the matching tab from location.pathname. 'apply' is a
// legacy alias — the old Apply & Vote tab now lives at /council/vote and the client
// router rewrites it — kept so bookmarks and old OAuth redirects keep working.
const TAB_ROUTES = new Set(['club', 'announcements', 'council', 'apply', 'polls', 'roadmap', 'collections', 'guides', 'perks',
  'holders', 'market', 'trade', 'profile', 'changelog', 'contribute', 'terms', 'privacy']);
const SERVABLE_EXT = new Set([
  '.html', '.css', '.js', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.otf', '.ttf', '.woff', '.woff2', '.txt', '.xml',
]);

// Content-Security-Policy for HTML pages: scripts only from self + the Chart.js CDN
// (no inline/eval scripts); images from self + the Discord & Highrise avatar CDNs;
// inline styles allowed (the markup uses style="" attributes); frames only for the
// YouTube guide embeds; everything else self.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.highrisegame.com https://cdn.discordapp.com https://media.discordapp.net https://cdn-production.joinhighrise.com https://i2c.seadn.io",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src https://www.youtube.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// Security headers. CSP + framing protection only matter for the HTML document;
// nosniff/referrer apply to everything.
// Referrer-Policy is `same-origin` (not the `strict-origin-when-cross-origin` default): the
// card on-ramp rides Immutable's Transak account, and Transak's edge 403s the widget
// ("Access Denied. T-INF-201") when the request carries a Referer outside that account's
// whitelisted domains — which our origin is. No outbound link here needs a referrer, so we
// send none cross-origin (also nice privacy-wise); full referrers stay for same-origin use.
function securityHeaders(extension) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
  if (extension === '.html') {
    h['Content-Security-Policy'] = CSP;
    h['X-Frame-Options'] = 'DENY';
  }
  return h;
}

function resolveFile(requestUrl) {
  let pathname;
  try {
    const url = new URL(requestUrl, `http://${host}:${port}`);
    pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  } catch {
    return null; // malformed URL / bad percent-encoding
  }

  // Normalize, strip leading slashes, split into segments.
  const normalized = path.normalize(pathname).replace(/^([/\\])+/, '');
  const segments = normalized.split(/[/\\]+/).filter(Boolean);
  if (!segments.length) return null;

  // Reject traversal and any dotfile/dot-directory segment (.env, .git, .github…).
  if (segments.some(s => s === '..' || s.startsWith('.'))) return null;

  // Clean tab routes: up to four short lowercase segments with no extension
  // (e.g. /roadmap, /roadmap/gen2, /guides/walkthroughs/funding, and the codex entity
  // pages /collections/trait/outfit/kitsune-spell) serve the app shell. This only ever
  // returns index.html — it never reads an arbitrary path — so it can't leak files; the
  // file allowlist below is unchanged.
  if (segments.length <= 4 && TAB_ROUTES.has(segments[0]) &&
      !path.extname(normalized) && segments.every(s => /^[a-z0-9-]+$/.test(s))) {
    return path.join(root, 'index.html');
  }

  // Allowlist: a single public root file, or a file inside a public directory.
  const top = segments[0];
  const isPublicFile = segments.length === 1 && PUBLIC_FILES.has(top);
  const isPublicDir  = segments.length > 1 && PUBLIC_DIRS.has(top);
  if (!isPublicFile && !isPublicDir) return null;

  // Extension allowlist — never serve files without a known-safe content type.
  if (!SERVABLE_EXT.has(path.extname(normalized).toLowerCase())) return null;

  const filePath = path.join(root, normalized);
  // Final containment backstop.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;

  return filePath;
}

/* ---------------------------------------------------------------- page meta
   Codex entity pages (/collections/release|item|trait|creature/…) all serve the same
   app shell, so a link to any of them used to unfurl in Discord as the site's generic
   card: same title, same description, same picture. That is most of the value of a
   linkable reference thrown away, in the one place holders actually paste links.
   So the shell's head is stamped per URL before the bytes leave: title, description,
   canonical, and the thing the page is actually about as og:image.
   The stamp is also what a reader without JS gets, and what a search engine indexes. */

const CODEX_KINDS = new Set(['release', 'item', 'trait', 'creature', 'term']);
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://hcc.highrise.game').replace(/\/+$/, '');
const SITE_NAME   = 'Highrise Creature Club';

// The same slug the browser writes into these links (js/entity-url.js). The two must
// agree exactly or a shared URL gets the wrong card, so keep them in step.
function entitySlug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
}

// A codex URL, or null for everything else. Sync and cheap: it runs on the shell routes
// only, and decides whether the request is worth the async meta lookup at all.
function codexRouteOf(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  if (segs[0] !== 'collections' || !CODEX_KINDS.has(segs[1]) || segs.length < 3) return null;
  return { kind: segs[1], args: segs.slice(2).map(s => { try { return decodeURIComponent(s); } catch { return s; } }) };
}

// Absolute, because a scraper has no page to resolve a relative path against. Localhost
// keeps its own origin so a local check reads its own art rather than production's.
function siteOrigin(request) {
  const host = String(request.headers.host || '');
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  return SITE_ORIGIN;
}

// The release archive, read from disk for these stamps — the same file the browser
// fetches. Re-read when it changes, so a rebuilt catalogue lands without a restart.
const archiveIndex = { mtimeMs: -1, releases: new Map(), items: new Map() };
function getArchiveIndex() {
  let mtimeMs;
  try { mtimeMs = fs.statSync(path.join(root, 'collections.json')).mtimeMs; }
  catch { return archiveIndex; }            // no file: whatever we already had, or nothing
  if (mtimeMs === archiveIndex.mtimeMs) return archiveIndex;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'collections.json'), 'utf8'));
    const releases = new Map();
    const items = new Map();
    const byDate = [...(doc.releases || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    for (const rel of byDate) {
      releases.set(rel.id, rel);
      // An item is one page per name across every release that carried it, so the first
      // appearance wins here exactly as it does in the browser.
      for (const it of rel.items || []) {
        const key = entitySlug(it.n);
        if (!items.has(key)) items.set(key, { rel, it });
      }
    }
    archiveIndex.mtimeMs = mtimeMs;
    archiveIndex.releases = releases;
    archiveIndex.items = items;
  } catch (err) {
    console.error('Page meta: collections.json unreadable:', err.message);
  }
  return archiveIndex;
}

// Creature number ("#3379", the one holders say) to token id (39 digits, the one the
// chain says). Rebuilt whenever the collection index is.
const creatureNumbers = { forBuild: null, map: new Map() };
function getCreatureNumbers() {
  const coll = getCollectionIndex();
  if (!coll) return null;
  if (creatureNumbers.forBuild !== coll.builtAt) {
    const map = new Map();
    for (const it of coll.items) {
      const m = String(it.name || '').match(/#(\d+)/);
      if (m) map.set(m[1], it);
    }
    creatureNumbers.forBuild = coll.builtAt;
    creatureNumbers.map = map;
  }
  return creatureNumbers.map;
}

// The English copy, for every card the site stamps. Cards are built here, where the
// reader's language is unknown, so they are English only and this is the file that holds
// English. Re-read when it changes, so edited copy lands without a restart; if it ever
// becomes unreadable the last good copy is kept rather than serving a card of nulls.
const localeCache = { mtimeMs: -1, doc: {}, terms: new Map() };
function getLocaleDoc() {
  let mtimeMs;
  try { mtimeMs = fs.statSync(path.join(root, 'locales', 'en.json')).mtimeMs; }
  catch { return localeCache.doc; }
  if (mtimeMs === localeCache.mtimeMs) return localeCache.doc;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'en.json'), 'utf8'));
    const terms = new Map();
    for (const [key, value] of Object.entries(doc)) {
      const m = key.match(/^term\.([a-z0-9-]+)\.(t|p)$/);
      if (!m) continue;
      const entry = terms.get(m[1]) || {};
      entry[m[2]] = value;
      terms.set(m[1], entry);
    }
    localeCache.mtimeMs = mtimeMs;
    localeCache.doc = doc;
    localeCache.terms = terms;
  } catch (err) {
    console.error('Page meta: en.json unreadable:', err.message);
  }
  return localeCache.doc;
}

// Glossary copy for the term cards, indexed off the same read.
function getTerms() {
  getLocaleDoc();
  return localeCache.terms;
}

const RARITY_WORD = { m: 'Mythical', l: 'Legendary', e: 'Epic', r: 'Rare', c: 'Common' };
const TYPE_WORD = {
  drop: 'drop', grab: 'grab', store: 'Creature Store release', event: 'event',
  competition: 'competition', giveaway: 'giveaway', collab: 'collab', other: 'release',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Embeds are English only: they are built here, where the reader's language is unknown,
// and a scraper caches one card per URL for everyone who sees the link.
function whenWord(rel) {
  const [y, m] = String(rel.date || '').split('-');
  if (!y) return '';
  const month = MONTHS[Number(m) - 1];
  const when = month ? `${month} ${y}` : y;
  return rel.precision === 'exact' ? when : `around ${when}`;
}

const group = n => Number(n).toLocaleString('en-US');

function artUrlFor(origin, variant, key) {
  return key ? `${origin}/api/collections/art/${variant}/${encodeURIComponent(key)}.webp` : null;
}

async function codexPageMeta(route, origin) {
  const { kind, args } = route;

  if (kind === 'release' || kind === 'item') {
    const index = getArchiveIndex();
    if (kind === 'release') {
      const rel = index.releases.get(args[0]);
      if (!rel) return null;
      const when = whenWord(rel);
      const hero = (rel.hero || []).map(n => rel.items[n]).find(i => i && i.k);
      const counts = [`${group(rel.items.length)} item${rel.items.length === 1 ? '' : 's'}`];
      if (rel.copies) counts.push(`${group(rel.copies)} copies made`);
      return {
        title: `${rel.name} · ${SITE_NAME}`,
        description: `A club ${TYPE_WORD[rel.type] || 'release'}${
          when ? ` from ${when}` : ''}. ${counts.join(', ')}.`,
        image: artUrlFor(origin, 'full', hero && hero.k),
      };
    }
    const found = index.items.get(args[0]);
    if (!found) return null;
    const { rel, it } = found;
    const rarity = RARITY_WORD[it.r] || '';
    return {
      title: `${it.n} · ${SITE_NAME}`,
      description: `${rarity ? `${rarity} ` : ''}${String(it.c || 'item').replace(/_/g, ' ')} from ${rel.name}.${
        it.q ? ` ${group(it.q)} copies made.` : ''}`,
      image: artUrlFor(origin, 'full', it.k),
    };
  }

  if (kind === 'term') {
    const term = getTerms().get(args[0]);
    if (!term || !term.t) return null;
    return {
      title: term.t === SITE_NAME ? SITE_NAME : `${term.t} · ${SITE_NAME}`,
      description: term.p || '',
      image: null,   // a word has no picture; the club's own icon is the honest stand-in
    };
  }

  if (kind === 'trait') {
    const doc = await getCreatureTraits().catch(() => null);
    if (!doc || doc.indexing) return null;
    const ty = doc.types.find(x => entitySlug(x.type) === args[0]);
    const val = ty && ty.values.find(v => entitySlug(v.v) === args[1]);
    if (!val) return null;
    const share = doc.total ? (val.n / doc.total) * 100 : null;
    const pct = share == null ? '' : share < 0.1 ? 'under 0.1%' : `${share.toFixed(share < 1 ? 2 : 1)}%`;
    return {
      title: `${val.v} · ${ty.label || ty.type} trait · ${SITE_NAME}`,
      description: `Worn by ${group(val.n)} of the ${group(doc.total)} Highrise Creatures${
        pct ? `, ${pct} of the collection` : ''}.${
        val.listed ? ` ${group(val.listed)} on sale now.` : ''}`,
      image: artUrlFor(origin, 'trait', val.art),
    };
  }

  // Creature: from the collection index only. A scraper walking many links must never
  // turn into a burst of upstream metadata reads.
  const numbers = getCreatureNumbers();
  const token = numbers && (numbers.get(String(args[0]).replace(/\D/g, ''))
    || (String(args[0]).length >= 20 ? getCollectionIndex().byId.get(args[0]) : null));
  if (!token) return null;
  const worn = ['Outfit', 'Hair'].map(k => token.traits[k]).filter(v => v && v !== 'None');
  const body = token.traits.Body && token.traits.Body !== 'None' ? token.traits.Body : null;
  const number = String(token.name || '').match(/#(\d+)/);
  return {
    title: `${token.name} · ${SITE_NAME}`,
    description: `${token.rarity ? `${token.rarity}. ` : ''}Ranked ${group(token.rank)} of ${
      group(getCollectionIndex().total)} by how rare its traits are.${
      worn.length ? ` Wearing ${worn.join(' and ')}` : ''}${
      worn.length && body ? `, on a ${body} body.` : worn.length ? '.' : ''}`,
    image: token.image || null,
    // A token id in the URL is the chain's name for it, not the club's. The card points
    // at the readable address, the same one the page itself settles on.
    url: number ? `${origin}/collections/creature/${number[1]}` : null,
  };
}

/* --------------------------------------------------- cards for every route
   The entity pages were the loud half of this problem; the rest of the site is the
   larger half. Every tab, sub-tab and walkthrough step is its own URL served from the
   same shell, so a link to the marketplace tour, the Council ballot or Scam Watch
   unfurled in Discord as the site's front door: same title, same description, same
   picture, whatever you actually linked. The club's project lead posted a link to the
   transfer walkthrough and a link to the marketplace in one message and got two
   identical cards.

   So each route gets a card of its own, and the copy comes from the page's own strings
   in locales/en.json wherever a key says it well. A card built from the page cannot
   drift from the page. Cards are English only: they are stamped here, where the
   reader's language is unknown, and a scraper caches one card per URL for everyone who
   sees the link. */

// Routes that render the same view as another. The card is looked up under the view.
const CARD_ALIAS = new Map([
  ['/', '/club'],
  ['/council', '/council/about'],
  ['/apply', '/council/vote'],
  ['/holders', '/market/holders'],
  ['/guides/scams', '/guides/safety'],
  ['/collections/term', '/collections/glossary'],
]);

// Legacy paths the client rewrites in the address bar as soon as it loads. The card
// points where the reader will actually end up, so a shared link and its canonical agree.
const CANONICAL_ALIAS = new Map([
  ['/apply', '/council/vote'],
  ['/holders', '/market/holders'],
  ['/guides/scams', '/guides/safety'],
  // Buy is the marketplace's front door: /trade/buy is the same page under a name people
  // guess. It has no card of its own, so it unfurls as /trade and points there.
  ['/trade/buy', '/trade'],
]);

// path -> card. `tk` and `dk` name an en.json key, read at request time so the card
// cannot drift from the page; `t` and `d` are literal, for the routes no single key
// says well. `ttpl` wraps the keyed title, which is how the marketplace tour says which
// tour it is: six of its steps are named for the thing they do ("Browse, buy & sell"),
// which read as the marketplace itself rather than as a guide to it. `img` is a
// site-relative picture; `art` asks for a picture from the archive; without either, the
// club's own mark stands.
//
// Routes reached through CARD_ALIAS have no entry: they share the view they alias.
const SECTION_CARDS = {
  "/club": {
    t: "What the club is, and how you get in",
    d: "Start here. Own one of the 11,111 Creatures or a LAND plot and you're a member: what that gets you, how the club got here, and where everything else on the site lives.",
  },
  "/council/about": { tk: "council.top.h2", dk: "council.top.lead" },
  "/council/vote": {
    tk: "council.sub.vote",
    d: "See where the election stands, then sign in with Discord to check whether you can vote and which seat you can run for, match yourself to the candidates, and cast your ballot.",
  },
  "/polls": { tk: "polls.h2", dk: "polls.lead" },
  "/roadmap": {
    tk: "nav.roadmap",
    d: "Two boards. Milestones tracks what the club is building, from Done to The Goal, and the Gen 2 side explains what you're owed, with the pet and creature sets beside it.",
  },
  "/roadmap/milestones": {
    tk: "roadmap.sub.milestones",
    d: "The board of what the club is building, card by card, from Done through Now, Next, Soon and Later to The Goal. Dates go up as they're confirmed.",
  },
  "/roadmap/gen2-explained": { tk: "gx.h2", dk: "gx.lead" },
  "/roadmap/pets": { tk: "g2p.h2", dk: "g2p.lead" },
  "/roadmap/gen2": { tk: "g2.h2", dk: "g2.lead" },
  "/collections": {
    tk: "col.h2",
    d: "The whole archive in one place: every club release, every Creature trait, and the glossary. One search box covers releases, items, traits, terms and Creature numbers.",
    art: "newestRelease",
  },
  "/collections/releases": { tk: "col.sub.releases", dk: "col.lead", art: "newestRelease" },
  "/collections/traits": {
    tk: "ctr.h2",
    d: "Every trait in the Creature collection, slot by slot, as it looks in game. Open one to see how many of the 11,111 Creatures wear it and jump to the marketplace filtered to it.",
  },
  "/collections/glossary": {
    tk: "gloss.h2",
    d: "Every word the club uses, defined in one place: what a grab is, what your Creature Coins can and can't do, how a rarity rank is worked out. Each term opens as its own page.",
  },
  "/guides": {
    t: "Guides for Creature and LAND owners",
    d: "Five sections to work through: what you actually own, Token Trove walkthroughs, a tour of this site's own marketplace, staying safe from scams, and the official links.",
    img: "/assets/og-guides.png",
  },
  "/guides/basics": {
    tk: "guide.what.h2",
    d: "Your Creature and your LAND are NFTs you own on the blockchain, not just inside an app. Plus the four things you'll meet again and again: wallet, marketplace, ETH and IMX.",
    img: "/assets/og-guides.png",
  },
  "/guides/walkthroughs": {
    t: "Token Trove walkthroughs",
    d: "Six walkthroughs, most with a video: link MetaMask, bridge ETH and IMX, buy, sell and transfer creatures, show them in Highrise, and mint LAND you bought with Deeds.",
    img: "/assets/og-guides.png",
  },
  "/guides/marketplace": {
    t: "Trading on this site, step by step",
    d: "A click-by-click tour of our own marketplace: connect your wallet, fund the right network, buy and sell at 0% fee, transfer, and cash out. Each step covers Creatures and LAND.",
    img: "/assets/og-guides.png",
  },
  "/guides/safety": {
    tk: "guide.safe.h2",
    d: "The scams actually hitting Highrise holders, the habits that stop them, a spot-the-scam drill, a safety checklist, and what to do if you've been hit.",
    img: "/assets/og-guides.png",
  },
  "/guides/links": {
    tk: "guide.links.h2",
    d: "Official places to buy, explore, and manage your HCC assets: Highrise LAND, Token Trove, OpenSea for LAND and Gen 2, the Slime Pet Map, Immutable Explorer and MetaMask.",
    img: "/assets/og-guides.png",
  },
  "/guides/walkthroughs/setup": {
    tk: "guide.g1.h",
    d: "Step 1 of the walkthroughs: find Token Trove through the Highrise Discord official links, connect MetaMask on Immutable zkEVM, then check your balances and creatures.",
    img: "/assets/og-guides.png",
  },
  "/guides/walkthroughs/funding": {
    tk: "guide.g2.h",
    d: "Step 2 of the walkthroughs: swap a little ETH for IMX, then use Token Trove's Bridge to move both from Ethereum mainnet to Immutable zkEVM. ETH buys creatures, IMX pays the fee.",
    img: "/assets/og-guides.png",
  },
  "/guides/walkthroughs/trading": {
    t: "Buy & sell creatures on Token Trove",
    d: "Step 3 of the walkthroughs: buy a creature on Token Trove with Buy Now, or list one of your own with List Now. Includes the network switch and the 5% creator royalty.",
    img: "/assets/og-guides.png",
  },
  "/guides/walkthroughs/moving": {
    tk: "guide.g4.h",
    d: "Step 4 of the walkthroughs: send a creature from Token Trove to another wallet, either between your own wallets or as a gift. Paste the address, double-check it, pay the gas fee.",
    img: "/assets/og-guides.png",
  },
  "/guides/walkthroughs/in-game": {
    tk: "guide.g5.h",
    d: "Step 5 of the walkthroughs: link your wallet on the Highrise website, in account Settings under Connect MetaMask Wallet, so your creatures show up under Your Collections.",
    img: "/assets/og-guides.png",
  },
  "/guides/walkthroughs/land": { tk: "guide.g6.h", dk: "guide.g6.p", img: "/assets/og-guides.png" },
  "/guides/marketplace/setup": {
    tk: "gm.setup.h",
    ttpl: "Marketplace tour: {k}",
    dk: "gm.setup.p",
    img: "/assets/og-guides.png",
  },
  "/guides/marketplace/funding": {
    tk: "gm.fund.h",
    ttpl: "Marketplace tour: {k}",
    d: "Pick your situation, from no crypto at all to just short on gas, and watch the fix play out click by click. Plus what each way in really costs: a card is about 4.5%, an exchange well under 1%.",
    img: "/assets/og-guides.png",
  },
  "/guides/marketplace/trading": {
    tk: "gm.trade.h",
    ttpl: "Marketplace tour: {k}",
    d: "Find what you want, buy it, or list your own. We charge 0% marketplace fee, and Creature listings and offers are free to create, just a signature.",
    img: "/assets/og-guides.png",
  },
  "/guides/marketplace/moving": {
    tk: "gm.move.h",
    ttpl: "Marketplace tour: {k}",
    d: "Send a Creature on Immutable zkEVM or a LAND parcel on Ethereum, straight from the Trade tab. The address is checked on-chain before Send unlocks: a transfer can't be undone.",
    img: "/assets/og-guides.png",
  },
  "/guides/marketplace/in-game": {
    tk: "gm.game.h",
    ttpl: "Marketplace tour: {k}",
    d: "Link your wallet and your Creature shows up in your Highrise clothing inventory, while LAND brings its Slime pet. Linking is read-only, so your keys never leave MetaMask.",
    img: "/assets/og-guides.png",
  },
  "/guides/marketplace/cashout": {
    tk: "gm.cash.h",
    ttpl: "Marketplace tour: {k}",
    d: "Sold a Creature? Your ETH lands on Immutable zkEVM, and the Cash out button moves it to Ethereum, the network most exchanges accept. LAND pays in WETH, and one tap unwraps it.",
    img: "/assets/og-guides.png",
  },
  "/market": {
    t: "Market prices and holders",
    d: "Two views of the market: floor prices with sale history for Creatures and LAND, and Holders for who owns what across every wallet.",
    img: "/assets/og-market.png",
  },
  "/market/prices": {
    t: "Prices and sale history",
    d: "Live floor prices for Creatures and LAND with a daily history, and the sales behind them. Set the chart to floor, volume, sales count, or high and low sale.",
    img: "/assets/og-market.png",
  },
  "/market/holders": {
    tk: "holders.h2",
    d: "A live look at HCC wallets: how many hold Creatures, LAND or both, how many NFTs each one holds, which rarity tiers they sit in, and how tightly each collection is held.",
    img: "/assets/og-market.png",
  },
  "/trade": {
    tk: "nav.marketplace",
    d: "Buy, sell, make offers and transfer Creatures on Immutable zkEVM and LAND on Ethereum, priced in ETH or USDC. Your own wallet signs every trade and we charge no marketplace fee.",
  },
  // Each view of the marketplace, so it can be linked to, found, and unfurled as the thing
  // it actually is. `ttpl` keeps the tab's own translated name and says which marketplace
  // it belongs to — "Sell" alone reads as a verb the club is aiming at you.
  "/trade/sell": {
    tk: "trade.tab.sell",
    ttpl: "Marketplace: {k}",
    d: "List what you own for whatever you decide it's worth, one at a time or in bulk. Creature listings cost nothing to create — just a signature — and we take no cut of the sale.",
  },
  "/trade/transfer": {
    tk: "trade.tab.transfer",
    ttpl: "Marketplace: {k}",
    d: "Send Creatures, LAND or coins to another wallet. Pick as many as you like, check the address once, and sign the move yourself. No listing, no fee, no middleman.",
  },
  "/trade/sales": {
    tk: "trade.tab.sales",
    ttpl: "Marketplace: {k}",
    d: "What Creatures and LAND have actually sold for, back to the Immutable X years, with a price chart over whatever you filter to. Search a trait and see what it really goes for.",
  },
  "/trade/history": {
    tk: "trade.tab.myhistory",
    ttpl: "Marketplace: {k}",
    d: "Everything your wallet has done here: what you bought and sold, what you sent and received, and every listing you have open, cancelled or seen expire.",
  },
  "/trade/add-funds": {
    tk: "trade.topup.view.h",
    dk: "trade.topup.view.lead",
  },
  "/trade/cash-out": {
    tk: "trade.cashout.view.h",
    dk: "trade.cashout.view.lead",
  },
  "/profile": {
    tk: "trade.profile.h",
    d: "Switch on a public page that shows what you hold, so a buyer can see who they are dealing with. It is opt-in, and switching it off deletes it.",
  },
  "/profile/:slug": {
    t: "{name}'s profile",
    d: "Browse the Creatures and LAND {name} holds, read straight from the blockchain, and filter down to what's for sale. Holder profiles are opt-in.",
  },
  "/perks": {
    tk: "perks.h2",
    d: "Daily Creature Coins for every Creature and plot you hold, Premium LAND at three times the rate, Highrise+ Tier 1 renewed on the 1st, and a calculator for what yours earns.",
    img: "/assets/og-perks.png",
  },
  "/announcements": { tk: "ann.h2", dk: "ann.lead" },
  "/changelog": {
    tk: "changelog.h2",
    d: "The club's track record in two columns, newest first: what changed in the Creature Club, and what's shipped to this site.",
  },
  "/contribute": { tk: "contrib.gate.h", dk: "contrib.gate.p" },
  "/terms": {
    tk: "terms.h2",
    d: "The rules you accept to take part in the Player Council: what a seat is and isn't, who can vote or run, how ballots are counted, and the code of conduct.",
  },
  "/privacy": {
    tk: "privacy.h2",
    d: "What the Council election collects when you log in with Discord, who it's shared with, what stays private, including your individual vote, and how to ask for your data.",
  },
};

/* ------------------------------------------------------------ the page index

   The header search has to find pages, and this table already knows every page the site
   has: its path, and the en.json keys for its name and its summary. Serving it beats a
   second hand-kept list — a page added for a share card is findable the same day — and
   the keys travel unresolved so the client fills them from its own translations. Results
   come out in the reader's language for free; only the handful of routes carrying literal
   copy (`t`/`d`, for the ones no single key says well) stay English, as their cards do.

   Two exclusions, the same ones the sitemap makes: a canonical alias is another name for
   a route already listed, and a holder's profile is theirs to share, not ours to index. */
function searchPageIndex() {
  const pages = [];
  for (const [route, card] of Object.entries(SECTION_CARDS)) {
    if (route.startsWith('/profile') || CANONICAL_ALIAS.has(route)) continue;
    pages.push({
      // The club's page answers to both /club and /, and / is the one worth showing.
      p: route === '/club' ? '/' : route,
      s: route.split('/')[1] || 'club',
      tk: card.tk || null,
      t: card.t || null,
      ttpl: card.ttpl || null,
      dk: card.dk || null,
      d: card.d || null,
    });
  }
  return pages;
}

function cardCopy(entry) {
  const doc = getLocaleDoc();
  const pick = (key, literal) => {
    const value = key ? doc[key] : null;
    return typeof value === 'string' && value.trim() ? value.trim() : (literal || null);
  };
  let title = pick(entry.tk, entry.t);
  if (title && entry.ttpl) title = entry.ttpl.split('{k}').join(title);
  return { title, description: pick(entry.dk, entry.d) };
}

// The newest release's hero item, so the Collections card shows what the club shipped
// last rather than a logo. It comes from collections.json, which is already on disk for
// the entity cards, so a scraper triggers no upstream read for it.
function newestReleaseArt(origin) {
  const index = getArchiveIndex();
  let newest = null;
  for (const rel of index.releases.values()) {
    if (!newest || String(rel.date || '') > String(newest.date || '')) newest = rel;
  }
  const hero = newest && (newest.hero || []).map(n => newest.items[n]).find(Boolean);
  return hero ? artUrlFor(origin, 'full', hero.k) : null;
}

/* The marketplace serves two collections, and ?coll=land is not a detail of one page — it
   is the other market, with other assets, other prices and another chain under it. So a
   LAND address gets its own head and its own line in the sitemap, rather than unfurling as
   the Creature market it isn't. Only the description moves: the title still names the view,
   because that is what the member clicked. */
const LAND_CARD_D = {
  "/trade": "Every LAND plot for sale, each with the Slime pet that comes with it. Browse by the Slime's traits and rarity rank; trades settle on Ethereum through OpenSea's order book, at no fee from us.",
  "/trade/sell": "List a LAND plot you own. You set the price, it goes on OpenSea's order book where every LAND buyer can see it, and we take no cut.",
  "/trade/sales": "What LAND plots have actually sold for, with a price chart over whatever you filter to. Compare by plot type and by the Slime that came with the parcel.",
};
function landCardFor(pathname, card) {
  const d = LAND_CARD_D[pathname];
  return d ? { ...card, dk: null, d } : card;
}

// The card for a path: itself, then the view it aliases, then its parent. The walk up is
// what makes an unknown deep link (a renamed walkthrough step, a stale bookmark) unfurl
// as the page it belongs to instead of as the front door.
function findCard(pathname) {
  let p = pathname;
  for (let i = 0; i < 4 && p; i++) {
    if (SECTION_CARDS[p]) return { card: SECTION_CARDS[p], at: p };
    const alias = CARD_ALIAS.get(p);
    if (alias && SECTION_CARDS[alias]) return { card: SECTION_CARDS[alias], at: alias };
    const cut = p.lastIndexOf('/');
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return null;
}

function sectionPageMeta(pathname, origin, search) {
  const p = pathname.replace(/\/+$/, '') || '/';
  const found = findCard(p);
  if (!found) return null;
  let card = found.card;
  // The one query parameter that changes which page this is, rather than what it is showing.
  const land = found.at.startsWith('/trade') && search?.get('coll') === 'land';
  if (land) card = landCardFor(found.at, card);
  const { title, description } = cardCopy(card);
  if (!title && !description) return null;
  // The canonical is the page the card actually describes. An address with no card of its
  // own — a renamed step, /trade/typo, a dead entity slug — unfurls as the page it belongs
  // to, and now points there too, instead of inviting a crawler to index a typo.
  const canonical = CANONICAL_ALIAS.get(found.at) || found.at;
  return {
    title: !title || title === SITE_NAME ? SITE_NAME : `${title} · ${SITE_NAME}`,
    description: description || '',
    image: card.art === 'newestRelease' ? newestReleaseArt(origin)
      : card.img ? origin + card.img : null,
    // Self-referencing, land included: a shared LAND link should point at the LAND market,
    // not fold into the Creature one.
    url: origin + canonical + (land ? '?coll=land' : ''),
    // A fixed set of routes with a fixed stamp each, so the gzipped copy is worth keeping.
    // The origin is in the key because the stamp carries it: two hostnames serving the
    // same route are two different bodies, and without it they would evict each other.
    cacheKey: `shell:${origin}:${canonical}${land ? '?coll=land' : ''}`,
  };
}

/* Holder profiles are the one card here built from a person's own row. A profile exists
   only because its holder switched it on, and the card carries only what that page
   already shows the world: the name they chose and their avatar. Never the wallet, never
   a holding count (counting means reading two chains, and a scraper must never set that
   off). A profile that is off, or a slug that never existed, gets no card of its own. */
function profileRouteOf(pathname) {
  const m = pathname.match(/^\/profile\/([a-z0-9-]{1,40})\/?$/);
  return m ? m[1] : null;
}

async function profilePageMeta(slug, origin) {
  const card = SECTION_CARDS['/profile/:slug'];
  if (!card) return null;
  let row = null;
  try { row = await db.getHolderProfileBySlug(slug); } catch { row = null; }
  // Disabling a profile deletes it, so dead links are normal. They unfurl as the feature
  // they point at, which is true, rather than as the site's front door, which is not.
  if (!row) return sectionPageMeta(`/profile/${slug}`, origin, null);
  const name = String(row.display_name || '').slice(0, 40) || slug;
  const { title, description } = cardCopy(card);
  const fill = s => (s || '').split('{name}').join(name);
  const avatar = String(row.avatar || '');
  return {
    title: `${fill(title)} · ${SITE_NAME}`,
    description: fill(description),
    image: /^https:\/\//.test(avatar) ? avatar : null,
    url: `${origin}/profile/${row.slug || slug}`,
  };
}

// The head tags this stamps. Each is matched on its own attribute, so a head edit that
// moves them around is fine and one that removes them is caught at boot below.
const META_SLOTS = [
  ['title', /<title>[\s\S]*?<\/title>/, v => `<title>${v}</title>`],
  ['description', /<meta name="description" content="[^"]*">/,
    v => `<meta name="description" content="${v}">`],
  ['description', /<meta property="og:description" content="[^"]*">/,
    v => `<meta property="og:description" content="${v}">`],
  ['title', /<meta property="og:title" content="[^"]*">/,
    v => `<meta property="og:title" content="${v}">`],
  ['url', /<meta property="og:url" content="[^"]*">/,
    v => `<meta property="og:url" content="${v}">`],
  ['url', /<link rel="canonical" href="[^"]*">/, v => `<link rel="canonical" href="${v}">`],
  ['image', /<meta property="og:image" content="[^"]*">/,
    v => `<meta property="og:image" content="${v}">`],
];

const attrEscape = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function stampPageMeta(html, meta) {
  let out = html;
  for (const [field, pattern, build] of META_SLOTS) {
    const value = meta[field];
    if (value == null || value === '') continue;   // no picture: keep the club's own icon
    out = out.replace(pattern, build(attrEscape(value)));
  }
  return out;
}

// If someone edits the head and one of these disappears, the stamp goes quiet rather
// than wrong — worth a line in the log, because a silent miss looks like nothing at all.
(() => {
  try {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const missing = META_SLOTS.filter(([, pattern]) => !pattern.test(html));
    if (missing.length) console.warn(`Page meta: ${missing.length} head tag(s) no longer match; those stamps are off.`);
  } catch { /* the shell is missing, which will announce itself elsewhere */ }
})();

/* ----------------------------------------------------------------- sitemap
   The hand-written sitemap.xml lists the twenty tab routes and nothing else, so the
   thousands of codex entity pages are invisible to every search engine. Outside Discord,
   a search engine is how anyone finds a reference at all, so the file becomes a floor and
   the real sitemap is generated from the same data the pages are.

   Built at most once an hour and held in memory: it is one string, and a crawler asks for
   it rarely. If any part of it can't be built, that part is left out rather than guessed —
   a sitemap that lists a page we can't render is worse than a shorter one. */

const SITEMAP_TTL_MS = 60 * 60 * 1000;
const sitemapCache = { xml: null, at: 0, origin: null, inFlight: null };

// The dates in collections.json are the release dates, which for these pages is exactly
// what lastmod means. Nothing else gets one: a made-up date is worse than none.
function urlEntry(loc, lastmod) {
  return `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
}

async function buildSitemap(origin) {
  const out = [];

  // The hand-kept routes, read from the file so it stays the one place they are listed.
  try {
    const file = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
    for (const m of file.matchAll(/<url>[\s\S]*?<\/url>/g)) out.push(m[0].split(SITE_ORIGIN).join(origin));
  } catch (err) {
    console.error('Sitemap: static routes unreadable:', err.message);
  }

  // Every carded route, so a sub-tab or a walkthrough step is crawlable in its own right
  // rather than living only inside the shell. The hand-kept file wins where the two
  // overlap, because it carries the lastmod dates. Aliases are left out: they redirect to
  // a route that is already listed, and a profile is its holder's to share, not ours.
  const listed = new Set([...out.join('').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
  for (const route of Object.keys(SECTION_CARDS)) {
    if (route.startsWith('/profile') || CANONICAL_ALIAS.has(route)) continue;
    const loc = origin + (route === '/club' ? '/club' : route);
    if (!listed.has(loc)) out.push(urlEntry(loc, null));
    // The LAND market has its own head at the same paths, so it gets its own lines here.
    // Only the views that mean something for LAND — it has no coin transfers or own history
    // page of its own to advertise.
    if (LAND_CARD_D[route]) out.push(urlEntry(`${loc}?coll=land`, null));
  }

  // Every live announcement, with the date it was posted as its lastmod. If the database
  // is unreachable the sitemap is shorter by that many lines, which is the rule the rest
  // of this builder follows: leave it out rather than guess it.
  try {
    for (const row of await db.getAnnouncements({ limit: 200 })) {
      const when = row.edited_at || row.posted_at;
      out.push(urlEntry(origin + announcementPath(row),
        when ? new Date(when).toISOString().slice(0, 10) : null));
    }
  } catch (err) {
    console.error('Sitemap: announcements unreadable:', err.message);
  }

  const index = getArchiveIndex();
  for (const rel of index.releases.values()) {
    out.push(urlEntry(`${origin}/collections/release/${rel.id}`,
      rel.precision === 'exact' ? rel.date : null));
  }
  for (const [key, { rel }] of index.items) {
    out.push(urlEntry(`${origin}/collections/item/${key}`,
      rel.precision === 'exact' ? rel.date : null));
  }

  // Traits and Creatures only once their indexes are built. A crawler that arrives during
  // the boot sweep gets the shorter list and the full one an hour later.
  const traits = await getCreatureTraits().catch(() => null);
  if (traits && !traits.indexing) {
    for (const ty of traits.types) {
      for (const val of ty.values) {
        out.push(urlEntry(`${origin}/collections/trait/${entitySlug(ty.type)}/${entitySlug(val.v)}`));
      }
    }
  }
  for (const slug of getTerms().keys()) {
    out.push(urlEntry(`${origin}/collections/term/${slug}`));
  }
  const numbers = getCreatureNumbers();
  if (numbers) {
    for (const n of numbers.keys()) out.push(urlEntry(`${origin}/collections/creature/${n}`));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    out.join('\n')}\n</urlset>\n`;
}

async function getSitemap(origin) {
  const fresh = sitemapCache.xml && sitemapCache.origin === origin
    && Date.now() - sitemapCache.at < SITEMAP_TTL_MS;
  if (fresh) return sitemapCache.xml;
  // One build at a time: a crawler that opens several connections must not start several
  // sweeps of the same data.
  if (!sitemapCache.inFlight) {
    sitemapCache.inFlight = buildSitemap(origin)
      .then(xml => { sitemapCache.xml = xml; sitemapCache.at = Date.now(); sitemapCache.origin = origin; return xml; })
      .finally(() => { sitemapCache.inFlight = null; });
  }
  return sitemapCache.inFlight;
}

// A link pasted into chat / a game / a sentence often picks up trailing punctuation —
// e.g. "https://hcc.highrise.game/announcements." → the request path is "/announcements.",
// which matches no route and 404s. Given a request URL, return the same URL with trailing
// punctuation stripped from the PATH (query preserved) when that actually changes it and
// leaves a non-empty path, else null. Only used as a last resort on would-be 404s, so it
// can never affect a URL that already resolves.
function trimmedTrailingPunctUrl(requestUrl) {
  let url;
  try { url = new URL(requestUrl, `http://${host}:${port}`); } catch { return null; }
  const stripped = url.pathname.replace(/[.,;:!?'")\]]+$/g, '');
  if (stripped === url.pathname || stripped === '' || stripped === '/') return null;
  return stripped + url.search;
}

// Parse a request URL against the (untrusted) Host header. A malformed Host makes
// `new URL` throw synchronously — before any async .catch() attaches — which would
// crash the process; return null instead so routes can answer 400.
function parseRequestUrl(request) {
  try { return new URL(request.url, `http://${request.headers.host || 'localhost'}`); }
  catch { return null; }
}

const server = http.createServer((request, response) => {
  // Auth + eligibility API (async). Catches errors so a failed lookup sends the
  // user back to the Apply panel with an error flag instead of hanging.
  if (request.url.startsWith('/api/auth') || request.url === '/api/me') {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'Bad request.' }); return; }
    handleAuthApi(request, response, url).catch(err => {
      console.error('Auth API error:', err.message);
      if (!response.headersSent) {
        if (url.pathname === '/api/me') sendJson(response, 200, { authenticated: false });
        else redirectToApp(request, response, 'failed');
      }
    });
    return;
  }

  if (request.url.startsWith('/api/profile')) {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'Bad request.' }); return; }
    handleProfileApi(request, response, url).catch(err => {
      console.error('Profile API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url.startsWith('/api/application')) {
    handleApplicationApi(request, response).catch(err => {
      console.error('Application API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url.startsWith('/api/vote')) {
    handleVoteApi(request, response).catch(err => {
      console.error('Vote match API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url.startsWith('/api/ballot')) {
    handleBallotApi(request, response).catch(err => {
      console.error('Ballot API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url.startsWith('/api/polls')) {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'Bad request.' }); return; }
    handlePollsApi(request, response, url).catch(err => {
      console.error('Polls API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  // Collections art, out of Postgres. Two reasons it lives there rather than in the repo:
  // the pictures come to ~35 MB, and this way the client only ever sees a content hash, so
  // nothing published names a Highrise item. `thumb` and `full` are the release archive's two
  // sizes of one item; `trait` is a Creature Traits tile, which comes in one size and out of
  // its own table (see lib/db.js for why it isn't a third variant of the same rows).
  const artMatch = request.url.match(/^\/api\/collections\/art\/(thumb|full|trait)\/([0-9a-f]{16})\.webp$/);
  if (artMatch) {
    handleCollectionArt(request, response, artMatch[1], artMatch[2]).catch(err => {
      console.error('Collection art error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  // The page half of the site search. Built from the share-card table, so it is static for
  // the life of the process and costs nothing to serve.
  if (request.url === '/api/search/pages') {
    sendJson(response, 200, { pages: searchPageIndex() },
      { 'Cache-Control': 'public, max-age=300' }, { request });
    return;
  }

  if (request.url.startsWith('/api/announcements')) {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'Bad request.' }); return; }
    handleAnnouncementsApi(request, response, url).catch(err => {
      console.error('Announcements API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url === '/api/holders/progress') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(fetchProgress));
    return;
  }

  // Rarity & tier close-up. Its own endpoint because its own sweep is on a 12-hour clock,
  // an order of magnitude slower than the 30-minute holder snapshot — folding it into
  // /api/holders would either stall that response or pin both to the same TTL. Answers
  // { ready: false } while the first sweep runs; the page just leaves the section out.
  if (request.url.startsWith('/api/holders/quality')) {
    const data = getHolderQuality();
    sendJson(response, 200, data ? { ready: true, ...data } : { ready: false },
      { 'Cache-Control': 'public, max-age=600, stale-while-revalidate=1800' }, { request });
    return;
  }

  if (request.url.startsWith('/api/holders')) {
    getHolderStats()
      .then(data => {
        sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=900' }, { request });
      })
      .catch(err => {
        console.error('Holder stats request failed:', err.message);
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Holder data temporarily unavailable.' }));
      });
    return;
  }

  if (request.url.startsWith('/api/election')) {
    getElectionStatus()
      .then(data => {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(data));
      })
      .catch(err => {
        console.error('Election status request failed:', err.message);
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Election status temporarily unavailable.' }));
      });
    return;
  }

  if (request.url.startsWith('/api/market/creatures') || request.url.startsWith('/api/market/land')
      || request.url.startsWith('/api/market/onramp')) {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'bad_request' }); return; }
    handleMarketplaceApi(request, response, url).catch(err => {
      console.error('Marketplace API error:', err.message);
      // readJsonBody rejections carry a 4xx statusCode (bad JSON / oversized body);
      // wrapper errors carry a stable .code (e.g. 'unavailable').
      if (!response.headersSent) sendJson(response, err.statusCode || 503, { error: err.code || (err.statusCode ? 'bad_request' : 'unavailable') });
    });
    return;
  }

  if (request.url.startsWith('/api/market')) {
    getMarketStats()
      .then(data => {
        sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=900' }, { request });
      })
      .catch(err => {
        console.error('Market stats request failed:', err.message);
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Market data temporarily unavailable.' }));
      });
    return;
  }

  // The generated sitemap, ahead of the static file of the same name: the file still
  // holds the hand-kept tab routes and is read as this one's first section.
  if (request.url === '/sitemap.xml' || request.url.startsWith('/sitemap.xml?')) {
    getSitemap(siteOrigin(request))
      .then(xml => {
        response.writeHead(200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          ...securityHeaders('.xml'),
        });
        response.end(xml);
      })
      .catch(error => {
        console.error('Sitemap failed:', error.message);
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Sitemap unavailable');
      });
    return;
  }

  const filePath = resolveFile(request.url);

  if (!filePath) {
    // Rescue links that arrived with trailing punctuation (e.g. "/announcements." from a
    // pasted URL): if dropping it yields a real route, redirect there instead of 404ing.
    const cleaned = trimmedTrailingPunctUrl(request.url);
    if (cleaned && resolveFile(cleaned)) {
      response.writeHead(302, { Location: cleaned, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const serveShell = pageMeta => fs.readFile(filePath, (error, raw) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    // Stamp the shell's head before anything else reads the bytes, so the ETag, the 304
    // and the gzip all describe the page that was actually asked for.
    const data = pageMeta ? Buffer.from(stampPageMeta(raw.toString('utf8'), pageMeta), 'utf8') : raw;

    const extension = path.extname(filePath).toLowerCase();

    // Content-hash ETag. This is the validator that was missing: with it, `no-cache`
    // revalidation is deterministic (304 when unchanged, full body when changed) instead
    // of undefined-across-browsers, which is what left users on days-old copies.
    const etag = 'W/"' + crypto.createHash('sha1').update(data).digest('base64').slice(0, 27) + '"';

    // Files have no content-hashed names, so nothing may be frozen with `immutable`
    // (that previously pinned media for a year). Binary media gets a short cache then
    // revalidates; everything that defines a "page" (html/css/js/json/svg) revalidates
    // every load so a new deploy is picked up immediately.
    const media = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.otf', '.ttf', '.woff', '.woff2']);
    const cacheControl = media.has(extension)
      ? 'public, max-age=3600, must-revalidate'
      : 'no-cache';

    const secHeaders = securityHeaders(extension);

    // Text (and OTF/TTF font) responses gzip well and this app ships big ones —
    // ~200KB CSS and ~140KB HTML, both `no-cache`. Served raw, a slow connection
    // paints the HTML before the stylesheet lands (flash of unstyled content), so
    // compression is a rendering fix, not just bandwidth. Vary only on responses
    // that can differ per encoding, to keep shared caches from fragmenting media.
    const compressible = COMPRESSIBLE_EXT.has(extension);
    const vary = compressible ? { Vary: 'Accept-Encoding' } : {};

    // Honour conditional requests — cheap 304 when the browser already has this content.
    // The ETag is weak (content-derived, encoding-agnostic), so it validates both the
    // gzipped and identity variants.
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, ...vary, ...secHeaders });
      response.end();
      return;
    }

    const baseHeaders = {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
      ...vary,
      ...secHeaders,
    };

    const acceptsGzip = String(request.headers['accept-encoding'] || '').includes('gzip');
    if (!compressible || !acceptsGzip) {
      response.writeHead(200, baseHeaders);
      response.end(data);
      return;
    }

    // Compress once per content version, then serve from memory. The cache is bounded
    // by the allowlisted static text files, and a stale entry self-evicts when the
    // file's ETag moves on.
    // A stamped shell is a different body per URL. The section cards are a fixed set of
    // about fifty routes and every one of them is a page people load, so those are cached
    // under their own key. Entity and profile cards are not: keying thousands of them by
    // path would thrash the cache, and keying them by content would grow it without a
    // bound. A stale entry self-evicts, because the ETag moves with the bytes.
    const gzipKey = pageMeta ? (pageMeta.cacheKey || null) : filePath;
    const cached = gzipKey ? gzipCache.get(gzipKey) : null;
    if (cached && cached.etag === etag) {
      response.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip' });
      response.end(cached.body);
      return;
    }
    zlib.gzip(data, (gzipError, gzipped) => {
      if (gzipError || gzipped.length >= data.length) {
        response.writeHead(200, baseHeaders);
        response.end(data);
        return;
      }
      if (gzipKey) gzipCache.set(gzipKey, { etag, body: gzipped });
      response.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip' });
      response.end(gzipped);
    });
  });

  // Every shell URL gets a head of its own: an entity page from the archive, a holder
  // profile from its row, and every tab, sub-tab and walkthrough step from the copy on
  // the page itself. Anything the stamp can't answer for — an unknown item, a trait
  // catalogue still building, a route with no card — serves the shell unchanged rather
  // than half a card. Static files never pay for any of this.
  const requested = parseRequestUrl(request);
  const isShell = requested && path.basename(filePath) === 'index.html';
  if (!isShell) { serveShell(null); return; }
  const origin = siteOrigin(request);
  const codex = codexRouteOf(requested.pathname);
  const profile = codex ? null : profileRouteOf(requested.pathname);
  const announcement = codex || profile ? null : announcementRouteOf(requested.pathname);
  const section = () => sectionPageMeta(requested.pathname, origin, requested.searchParams);
  const pending = announcement ? announcementPageMeta(announcement, origin)
    : codex
    // A renamed release, a Creature number that never existed, a trait catalogue still
    // indexing: the entity card can't be built, so the card for the part of the site it
    // belongs to stands in. That is true of the link, which the generic card is not.
    ? codexPageMeta(codex, origin).then(meta => meta || section())
    : profile ? profilePageMeta(profile, origin)
    : Promise.resolve(section());
  pending
    .then(meta => serveShell(meta ? { ...meta, url: meta.url || origin + requested.pathname } : null))
    .catch(error => {
      console.error('Page meta failed:', error.message);
      serveShell(null);
    });
});

// Outlast the edge proxy's idle timeout. Node closes a keep-alive socket after 5s by
// default; Railway's proxy pools connections for longer, so it could hand a request to
// a socket we were already closing. That request is simply lost, and the proxy answers
// 502 once it gives up ~15s later — random assets on a normal page load, which is
// enough to break the module that reveals the page. Keeping our side open longer means
// the proxy, not us, decides when a pooled connection ends. headersTimeout must stay
// above keepAliveTimeout or Node reaps the connection it just agreed to hold.
server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

server.listen(port, host, () => {
  console.log(`HCC Player Council site running on http://${host}:${port}`);
  // LAND's sale history is eighty pages of OpenSea events, swept once and held. Started
  // here so the first member to open Sales History doesn't wait on it — the tab answers
  // from the live window meanwhile, and picks up the rest as soon as it lands.
  landMarket.warmSalesArchive().catch(() => {});
  // Gas assist state at boot — the float is the thing that silently runs out, so say it
  // out loud on every deploy. Logs the faucet ADDRESS (public) and never the key.
  gasFaucet.health().then(h => {
    if (!h.configured) return console.log('[gas-faucet] no GAS_FAUCET_KEY — gas assist off.');
    if (!h.enabled) return console.log(`[gas-faucet] key present, GAS_FAUCET_ENABLED not set — off (wallet ${h.address}).`);
    if (h.balanceWei == null) return console.warn(`[gas-faucet] LIVE (wallet ${h.address}) but the balance read failed: ${h.error}`);
    const imx = Number(h.balanceWei) / 1e18;
    console.log(`[gas-faucet] LIVE — wallet ${h.address}, float ${imx.toFixed(4)} IMX${h.lowFloat ? '  *** LOW — top up ***' : ''}`);
  }).catch(() => {});
});
