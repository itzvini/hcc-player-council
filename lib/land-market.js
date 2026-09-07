// LAND market via OpenSea — server-side only (the API key never reaches a browser,
// CSP stays connect-src 'self'). LAND is the OTHER half of the marketplace's world:
// it lives on Ethereum mainnet and trades on OpenSea's Seaport, so nothing from the
// Immutable orderbook stack applies. Same trust model though: this module only READS
// public data and PREPARES unsigned transactions; the user's wallet signs everything.
//
// Verified empirically (2026-06-10) before this was written:
// - /listings/collection/{slug}/all returns live Seaport orders (paginated).
// - /listings/fulfillment_data returns the unsigned fulfillAdvancedOrder call for a
//   SPECIFIC fulfiller (OpenSea's signed zone binds the tx to that address — calldata
//   sent from anyone else reverts, so prepared buys can't be hijacked).
// - input_data arrives as named structs; encoding requires a NAMED Seaport ABI
//   (canonical unnamed signatures fail in ethers) — validated via eth_estimateGas
//   from the bound fulfiller (~223k gas on a real listing).

const LAND_CONTRACT = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11';
const LAND_SLUG = 'highrise-land';
const OS_BASE = 'https://api.opensea.io/api/v2';
const OS_KEY = (process.env.OPENSEA_API_KEY || '').trim();
// Offers (collection bids) settle in WETH — Seaport offers can't use native ETH. This is
// canonical mainnet WETH; we read offers denominated in it and (later phases) build them.
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
// USDC on Ethereum mainnet (Circle) — a dollar-pegged LISTING currency alongside native ETH,
// so a seller can price in stable dollars instead of riding ETH's swings (like Token Trove).
// VERIFIED ON-CHAIN 2026-07-23 (symbol()=="USDC", decimals()==6). USDC is 6 decimals (ETH is
// 18): every price/fee amount below is decimals-aware. Never swap this address for a search-
// found one without re-checking symbol/decimals — a wrong token means listings no one can fill.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
// Accepted LAND listing currencies. The sell/create scope guard only ever permits a token in
// THIS map — never an arbitrary address (preserves the June 2026 audit guarantee). ETH is
// native (Seaport itemType 0, ZERO_ADDR); USDC is an ERC-20 (itemType 1). `code` is the
// lowercase tag the client's currency-aware display uses ('eth'|'usdc').
const LAND_CURRENCIES = {
  eth:  { code: 'eth',  itemType: 0, token: '0x0000000000000000000000000000000000000000', decimals: 18, symbol: 'ETH'  },
  usdc: { code: 'usdc', itemType: 1, token: USDC,                                          decimals: 6,  symbol: 'USDC' },
};
const landCurrency = key => LAND_CURRENCIES[String(key || '').toLowerCase()] || null;
// Resolve a consideration item's (itemType, token) back to one of our allowed currencies, or
// null for anything else — the scope guard's allowlist check on create.
function landCurrencyByItem(itemType, token) {
  const t = String(token || '').toLowerCase();
  if (Number(itemType) === 0 && t === ZERO_ADDR) return LAND_CURRENCIES.eth;
  if (Number(itemType) === 1 && t === USDC) return LAND_CURRENCIES.usdc;
  return null;
}
// OpenSea reports a listing's currency by symbol; map it to our code + decimals. ETH and WETH
// are both 18-decimal 1:1 ETH; USDC is 6-decimal dollars. Anything else → null (ignored).
function landCurrencyBySymbol(sym) {
  const s = String(sym || '').toUpperCase();
  if (s === 'ETH' || s === 'WETH') return LAND_CURRENCIES.eth;
  if (s === 'USDC') return LAND_CURRENCIES.usdc;
  return null;
}
// Smallest-unit integer string → human amount number, at the currency's decimals.
function unitsToAmt(units, decimals) {
  try { return Math.round(Number(BigInt(units)) / 10 ** decimals * 1e6) / 1e6; }
  catch { return null; }
}

// OFFER currencies differ from LISTING currencies: a Seaport offer can't use native ETH, so the
// ETH-equivalent offer settles in WETH (itemType 1), and USDC offers settle in USDC. `code`
// stays 'eth'|'usdc' so the client's currency-aware display is shared with listings.
const LAND_OFFER_CURRENCIES = {
  eth:  { code: 'eth',  token: WETH, decimals: 18, symbol: 'WETH', wrap: true  },
  usdc: { code: 'usdc', token: USDC, decimals: 6,  symbol: 'USDC', wrap: false },
};
const landOfferCurrency = key => LAND_OFFER_CURRENCIES[String(key || '').toLowerCase()] || null;
// Map an offer item's (itemType, token) back to an allowed offer currency (WETH or USDC), else null.
function landCurrencyByOfferToken(itemType, token) {
  if (Number(itemType) !== 1) return null;
  const t = String(token || '').toLowerCase();
  if (t === WETH) return LAND_OFFER_CURRENCIES.eth;
  if (t === USDC) return LAND_OFFER_CURRENCIES.usdc;
  return null;
}

// Selling (creating a listing) means CONSTRUCTING + signing a Seaport order ourselves —
// OpenSea only prepares fulfilment (buys), never listing creation. The pieces below were
// verified empirically against a live listing (2026-06-16): the locally-computed EIP-712
// order hash matched OpenSea's order_hash exactly, and the conduit/counter reads were
// confirmed on mainnet. See the "Sell" section near the bottom of this file.
const SEAPORT       = '0x0000000000000068f116a894984e2db1123eb395'; // Seaport 1.6 (mainnet)
const CONDUIT       = '0x1E0049783F008A0085193E00003D00cd54003c71'; // OpenSea conduit (getConduit-verified)
const CONDUIT_KEY   = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
const ZERO_ADDR     = '0x0000000000000000000000000000000000000000';
const ZERO_HASH     = '0x' + '00'.repeat(32);
// LAND reads (ownerOf, getCounter, isApprovedForAll) must reflect RECENT state — e.g. a
// parcel acquired moments before listing, or an approval/counter just changed — so they use
// a reliable full node. Blockscout's eth-rpc has been observed to lag recent state (it
// under-reported a wallet's balance), which would wrongly block a valid listing. Shares the
// server's ETH_BALANCE_RPC override so one env var points all fresh-state reads at one node.
const ETH_RPC_URL   = (process.env.ETH_BALANCE_RPC || 'https://ethereum-rpc.publicnode.com').trim();
// Emergency kill-switch for the real-money sell flow (browse/buy/transfer stay up).
// Default ON; set LAND_SELL=0 in the environment to instantly disable listing creation.
const sellEnabled = () => process.env.LAND_SELL !== '0';
// Same, for the make-an-offer (collection bid) flow. Default ON; LAND_OFFER=0 disables.
const offerEnabled = () => process.env.LAND_OFFER !== '0';
// Fees as last confirmed from /collections/highrise-land — used only if the live fetch
// fails (a listing built with the wrong fees would be rejected, so never guess loosely).
const DEFAULT_FEES = [
  { bps: 100, recipient: '0x0000a26b00c1f0df003000390027140000faa719' }, // OpenSea 1% (required)
  { bps: 500, recipient: '0xc4862a6e1c1552bce246e3dc7e7fc0f7bc647bfb' }, // creator 5% (PW royalty wallet)
];

let ethers = null;
try { ethers = require('ethers'); } catch { /* transitive dep — present in practice */ }
const crypto = require('crypto');

const configured = () => Boolean(OS_KEY && ethers);

// Named Seaport fragments — names are REQUIRED so ethers can map OpenSea's structured
// input_data objects; the canonical (unnamed) signature cannot encode them.
const OFFER_ITEM = '(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)';
const CONSIDERATION_ITEM = '(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)';
const ORDER_PARAMETERS = `(address offerer, address zone, ${OFFER_ITEM}[] offer, ${CONSIDERATION_ITEM}[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems)`;
const ORDER_COMPONENTS = `(address offerer, address zone, ${OFFER_ITEM}[] offer, ${CONSIDERATION_ITEM}[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter)`;
const ADVANCED_ORDER = `(${ORDER_PARAMETERS} parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData)`;
const CRITERIA_RESOLVER = '(uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)';
const FULFILLMENT_COMPONENT = '(uint256 orderIndex, uint256 itemIndex)';
const FULFILLMENT = `(${FULFILLMENT_COMPONENT}[] offerComponents, ${FULFILLMENT_COMPONENT}[] considerationComponents)`;
// OpenSea returns the gas-optimized fulfillBasicOrder_efficient_6GL6yc (selector
// 0x00000000) for SIMPLE listings — a single ERC721 sold for native ETH with only fee
// recipients. Most LAND listings are exactly that, so a buy MUST be able to encode it;
// without this fragment those buys fail with "unknown function". Field names match
// OpenSea's input_data.parameters exactly (verified: encode + 198k-gas estimate).
const ADDITIONAL_RECIPIENT = '(uint256 amount, address recipient)';
const BASIC_ORDER_PARAMETERS = `(address considerationToken, uint256 considerationIdentifier, uint256 considerationAmount, address offerer, address zone, address offerToken, uint256 offerIdentifier, uint256 offerAmount, uint8 basicOrderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 offererConduitKey, bytes32 fulfillerConduitKey, uint256 totalOriginalAdditionalRecipients, ${ADDITIONAL_RECIPIENT}[] additionalRecipients, bytes signature)`;
const seaportIface = () => new ethers.Interface([
  `function fulfillBasicOrder_efficient_6GL6yc(${BASIC_ORDER_PARAMETERS} parameters) payable returns (bool fulfilled)`,
  `function fulfillAdvancedOrder(${ADVANCED_ORDER} advancedOrder, ${CRITERIA_RESOLVER}[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)`,
  `function fulfillAvailableAdvancedOrders(${ADVANCED_ORDER}[] advancedOrders, ${CRITERIA_RESOLVER}[] criteriaResolvers, ${FULFILLMENT_COMPONENT}[][] offerFulfillments, ${FULFILLMENT_COMPONENT}[][] considerationFulfillments, bytes32 fulfillerConduitKey, address recipient, uint256 maximumFulfilled) payable returns (bool[] availableOrders, ((uint256 amount, address token, uint8 itemType, uint256 identifier, address recipient) item, address offerer, bytes32 conduitKey)[] executions)`,
  // Accepting a collection OFFER: OpenSea matches the bidder's order against the seller's
  // generated counter-order; the criteria resolver carries the proof for the sold tokenId.
  `function matchAdvancedOrders(${ADVANCED_ORDER}[] orders, ${CRITERIA_RESOLVER}[] criteriaResolvers, ${FULFILLMENT}[] fulfillments, address recipient) payable returns (((uint256 amount, address token, uint8 itemType, uint256 identifier, address recipient) item, address offerer, bytes32 conduitKey)[] executions)`,
  `function cancel(${ORDER_COMPONENTS}[] orders) returns (bool cancelled)`,
]);

// ERC-721 + Seaport read/write helpers we need for listing (approval, counter, owner).
const auxIface = () => new ethers.Interface([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function setApprovalForAll(address operator, bool approved)',
  'function getCounter(address offerer) view returns (uint256)',
]);

// WETH (offers pay in it): wrap native ETH (deposit), approve the conduit to pull it, and
// read balance/allowance so we only ask for a wrap/approval when actually needed.
const wethIface = () => new ethers.Interface([
  'function deposit() payable',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const MAX_UINT256 = '0x' + 'f'.repeat(64);

// USDC (an ERC-20 like WETH): a USDC BUYER must approve the conduit to pull their USDC before
// the fulfilment can settle. Native-ETH buys need none of this (value carries the price).
const usdcIface = () => new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

// EIP-712 type set for a Seaport order. The locally-computed hashStruct over this exact
// shape matched OpenSea's order_hash byte-for-byte, so a wallet signing this payload
// produces a signature Seaport accepts.
const SEAPORT_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
};
const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
const seaportDomain = () => ({ name: 'Seaport', version: '1.6', chainId: 1, verifyingContract: SEAPORT });

// Minimal mainnet eth_call. The land flow is otherwise pure OpenSea REST; selling needs
// three reads (ownerOf, isApprovedForAll, getCounter) the API doesn't expose.
async function ethCall(to, data) {
  const res = await fetch(ETH_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error || !json.result) fail('unavailable', 503, `eth_call ${to.slice(0, 10)} failed: ${JSON.stringify(json.error || 'no result')}`);
  return json.result;
}

const fail = (code, statusCode, logMsg) => {
  if (logMsg) console.error(`LAND market [${code}]:`, logMsg);
  throw Object.assign(new Error(code), { code, statusCode });
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry transient OpenSea failures (429 + 5xx + transport) before giving up. Without this
// a single rate-limit blip reached the client as a hard error, while the Immutable side
// retried three times — so LAND looked more fragile than it is. Honours Retry-After but
// caps the wait, because a request holding a socket for 30s is its own outage.
// GET only: a retried write could double-submit.
async function osFetch(path, init = {}) {
  if (!configured()) fail('not_configured', 503);
  const idempotent = !init.method || init.method.toUpperCase() === 'GET';
  const tries = idempotent ? 3 : 1;
  let lastCode = 'unavailable', lastLog = '';

  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(`${OS_BASE}${path}`, {
        ...init,
        headers: { Accept: 'application/json', 'X-API-KEY': OS_KEY, ...(init.headers || {}) },
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      lastCode = 'unavailable'; lastLog = `OpenSea transport for ${path}: ${err.message}`;
      if (attempt < tries) { await sleep(Math.min(3000, 400 * 2 ** (attempt - 1))); continue; }
      fail(lastCode, 503, lastLog);
    }

    if (res.ok) return res.json();

    const body = await res.text().catch(() => '');
    // Answers, not failures: never retry these.
    if (/can not perform trading/i.test(body)) fail('blocked_account', 400);
    if (res.status === 404 || /not found/i.test(body)) fail('not_found', 404, `OpenSea 404 for ${path}`);

    const transient = res.status === 429 || res.status >= 500;
    lastCode = res.status === 429 ? 'rate_limited' : 'unavailable';
    lastLog = `OpenSea ${res.status} for ${path}: ${body.slice(0, 200)}`;
    if (!transient || attempt === tries) fail(lastCode, res.status === 429 ? 429 : 503, lastLog);

    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(3000, retryAfter * 1000)
      : Math.min(3000, 400 * 2 ** (attempt - 1));
    console.warn(`LAND market: ${lastCode} on ${path}, retry ${attempt}/${tries - 1} in ${wait}ms`);
    await sleep(wait);
  }
  fail(lastCode, 503, lastLog); // unreachable, but keeps the contract explicit
}

const wei2eth = w => Math.round(Number(BigInt(w)) / 1e14) / 1e4;

// Parcel coordinates drive the slime-pet render (lib/land-pets.js): prefer the
// "Land X"/"Land Y" traits, fall back to the "LAND (x, y)" name OpenSea mints.
function landCoords(name, traits) {
  const find = key => traits?.find(t => t.trait === key)?.value;
  let x = Number(find('Land X')), y = Number(find('Land Y'));
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    const m = /\((-?\d{1,4}),\s*(-?\d{1,4})\)/.exec(name || '');
    if (!m) return null;
    x = Number(m[1]); y = Number(m[2]);
  }
  return { x, y };
}

// LAND art barely changes — cache metadata forever (bounded).
const metaCache = new Map(); // tokenId -> {name, image, traits, coords}
function cacheMeta(tokenId, meta) {
  if (metaCache.size > 5000) metaCache.clear();
  metaCache.set(String(tokenId), meta);
  return meta;
}

async function fetchLandMeta(tokenId) {
  const hit = metaCache.get(String(tokenId));
  if (hit) return hit;
  try {
    const { nft } = await osFetch(`/chain/ethereum/contract/${LAND_CONTRACT}/nfts/${tokenId}`);
    const name = nft?.name || `Highrise LAND #${tokenId}`;
    const traits = Array.isArray(nft?.traits)
      ? nft.traits.map(t => ({ trait: t.trait_type, value: t.value })).filter(t => t.trait && t.value != null)
      : [];
    return cacheMeta(tokenId, {
      name,
      image: nft?.display_image_url || nft?.image_url || null,
      traits,
      coords: landCoords(name, traits),
    });
  } catch { return null; } // one bad token must not sink a page
}

// Limited-concurrency metadata join — OpenSea rate-limits bursts on one key.
async function joinMeta(items) {
  const queue = [...items];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      const meta = await fetchLandMeta(it.tokenId);
      if (meta) { it.name = meta.name; it.image = meta.image; it.coords = meta.coords; }
    }
  });
  await Promise.all(workers);
  return items;
}

// A page of active LAND listings, cheapest data OpenSea returns (their /all endpoint
// is creation-ordered; we sort the page by price for a sane default view). Mixed-currency:
// ETH listings carry priceEth; USDC (dollar-pegged) listings carry priceUsdc. Each row's
// `currency` tag ('eth'|'usdc') drives the client's currency-aware display. The ETH-equivalent
// used for sorting/floor is computed upstream (getLandBrowse, where the ETH/USD rate lives).
async function listListings(cursor) {
  const qs = new URLSearchParams({ limit: '24' });
  if (cursor) qs.set('next', cursor);
  const body = await osFetch(`/listings/collection/${LAND_SLUG}/all?${qs}`);
  const items = (body.listings || []).map(l => {
    const p = l.protocol_data?.parameters;
    const tokenId = p?.offer?.[0]?.identifierOrCriteria;
    const priceUnits = l.price?.current?.value;
    const cur = landCurrencyBySymbol(l.price?.current?.currency);
    if (!tokenId || !priceUnits || !cur) return null;
    const amt = unitsToAmt(priceUnits, cur.decimals); // all-in buyer price, in the currency's units
    return {
      orderHash: l.order_hash,
      protocolAddress: l.protocol_address,
      tokenId: String(tokenId),
      seller: (p?.offerer || '').toLowerCase() || null,
      currency: cur.code,
      priceAmt: amt,                                 // native amount (ETH or USDC)
      priceEth: cur.code === 'eth' ? amt : null,     // ETH-equivalent for USDC filled in upstream
      priceUsdc: cur.code === 'usdc' ? amt : null,
      name: `Highrise LAND #${tokenId}`,
      image: null,
    };
  }).filter(Boolean);
  // A token can carry several active listings — show only its cheapest. Same-currency: cheaper
  // native amount wins. Across currencies (a token listed in both ETH and USDC — rare): prefer
  // the ETH one, so the dedupe stays deterministic without needing an ETH/USD rate here.
  const bestByToken = new Map();
  for (const it of items) {
    const prev = bestByToken.get(it.tokenId);
    if (!prev) { bestByToken.set(it.tokenId, it); continue; }
    const better = it.currency === prev.currency ? it.priceAmt < prev.priceAmt : it.currency === 'eth';
    if (better) bestByToken.set(it.tokenId, it);
  }
  const deduped = [...bestByToken.values()];
  await joinMeta(deduped);
  // ETH first (cheapest → dearest), then USDC (cheapest → dearest) — cosmetic only; getLandBrowse
  // re-sorts by the true ETH-equivalent once the rate is known.
  deduped.sort((a, b) => (a.currency === b.currency ? a.priceAmt - b.priceAmt : a.currency === 'eth' ? -1 : 1));
  return { items: deduped, nextCursor: body.next || null };
}

// Active collection-wide offers ("standing offers" / floor bids any holder can sell a
// parcel into), best first. Settled in WETH: the bidder's `offer` is the TOTAL WETH they pay
// for ALL units; the criteria consideration item's amount is how many parcels they want. A
// single accept sells ONE parcel for the PER-PARCEL share, so every price here is normalised
// per parcel (a 0.56-for-4 offer is a 0.14 offer) — matching what a seller actually receives.
async function listCollectionOffers() {
  if (!configured()) fail('not_configured', 503);
  const body = await osFetch(`/offers/collection/${LAND_SLUG}`);
  const offers = (body.offers || []).map(o => {
    const p = o.protocol_data?.parameters;
    const offerItem = (p?.offer || [])[0];
    // Accept collection offers paid in WETH (→ 'eth', 18-dec, ≈ETH) OR USDC (→ 'usdc', 6-dec,
    // dollar-pegged). Anything else is ignored. Fees are the SAME-token consideration items
    // (the NFT criteria item is itemType 4 — not a fee).
    const cur = offerItem ? landCurrencyByOfferToken(offerItem.itemType, offerItem.token) : null;
    if (!cur) return null;
    const grossTotal = BigInt(offerItem.startAmount || '0');
    if (grossTotal <= 0n) return null;
    // Quantity wanted = the criteria NFT item's amount (itemType 4). Multi-parcel bids
    // (e.g. "0.56 for 4 parcels") fill one at a time, so divide to a per-parcel price.
    const nftItem = (p.consideration || []).find(c => Number(c.itemType) === 4);
    const units = (() => { const q = BigInt(nftItem?.startAmount || '1'); return q > 0n ? q : 1n; })();
    const feeUnits = (p.consideration || [])
      .filter(c => Number(c.itemType) === 1 && String(c.token || '').toLowerCase() === cur.token)
      .reduce((s, c) => s + BigInt(c.startAmount || '0'), 0n);
    const gross = grossTotal / units;                                              // per parcel
    const net = (grossTotal > feeUnits ? grossTotal - feeUnits : grossTotal) / units; // per parcel, after fees
    const priceAmt = unitsToAmt(gross, cur.decimals);
    const netAmt = unitsToAmt(net, cur.decimals);
    return {
      offerId: o.order_hash,
      protocolAddress: o.protocol_address, // needed to fetch fulfilment data on accept
      from: (p.offerer || '').toLowerCase() || null,
      units: Number(units),        // how many parcels the bidder wants in total
      currency: cur.code,
      priceAmt, netAmt,            // native (WETH≈ETH or USDC), per parcel
      priceEth: cur.code === 'eth' ? priceAmt : null, // ETH-equivalent filled in server-side for USDC
      netEth: cur.code === 'eth' ? netAmt : null,
      grossWei: gross.toString(),  // per-parcel smallest-units — funding math on accept
      expiresAt: p?.endTime ? Number(p.endTime) : null,
    };
  }).filter(Boolean);
  // Best first by native amount within a currency; the server re-ranks the mixed book by
  // ETH-equivalent once the rate is known.
  offers.sort((a, b) => (a.currency === b.currency ? b.priceAmt - a.priceAmt : a.currency === 'eth' ? -1 : 1));
  return { offers };
}

async function getToken(tokenId) {
  // Read the on-chain owner alongside metadata so the detail modal can show (and copy)
  // it. NOTE: estate-locked parcels are held by the estate contract, so ownerOf returns
  // that contract's address, not the person — expected, and surfaced as-is.
  const [meta, owner] = await Promise.all([
    fetchLandMeta(tokenId),
    readOwnerOf(tokenId).catch(() => null),
  ]);
  if (!meta) fail('not_found', 404);
  return { tokenId: String(tokenId), owner: owner || null, ...meta };
}

// The plot TIER (Standard vs Premium) is the parcel's own OpenSea "Rarity" trait
// (values normal/premium) — what Highrise calls a Standard vs Premium plot. This is the
// PARCEL's attribute, NOT the slime's statistical rarity rank; the two are unrelated.
// The collection-NFTs endpoint returns it inline, so capturing it here costs no extra
// calls. Unknown/missing → null (the parcel just carries no Tier facet).
function tierOf(traits) {
  const r = (traits || []).find(t => /^rarity$/i.test(t.trait_type || t.trait || ''));
  const v = String(r?.value || '').toLowerCase();
  if (v === 'premium') return 'Premium';
  if (v === 'normal' || v === 'standard') return 'Standard';
  return null;
}

// Every parcel in the collection as {tokenId, x, y, tier}. The collection-NFTs endpoint
// returns the "LAND (x, y)" name AND the trait list inline, so coords + tier parse with
// NO per-token metadata calls — the whole 2,973-parcel set comes back in ~15 pages.
// Long-cached: the LAND map doesn't change. This is the worklist for the slime sweep
// (lib/slime-index), which carries the tier through onto each parcel's browse row.
let parcelListCache = { data: null, at: 0 };
const PARCEL_LIST_TTL_MS = 24 * 60 * 60 * 1000;
async function allParcelCoords() {
  if (parcelListCache.data && Date.now() - parcelListCache.at < PARCEL_LIST_TTL_MS) return parcelListCache.data;
  const out = [];
  let next = null, pages = 0;
  do {
    const qs = new URLSearchParams({ limit: '200' });
    if (next) qs.set('next', next);
    const body = await osFetch(`/collection/${LAND_SLUG}/nfts?${qs}`);
    for (const n of (body.nfts || [])) {
      const coords = landCoords(n.name, null);
      if (coords) out.push({ tokenId: String(n.identifier), x: coords.x, y: coords.y, name: n.name, tier: tierOf(n.traits) });
    }
    next = body.next || null;
  } while (next && ++pages < 30);
  // Never cache an empty crawl for a day. A 200 with no `nfts` isn't an answer, it's a
  // bad moment upstream, and caching it starved the slime sweep of its worklist for 24h
  // (Aug 2026: the LAND tier + trait filters went blank and couldn't heal themselves).
  if (out.length) parcelListCache = { data: out, at: Date.now() };
  return out;
}

// LAND owned by one wallet. Estate-locked parcels are owned by the estate contract
// on-chain, so they are naturally absent here — exactly right for trading surfaces.
async function ownedLand(address) {
  const items = [];
  let next = null, pages = 0;
  do {
    const qs = new URLSearchParams({ collection: LAND_SLUG, limit: '50' });
    if (next) qs.set('next', next);
    const body = await osFetch(`/chain/ethereum/account/${address}/nfts?${qs}`);
    for (const n of (body.nfts || [])) {
      const name = n.name || `Highrise LAND #${n.identifier}`;
      items.push({
        tokenId: String(n.identifier),
        name,
        image: n.display_image_url || n.image_url || null,
        coords: landCoords(name, null), // account listings carry no traits — name only
      });
    }
    next = body.next || null;
    pages++;
  } while (next && pages < 4);
  return { items, truncated: Boolean(next) };
}

// Unsigned buy transaction for a listing, bound by OpenSea's signed zone to `taker`
// (sent from any other address it reverts — verified). Native ETH: value carries the full
// price, no approval. USDC (ERC-20): value is 0 and the buyer must first approve the conduit
// to pull their USDC — we prepend that one-time approval when the current allowance is short.
async function prepareBuy({ orderHash, protocolAddress, taker }) {
  const body = await osFetch('/listings/fulfillment_data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      listing: { hash: orderHash, chain: 'ethereum', protocol_address: protocolAddress },
      fulfiller: { address: taker },
    }),
  });
  const tx = body.fulfillment_data?.transaction;
  if (!tx?.function || !tx.input_data) fail('not_active', 409, 'no fulfillment transaction in response');
  const fnName = tx.function.slice(0, tx.function.indexOf('('));
  let data;
  try {
    data = seaportIface().encodeFunctionData(fnName, Object.values(tx.input_data));
  } catch (err) {
    fail('unavailable', 503, `encode failed for ${fnName}: ${err.message}`);
  }

  const transactions = [];
  // If this listing is priced in USDC, the buyer's USDC must be approved to the OpenSea conduit
  // (same mechanism as WETH offers). Read the payment token + total from the order OpenSea
  // returns; only prepend an approval when the standing allowance can't cover it.
  const orderConsideration = body.fulfillment_data?.orders?.[0]?.parameters?.consideration || [];
  const usdcItems = orderConsideration.filter(c => Number(c?.itemType) === 1 && String(c?.token || '').toLowerCase() === USDC);
  if (usdcItems.length) {
    const need = usdcItems.reduce((s, c) => s + BigInt(c.startAmount || '0'), 0n);
    const iface = usdcIface();
    let allowance = 0n;
    try {
      const res = await ethCall(USDC, iface.encodeFunctionData('allowance', [taker, CONDUIT]));
      allowance = BigInt(iface.decodeFunctionResult('allowance', res)[0]);
    } catch { /* read hiccup → prepend the approval to be safe (a no-op if already allowed) */ allowance = 0n; }
    if (allowance < need) {
      transactions.push({ purpose: 'APPROVAL', to: USDC, data: iface.encodeFunctionData('approve', [CONDUIT, MAX_UINT256]), value: '0x0' });
    }
  }
  transactions.push({
    purpose: 'FULFILL_ORDER',
    to: tx.to,
    data,
    value: '0x' + BigInt(tx.value || 0).toString(16),
  });
  return { transactions, chainId: '0x1' }; // Ethereum mainnet — the client switches networks for LAND
}

// Prepare selling a parcel INTO a standing collection offer (accept a bid). OpenSea returns
// a ready Seaport tx (matchAdvancedOrders) bound to the seller, carrying the criteria proof
// for `tokenId`; we prepend the one-time conduit NFT approval if it isn't set yet. The
// seller provides the NFT and RECEIVES WETH — no WETH approval needed on their side (the
// bidder's WETH is already approved). Trust model unchanged: unsigned tx only, wallet signs.
async function prepareAcceptOffer({ orderHash, protocolAddress, tokenId, taker }) {
  if (!configured()) fail('not_configured', 503);
  const owner = await readOwnerOf(tokenId);
  if (owner == null) fail('not_found', 404);
  if (owner !== taker.toLowerCase()) fail('not_owner', 400);

  const body = await osFetch('/offers/fulfillment_data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: { hash: orderHash, chain: 'ethereum', protocol_address: protocolAddress },
      fulfiller: { address: taker },
      // Which parcel the seller is providing — required so OpenSea resolves the collection
      // criteria to this specific tokenId (and returns its proof).
      consideration: { asset_contract_address: LAND_CONTRACT, token_id: String(tokenId) },
    }),
  });
  const tx = body.fulfillment_data?.transaction;
  if (!tx?.function || !tx.input_data) fail('not_active', 409, 'no fulfillment transaction in offer response');
  const fnName = tx.function.slice(0, tx.function.indexOf('('));
  let data;
  try {
    data = seaportIface().encodeFunctionData(fnName, Object.values(tx.input_data));
  } catch (err) {
    fail('unavailable', 503, `accept encode failed for ${fnName}: ${err.message}`);
  }
  const transactions = [];
  if (!(await isApproved(taker))) transactions.push(approvalAction());
  transactions.push({
    purpose: 'FULFILL_ORDER',
    to: tx.to,
    data,
    value: '0x' + BigInt(tx.value || 0).toString(16),
  });
  return { transactions, chainId: '0x1' };
}

// --- Sell (create / manage a listing) ---
// OpenSea has no "prepare listing" endpoint (unlike buys): a listing is a Seaport order
// the SELLER builds and signs, then we relay the signed order to OpenSea. Trust model is
// unchanged — we never hold keys or funds; the wallet signs the EIP-712 order and (first
// time only) an on-chain conduit approval. Real money on mainnet, so every amount is exact
// integer wei and the fee recipients come from OpenSea's own fee schedule.

// Marketplace + creator fees, live from OpenSea (cached). `fee` is a percent (1 => 1%).
let feesCache = { data: null, at: 0 };
async function getFees() {
  if (feesCache.data && Date.now() - feesCache.at < 10 * 60 * 1000) return feesCache.data;
  try {
    const col = await osFetch(`/collections/${LAND_SLUG}`);
    const fees = (col.fees || [])
      .map(f => ({ bps: Math.round(Number(f.fee) * 100), recipient: String(f.recipient || '').toLowerCase() }))
      .filter(f => f.bps > 0 && /^0x[0-9a-f]{40}$/.test(f.recipient));
    if (fees.length) { feesCache = { data: fees, at: Date.now() }; return fees; }
  } catch (err) { console.error('LAND fees fetch failed, using defaults:', err.message); }
  return DEFAULT_FEES;
}

async function readOwnerOf(tokenId) {
  const iface = auxIface();
  try {
    const res = await ethCall(LAND_CONTRACT, iface.encodeFunctionData('ownerOf', [String(tokenId)]));
    return iface.decodeFunctionResult('ownerOf', res)[0].toLowerCase();
  } catch { return null; } // non-existent token reverts — treat as "not found"
}
async function isApproved(owner) {
  const iface = auxIface();
  const res = await ethCall(LAND_CONTRACT, iface.encodeFunctionData('isApprovedForAll', [owner, CONDUIT]));
  return Boolean(iface.decodeFunctionResult('isApprovedForAll', res)[0]);
}
async function readCounter(offerer) {
  const iface = auxIface();
  const res = await ethCall(SEAPORT, iface.encodeFunctionData('getCounter', [offerer]));
  return iface.decodeFunctionResult('getCounter', res)[0]; // bigint
}
const approvalAction = () => ({
  type: 'TRANSACTION', purpose: 'APPROVAL', to: LAND_CONTRACT,
  data: auxIface().encodeFunctionData('setApprovalForAll', [CONDUIT, true]), value: '0x0',
});

// Raw active listings for the collection (full protocol_data), for "my listings" + cancel.
// The collection is small (~tens active); a few pages of 50 covers it.
async function scanRawListings(maxPages = 5) {
  const out = [];
  let next = null, pages = 0;
  do {
    const qs = new URLSearchParams({ limit: '50' });
    if (next) qs.set('next', next);
    const body = await osFetch(`/listings/collection/${LAND_SLUG}/all?${qs}`);
    out.push(...(body.listings || []));
    next = body.next || null;
  } while (next && ++pages < maxPages);
  return out;
}

// Raw active collection offers (full protocol_data) — for "my offers" + offer cancel. The
// active set is small (tens), so a page or two covers it.
async function scanRawOffers(maxPages = 3) {
  const out = [];
  let next = null, pages = 0;
  do {
    const qs = new URLSearchParams({ limit: '50' });
    if (next) qs.set('next', next);
    const body = await osFetch(`/offers/collection/${LAND_SLUG}?${qs}`);
    out.push(...(body.offers || []));
    next = body.next || null;
  } while (next && ++pages < maxPages);
  return out;
}

// Build the seller's unsigned conduit approval (if needed) + the EIP-712 order to sign,
// plus the exact parameters to POST on create. Price is rounded down to a clean multiple
// so every fee split is an exact integer (matches how OpenSea itself builds the order).
// `currency` picks the settlement token: 'eth' (native, itemType 0) or 'usdc' (ERC-20,
// itemType 1). `priceUnits` is the all-in buyer price in that currency's smallest units
// (wei for ETH, 6-decimal units for USDC). The NFT conduit approval is identical either way;
// USDC needs no seller-side token approval (the seller RECEIVES USDC, the buyer approves it).
async function prepareListing({ tokenId, currency = 'eth', priceUnits, maker, durationDays }) {
  if (!configured()) fail('not_configured', 503);
  if (!sellEnabled()) fail('disabled', 503);
  const cur = landCurrency(currency);
  if (!cur) fail('bad_currency', 400);
  const owner = await readOwnerOf(tokenId);
  if (owner == null) fail('not_found', 404);
  if (owner !== maker.toLowerCase()) fail('not_owner', 400);

  // Round down to a clean multiple so both fee splits stay exact integers. 10000 units is dust
  // in ETH (18 dec) and 1 cent in USDC (6 dec) — fine either way.
  let price = BigInt(priceUnits) - (BigInt(priceUnits) % 10000n);
  if (price <= 0n) fail('bad_price', 400);

  const fees = await getFees();
  let feeTotal = 0n;
  const feeItems = fees.map(f => {
    const amount = (price * BigInt(f.bps)) / 10000n;
    feeTotal += amount;
    return { itemType: cur.itemType, token: cur.token, identifierOrCriteria: '0', startAmount: amount.toString(), endAmount: amount.toString(), recipient: f.recipient };
  });
  const proceeds = price - feeTotal;
  if (proceeds <= 0n) fail('bad_price', 400);

  // proceeds-to-seller FIRST, then fee items — matches OpenSea's own consideration order.
  const consideration = [
    { itemType: cur.itemType, token: cur.token, identifierOrCriteria: '0', startAmount: proceeds.toString(), endAmount: proceeds.toString(), recipient: maker.toLowerCase() },
    ...feeItems,
  ];
  const offer = [{ itemType: 2, token: LAND_CONTRACT, identifierOrCriteria: String(tokenId), startAmount: '1', endAmount: '1' }];

  const counter = (await readCounter(maker)).toString();
  const now = Math.floor(Date.now() / 1000);
  const days = Math.min(30, Math.max(1, Math.floor(Number(durationDays) || 7)));
  const salt = '0x' + crypto.randomBytes(32).toString('hex'); // hex string — matches OpenSea's own format

  // Signing payload = OrderComponents (counter, no totalOriginal...); POST payload adds
  // totalOriginalConsiderationItems. Both are derived from one source of truth here.
  const message = {
    offerer: maker.toLowerCase(), zone: ZERO_ADDR, offer, consideration,
    orderType: 0, startTime: String(now), endTime: String(now + days * 86400),
    zoneHash: ZERO_HASH, salt, conduitKey: CONDUIT_KEY, counter,
  };
  const orderParameters = { ...message, totalOriginalConsiderationItems: consideration.length };
  const orderHash = ethers.TypedDataEncoder.hashStruct('OrderComponents', SEAPORT_TYPES, message);

  const actions = [];
  if (!(await isApproved(maker))) actions.push(approvalAction());
  actions.push({
    type: 'SIGNABLE', purpose: 'CREATE_LISTING',
    typedData: { types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...SEAPORT_TYPES }, domain: seaportDomain(), primaryType: 'OrderComponents', message },
  });

  const money = cur.code === 'eth'
    ? { priceEth: wei2eth(price), proceedsEth: wei2eth(proceeds), feeEth: wei2eth(feeTotal) }
    : { priceUsdc: unitsToAmt(price, 6), proceedsUsdc: unitsToAmt(proceeds, 6), feeUsdc: unitsToAmt(feeTotal, 6) };
  return { actions, orderParameters, orderHash, chainId: '0x1', currency: cur.code, ...money };
}

// Relay the signed order to OpenSea. The scope guard keeps this from being a generic
// Seaport relay (our API key must only ever post LAND listings); OpenSea independently
// verifies the signature against the order, so a tampered order fails there too.
async function createListing({ orderParameters, signature }) {
  if (!configured()) fail('not_configured', 503);
  if (!sellEnabled()) fail('disabled', 503);
  const offer = Array.isArray(orderParameters?.offer) ? orderParameters.offer : [];
  const consideration = Array.isArray(orderParameters?.consideration) ? orderParameters.consideration : [];
  // The order must sell exactly one LAND parcel and be priced in ONE allowed currency (native
  // ETH or USDC) — every consideration item (proceeds + fees) in that same token. Widened from
  // ETH-only to {ETH, USDC}: still never an arbitrary/worthless token, so the June 2026 audit's
  // "our key can't be a generic Seaport relay" guarantee holds.
  const payCur = consideration.length ? landCurrencyByItem(consideration[0]?.itemType, consideration[0]?.token) : null;
  const scopeOk = offer.length === 1
    && String(offer[0]?.token || '').toLowerCase() === LAND_CONTRACT
    && Number(offer[0]?.itemType) === 2
    && payCur
    && consideration.every(c => Number(c?.itemType) === payCur.itemType && String(c?.token || '').toLowerCase() === payCur.token);
  if (!scopeOk) fail('bad_order', 400);

  const body = await osFetch('/orders/ethereum/seaport/listings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: orderParameters, signature, protocol_address: SEAPORT }),
  });
  const order = body.order || {};
  return { orderHash: order.order_hash || null, status: order.order_hash ? 'created' : 'unknown' };
}

// --- Make an offer (create a collection bid) ---
// Offers settle in WETH and use a RESTRICTED order (orderType 3) bound to OpenSea's signed
// zone, so the structure differs from a listing. We let OpenSea build the criteria item +
// zone (whole-collection criteria = identifierOrCriteria 0), add the WETH offer + the
// REQUIRED marketplace fee only (creator royalty is optional on offers and omitted, matching
// live offers), then the maker signs. Empirically verified against live offers (2026-06-20).

// Only the fees OpenSea marks `required` apply to offers (the creator royalty is optional).
async function getOfferFees() {
  try {
    const col = await osFetch(`/collections/${LAND_SLUG}`);
    const fees = (col.fees || [])
      .filter(f => f.required)
      .map(f => ({ bps: Math.round(Number(f.fee) * 100), recipient: String(f.recipient || '').toLowerCase() }))
      .filter(f => f.bps > 0 && /^0x[0-9a-f]{40}$/.test(f.recipient));
    if (fees.length) return fees;
  } catch (err) { console.error('LAND offer fees fetch failed, using default:', err.message); }
  return [{ bps: 100, recipient: '0x0000a26b00c1f0df003000390027140000faa719' }]; // OpenSea 1%
}

async function prepareOffer({ makerAddress, currency = 'eth', priceUnits, durationDays }) {
  if (!configured()) fail('not_configured', 503);
  if (!offerEnabled()) fail('disabled', 503);
  const cur = landOfferCurrency(currency);
  if (!cur) fail('bad_currency', 400);
  const maker = String(makerAddress).toLowerCase();
  const price = BigInt(priceUnits) - (BigInt(priceUnits) % 10000n); // clean fee math (exact integers)
  if (price <= 0n) fail('bad_price', 400);

  // OpenSea builds the whole-collection criteria item (recipient = maker) + the zone.
  const built = await osFetch('/offers/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offerer: maker, quantity: 1, criteria: { collection: { slug: LAND_SLUG } }, protocol_address: SEAPORT }),
  });
  const pp = built.partialParameters;
  if (!Array.isArray(pp?.consideration) || !pp.consideration.length || !pp.zone) {
    fail('unavailable', 503, 'offers/build returned no usable partialParameters');
  }

  const fees = await getOfferFees();
  let feeTotal = 0n;
  const feeItems = fees.map(f => {
    const amount = (price * BigInt(f.bps)) / 10000n;
    feeTotal += amount;
    return { itemType: 1, token: cur.token, identifierOrCriteria: '0', startAmount: amount.toString(), endAmount: amount.toString(), recipient: f.recipient };
  });
  const offer = [{ itemType: 1, token: cur.token, identifierOrCriteria: '0', startAmount: price.toString(), endAmount: price.toString() }];
  // OpenSea's criteria item(s) first (NFT the bidder wants → maker), then the fee(s).
  const consideration = [...pp.consideration, ...feeItems];

  const counter = (await readCounter(maker)).toString();
  const now = Math.floor(Date.now() / 1000);
  const days = Math.min(30, Math.max(1, Math.floor(Number(durationDays) || 7)));
  const salt = '0x' + crypto.randomBytes(32).toString('hex');

  const message = {
    offerer: maker, zone: pp.zone, offer, consideration,
    orderType: 3, startTime: String(now), endTime: String(now + days * 86400),
    zoneHash: pp.zoneHash || ZERO_HASH, salt, conduitKey: CONDUIT_KEY, counter,
  };
  const orderParameters = { ...message, totalOriginalConsiderationItems: consideration.length };
  const orderHash = ethers.TypedDataEncoder.hashStruct('OrderComponents', SEAPORT_TYPES, message);

  // On-chain prerequisites, only if needed. ETH offers wrap native ETH → WETH for the shortfall,
  // then approve the conduit for WETH. USDC offers can't be minted, so there's no wrap — the
  // maker must already hold USDC; we only add the conduit approval and report any shortfall. The
  // balanceOf + allowance + approve ABI is identical for WETH and USDC, so one iface serves both.
  const ti = wethIface();
  const [tokBalRaw, tokAlwRaw] = await Promise.all([
    ethCall(cur.token, ti.encodeFunctionData('balanceOf', [maker])),
    ethCall(cur.token, ti.encodeFunctionData('allowance', [maker, CONDUIT])),
  ]);
  const tokBal = BigInt(ti.decodeFunctionResult('balanceOf', tokBalRaw)[0]);
  const tokAlw = BigInt(ti.decodeFunctionResult('allowance', tokAlwRaw)[0]);
  const actions = [];
  if (cur.wrap && tokBal < price) {
    // ETH → WETH for the shortfall (only WETH can be wrapped from native ETH).
    actions.push({ type: 'TRANSACTION', purpose: 'WRAP', to: cur.token, data: ti.encodeFunctionData('deposit', []), value: '0x' + (price - tokBal).toString(16) });
  }
  if (tokAlw < price) {
    actions.push({ type: 'TRANSACTION', purpose: 'APPROVAL', to: cur.token, data: ti.encodeFunctionData('approve', [CONDUIT, MAX_UINT256]), value: '0x0' });
  }
  actions.push({
    type: 'SIGNABLE', purpose: 'CREATE_OFFER',
    typedData: { types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...SEAPORT_TYPES }, domain: seaportDomain(), primaryType: 'OrderComponents', message },
  });

  const money = cur.code === 'eth'
    ? { priceEth: wei2eth(price), feeEth: wei2eth(feeTotal), netEth: wei2eth(price - feeTotal), wethShortfallWei: (tokBal < price ? (price - tokBal) : 0n).toString() }
    : { priceUsdc: unitsToAmt(price, 6), feeUsdc: unitsToAmt(feeTotal, 6), netUsdc: unitsToAmt(price - feeTotal, 6), usdcShortfallUnits: (tokBal < price ? (price - tokBal) : 0n).toString() };
  return { actions, orderParameters, orderHash, criteria: built.criteria, chainId: '0x1', currency: cur.code, ...money };
}

// Relay the signed offer to OpenSea. Scope-guarded (must be a WETH or USDC offer for a LAND
// criteria item) so our key can't be a generic relay; OpenSea re-verifies the signature too.
async function createOffer({ orderParameters, signature, criteria }) {
  if (!configured()) fail('not_configured', 503);
  if (!offerEnabled()) fail('disabled', 503);
  const offer = Array.isArray(orderParameters?.offer) ? orderParameters.offer : [];
  const consideration = Array.isArray(orderParameters?.consideration) ? orderParameters.consideration : [];
  const okOffer = offer.length === 1 && !!landCurrencyByOfferToken(offer[0]?.itemType, offer[0]?.token);
  const hasCriteria = consideration.some(c => Number(c?.itemType) === 4 && String(c?.token || '').toLowerCase() === LAND_CONTRACT);
  if (!okOffer || !hasCriteria) fail('bad_order', 400);

  const body = await osFetch('/offers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ criteria, protocol_data: { parameters: orderParameters, signature }, protocol_address: SEAPORT }),
  });
  const order = body.order || {};
  return { offerId: order.order_hash || null, status: order.order_hash ? 'created' : 'unknown' };
}

// One wallet's own active LAND listings (for "my listings" + cancel), from the collection
// feed filtered by offerer — no maker-scoped endpoint exists in the v2 API.
async function myListings(address) {
  if (!configured()) fail('not_configured', 503);
  const addr = String(address).toLowerCase();
  const raw = await scanRawListings();
  const items = raw.map(l => {
    const p = l.protocol_data?.parameters;
    if (!p || String(p.offerer || '').toLowerCase() !== addr) return null;
    const tokenId = p.offer?.[0]?.identifierOrCriteria;
    if (!tokenId) return null;
    const cur = landCurrencyBySymbol(l.price?.current?.currency) || LAND_CURRENCIES.eth;
    const amt = unitsToAmt(l.price?.current?.value || '0', cur.decimals);
    return {
      listingId: l.order_hash, // matches the Creature "mine" shape the client renders
      orderHash: l.order_hash,
      protocolAddress: l.protocol_address,
      tokenId: String(tokenId),
      currency: cur.code,
      priceAmt: amt,
      priceUsd: cur.code === 'usdc' ? amt : null, // ETH rows get their USD estimate client-side
      priceEth: cur.code === 'eth' ? amt : null,
      totalAmt: amt,
      name: `Highrise LAND #${tokenId}`,
      image: null,
    };
  }).filter(Boolean);
  await joinMeta(items);
  return { items };
}

// One wallet's own active collection offers (for "your offers" + cancel) — the active offer
// feed filtered by offerer. Mirrors myListings; reuses listCollectionOffers' shaping.
async function myOffers(address) {
  if (!configured()) fail('not_configured', 503);
  const addr = String(address).toLowerCase();
  const { offers } = await listCollectionOffers();
  return { offers: offers.filter(o => o.from === addr) };
}

// One wallet's LAND HISTORY: buys, sales and transfers. Source is OpenSea's account-scoped
// events feed, which carries NFT metadata inline (so no separate meta join). That feed spans
// EVERY collection the wallet has touched, so we page a bounded number of times and keep only
// LAND events — complete for typical LAND holders, recent-history for very active cross-
// collection traders. A marketplace sale emits BOTH a 'sale' and a paired 'transfer' (same tx
// hash); we keep the sale (it carries price + direction) and drop that transfer leg so the
// trade isn't shown twice. Read-only by address — the wallet signs nothing.
const HISTORY_PAGES_MAX = 6;
const HISTORY_ITEMS_MAX = 80;
async function myHistory(address) {
  if (!configured()) fail('not_configured', 503);
  const addr = String(address).toLowerCase();

  const events = [];
  let cursor = null, pages = 0;
  do {
    const qs = new URLSearchParams({ chain: 'ethereum', limit: '50' });
    qs.append('event_type', 'sale'); qs.append('event_type', 'transfer');
    if (cursor) qs.set('next', cursor);
    const body = await osFetch(`/events/accounts/${addr}?${qs.toString()}`);
    for (const e of (body.asset_events || [])) {
      if ((e.nft?.contract || '').toLowerCase() === LAND_CONTRACT) events.push(e);
    }
    cursor = body.next || null;
  } while (cursor && ++pages < HISTORY_PAGES_MAX);

  // Collect every sale's tx first, then categorize — so a sale's paired transfer (which may
  // sit on a later page) is reliably dropped regardless of fetch order.
  const saleTxs = new Set(events.filter(e => e.event_type === 'sale').map(e => e.transaction).filter(Boolean));
  const entries = [];
  for (const e of events) {
    const at = Number.isFinite(e.event_timestamp) ? new Date(e.event_timestamp * 1000).toISOString() : null;
    const tx = e.transaction || null;
    const tokenId = e.nft?.identifier;
    if (!tokenId) continue;
    const name = e.nft?.name || `Highrise LAND #${tokenId}`;
    const image = e.nft?.display_image_url || e.nft?.image_url || null;
    const coords = landCoords(name, null); // lets the client render the parcel's slime pet
    if (e.event_type === 'sale') {
      const isBuyer = String(e.buyer || '').toLowerCase() === addr;
      const pay = e.payment; // ETH or WETH, both 18-decimals
      const priceEth = pay && Number(pay.decimals) === 18 && pay.quantity ? wei2eth(pay.quantity) : null;
      entries.push({ kind: isBuyer ? 'bought' : 'sold', tokenId: String(tokenId), name, image, coords,
        priceEth, at, tx, with: ((isBuyer ? e.seller : e.buyer) || '').toLowerCase() || null });
    } else if (e.event_type === 'transfer') {
      if (tx && saleTxs.has(tx)) continue; // NFT leg of a sale — already shown as bought/sold
      const from = String(e.from_address || '').toLowerCase();
      const isReceiver = String(e.to_address || '').toLowerCase() === addr;
      const kind = from === ZERO_ADDR ? 'minted' : isReceiver ? 'received' : 'sent';
      entries.push({ kind, tokenId: String(tokenId), name, image, coords, priceEth: null, at, tx,
        with: kind === 'minted' ? null : ((isReceiver ? e.from_address : e.to_address) || '').toLowerCase() || null });
    }
  }
  const items = entries
    .filter(e => e.at)
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, HISTORY_ITEMS_MAX);
  return { items };
}

// Collection-wide LAND SALES: recent completed sales across the whole collection (not one
// wallet), for the marketplace's Sales History. Source is OpenSea's collection events feed,
// which carries NFT metadata inline. ETH/WETH-denominated sales only (both 18-decimals), so
// the price is comparable to the ETH listings the Buy tab shows. Read-only public data.
const COLL_SALES_PAGES_MAX = 6;         // the live window: the days since the last sweep
const COLL_SALES_ARCHIVE_PAGES = 200;   // runaway guard on the one-time sweep (~85 pages today)
const COLL_SALES_RETRY_MS = 10 * 60 * 1000;

// One OpenSea sale event → the row the Sales History speaks, or null if it isn't one we can
// price. A sale settled in something other than ETH/WETH/USDC has no comparable price here.
function shapeSaleEvent(e) {
  const tokenId = e.nft?.identifier;
  const pay = e.payment; // ETH/WETH (18-dec) or USDC (6-dec)
  const cur = landCurrencyBySymbol(pay?.symbol);
  const amt = pay && cur && pay.quantity ? unitsToAmt(pay.quantity, cur.decimals) : null;
  const at = Number.isFinite(e.event_timestamp) ? new Date(e.event_timestamp * 1000).toISOString() : null;
  if (!tokenId || !at || !Number.isFinite(amt) || amt <= 0) return null;
  const name = e.nft?.name || `Highrise LAND #${tokenId}`;
  return {
    tokenId: String(tokenId), currency: cur.code, priceAmt: amt,
    priceEth: cur.code === 'eth' ? amt : null, // USDC's ETH-equivalent added in shapeSalesHistory
    at,
    tx: e.transaction || null,
    buyer: String(e.buyer || '').toLowerCase() || null,
    seller: String(e.seller || '').toLowerCase() || null,
    name, image: e.nft?.display_image_url || e.nft?.image_url || null,
    coords: landCoords(name, null),
  };
}

// Page the collection's sale events, newest first, until the cursor runs out, `maxPages` is
// spent, or an event turns up at or before `until` — meaning we have reached ground already
// covered and the rest of the feed is behind us.
async function sweepCollectionSales(maxPages, until = 0) {
  const sales = [];
  let cursor = null, pages = 0, reached = false;
  do {
    const qs = new URLSearchParams({ event_type: 'sale', limit: '50' });
    if (cursor) qs.set('next', cursor);
    const body = await osFetch(`/events/collection/${LAND_SLUG}?${qs.toString()}`);
    for (const e of (body.asset_events || [])) {
      const ts = Number(e.event_timestamp) * 1000;
      if (Number.isFinite(ts) && ts <= until) { reached = true; continue; }
      const row = shapeSaleEvent(e);
      if (row) sales.push(row);
    }
    cursor = body.next || null;
  } while (cursor && !reached && ++pages < maxPages);
  return sales;
}

/* LAND's whole sale history, swept once and held for the life of the process.
   A closed day never changes, and OpenSea will page all the way back to the collection's
   first sale — some eighty pages and half a minute, which is not a thing to redo every few
   minutes. So: one deep sweep, then the live read covers only the days since. Same shape,
   and the same failure behaviour, as the Creature side's Immutable X archive.
   Without this the Sales tab showed six pages: three hundred sales, about seven weeks, on
   a collection that has been trading since 2022. */
const salesArchive = { data: null, inFlight: null, failedAt: 0 };

function getSalesArchive() {
  if (salesArchive.data) return Promise.resolve(salesArchive.data);
  if (salesArchive.inFlight) return salesArchive.inFlight;
  if (Date.now() - salesArchive.failedAt < COLL_SALES_RETRY_MS) return Promise.resolve([]);
  salesArchive.inFlight = sweepCollectionSales(COLL_SALES_ARCHIVE_PAGES)
    .then(sales => {
      sales.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
      salesArchive.data = sales;
      const oldest = sales.length ? sales[sales.length - 1].at.slice(0, 10) : '-';
      console.log(`OpenSea LAND sales archive: ${sales.length} sales back to ${oldest}`);
      return sales;
    })
    .catch(err => {
      // The live window still answers on its own, so the tab is short rather than empty.
      salesArchive.failedAt = Date.now();
      console.error('LAND sales archive sweep failed:', err.message);
      return [];
    })
    .finally(() => { salesArchive.inFlight = null; });
  return salesArchive.inFlight;
}

/** Warm the archive without making the first visitor wait on it. */
function warmSalesArchive() { return configured() ? getSalesArchive() : Promise.resolve([]); }

// Collection-wide LAND SALES: every completed sale across the collection (not one wallet),
// for the marketplace's Sales History. Source is OpenSea's collection events feed, which
// carries NFT metadata inline. Read-only public data.
async function collectionSales() {
  if (!configured()) fail('not_configured', 503);
  const archive = await getSalesArchive();
  // A second of overlap, then de-duplicate: OpenSea stamps events in whole seconds, and a
  // batch purchase puts several sales in one of them. Cutting on the timestamp alone would
  // quietly drop the ones that shared a second with the newest archived sale.
  const newest = archive.length ? Date.parse(archive[0].at) : 0;
  const recent = await sweepCollectionSales(COLL_SALES_PAGES_MAX, newest ? newest - 1000 : 0);
  const seen = new Set();
  const sales = [];
  for (const s of [...recent, ...archive]) {           // the live read wins any tie
    const key = `${s.tx || s.at}:${s.tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sales.push(s);
  }
  sales.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return sales;
}

// Unsigned on-chain Seaport cancel for ONE of the caller's own orders — a listing OR an
// offer (same mechanism). Found by hash in the listings feed, then the offers feed; the
// offerer must match the caller, and Seaport itself only lets the offerer cancel. On-chain
// (costs gas) so the order is truly dead — an off-chain hide leaves the sig fillable.
async function prepareCancel({ orderHash, maker }) {
  if (!configured()) fail('not_configured', 503);
  const addr = String(maker).toLowerCase();
  const hash = String(orderHash).toLowerCase();
  let found = (await scanRawListings()).find(l => String(l.order_hash).toLowerCase() === hash);
  if (!found) found = (await scanRawOffers()).find(o => String(o.order_hash).toLowerCase() === hash);
  if (!found) fail('not_found', 404);
  const p = found.protocol_data?.parameters;
  if (!p || String(p.offerer || '').toLowerCase() !== addr) fail('not_owner', 400);
  const orderComponents = {
    offerer: p.offerer, zone: p.zone, offer: p.offer, consideration: p.consideration,
    orderType: p.orderType, startTime: p.startTime, endTime: p.endTime,
    zoneHash: p.zoneHash, salt: p.salt, conduitKey: p.conduitKey,
    counter: p.counter != null ? p.counter : (await readCounter(p.offerer)).toString(),
  };
  let data;
  try {
    data = seaportIface().encodeFunctionData('cancel', [[orderComponents]]);
  } catch (err) {
    fail('unavailable', 503, `cancel encode failed: ${err.message}`);
  }
  return { transactions: [{ purpose: 'CANCEL', to: SEAPORT, data, value: '0x0' }], chainId: '0x1' };
}

module.exports = {
  configured, sellEnabled, offerEnabled, listListings, listCollectionOffers, getToken, ownedLand,
  prepareBuy, prepareAcceptOffer, prepareOffer, createOffer, allParcelCoords, prepareListing,
  createListing, myListings, myOffers, myHistory, collectionSales, warmSalesArchive,
  prepareCancel, LAND_CONTRACT,
  currency: landCurrency,
};
