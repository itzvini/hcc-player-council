# Highrise Creature Club

The official Highrise Creature Club member site — a single hub for the community: the club
overview, live market data, in-wallet trading, holder stats, the roadmap, and the holder-led
Player Council and its election. Static front-end (vanilla HTML/CSS/ES modules, no build
step) packaged with a tiny Node server for Railway.

## Local Run

```bash
npm start
```

Then open `http://localhost:3000`.

For local dev with live market data, put your key in `.env` and run `npm run dev`:

```
OPENSEA_API_KEY=your_key_here
SQUID_INTEGRATOR_ID=your_squid_integrator_id
TRANSAK_API_KEY=your_transak_publishable_key
```

`SQUID_INTEGRATOR_ID` (optional) powers the Trade tab's one-tap, exact-amount ETH
bridge quotes (Ethereum → Immutable zkEVM) via the [Squid Router API](https://docs.squidrouter.com).
Get one free from Squid's integrator portal. Without it, the funds helper falls back
to a prefilled Squid deep-link — everything else works unchanged. Like all secrets it
lives only in `.env` locally and in Railway **Variables** in production.

The "Buy with card" on-ramp (card / Apple Pay / Google Pay) mints a **session URL server-side**
at `/api/market/onramp` — Transak deprecated query-param widget URLs in mid-2026, so the widget
loads only with a session minted via a backend call. We mint through **Immutable's hosted
checkout** (`api.immutable.com/checkout/v1/widget-url`, the same call Immutable's toolkit on-ramp
makes), which rides **Immutable's own Transak account** (public key fetched from
`checkout-api.immutable.com/v1/config`) — so it needs **no Transak credentials of ours**. The URL
is single-use, expires in ~5 min, minted **on click**, with the **network + token pinned** and the
buy **amount prefilled** in USD (grossed up for Transak's ~3.5–5.5% fee). Routing reflects what
each network can actually deliver:

- **Gas (IMX)** → network `immutablezkevm`, delivered **natively to Immutable zkEVM**.
- **Price (ETH)** → network `ethereum`, delivered to **Ethereum**. Transak has **no fiat→zkEVM-ETH
  product** (a live $20 test order delivered ETH to L1), so for **Creatures** the buyer then
  **bridges** the ETH to zkEVM via the in-panel bridge (the prefill includes a bridge/L1-gas
  buffer); **LAND** is bought directly on Ethereum, no bridge.

If a mint fails, the client falls back: zkEVM/IMX → Immutable's keyless hosted page
([toolkit.immutable.com/onramp](https://toolkit.immutable.com/onramp/)); Ethereum/ETH → CTA hidden.

> **Note:** the `TRANSAK_*` env vars and the `transak*` helpers in `server.js` are an inactive
> alternate path (minting through *our own* Transak partner account instead of Immutable's). It's
> not used — our account's session API returns `401 errorCode 1002` pending Transak's activation /
> backend-IP allowlisting (on Railway that needs a static egress IP). Kept for if we later want our
> own account for fee capture; ignore for normal operation.

Without key+secret, the **LAND** card CTA is hidden and **Creatures** fall back to Immutable's
keyless hosted on-ramp ([toolkit.immutable.com/onramp](https://toolkit.immutable.com/onramp/)) —
which can't pin the network, so the buyer must pick Immutable zkEVM themselves.

## Site search

One box over the whole site. It has two front doors, and they run the same matcher, so
they can never disagree about what a query finds:

| Where | How you open it |
| --- | --- |
| The nav magnifier, on every page | click it, press `/`, or `Ctrl`/`Cmd` + `K` |
| The archive's own box, above the Collections sub-nav | it is always on screen there |

Every result is a **link to a real address**, never a filter. The two boxes inside the
Collections grids narrow what you are already looking at; this one takes you somewhere.
Six kinds are searched at once:

| Kind | Where the data comes from |
| --- | --- |
| Pages | `/api/search/pages` — see below |
| Creature, by the number people actually say | the trait catalogue's total, so `/collections/creature/777` is only offered if 777 exists |
| Glossary terms | `js/glossary.js` |
| Traits | `/api/market/creatures/traits`, the catalogue the trait pages already fetch |
| Items and releases | `collections.json`, the archive the timeline already holds |

A bare number is offered as a Creature first, because it is an exact answer. Pages come
next: there are only four dozen of them, and a common word (`perks`, `cash out`, `polls`) almost
always means one, where the archive groups run to thousands of rows and are reached by a
distinctive name. A page matches on its name outright, and on its summary or its address
as a weaker match ranked below every name hit, because four dozen terse titles do not cover the
words a member reaches for — `fee` is in no page title and in two summaries.

**The page index is generated, not hand-kept.** `GET /api/search/pages` is built from
`SECTION_CARDS` in `server.js`, the same table that already feeds the share cards and the
sitemap. Adding a page there makes it findable the same day, with no second list to fall
out of step. The rows travel as *unresolved* en.json keys, so the client fills them from
its own translations and results come out in the reader's language; the handful of routes
carrying literal copy stay English, exactly as their share cards do. Two exclusions, the
same ones the sitemap makes: a canonical alias is another name for a route already listed,
and a holder's profile is theirs to share, not ours to index.

**What it costs.** Nothing until someone types. `js/search.js` is wired at boot because it
has to answer a keystroke on a page nobody has clicked into, but it fetches nothing then:
the page index is a few KB on the first query, and `js/codex.js` plus the 180KB archive are
imported only when a query needs them. Failing to load the archive narrows the results to
pages; it never takes the box down.

**Navigation.** A row is a real `<a href>`, so a middle or modified click opens a new tab
and a crawler sees an address. A plain click is cancelled and routed in place by the box
that rendered it — not by the central handler in `js/app.js`, which only catches three path
prefixes, where a result can be any address on the site. That handler stands down on
`event.defaultPrevented` so a result never lands two entries in the history.

## Gen 2 roadmap (two boards)

The Roadmap tab holds three sub-tabs: **Milestones** (`/roadmap`), the hand-maintained
milestone track; **Gen 2 Pets** (`/roadmap/pets`); and **Gen 2 Creatures** (`/roadmap/gen2`).
The two Gen 2 boards are the public face of the bi-weekly Discord progress update.

Each board is driven by one JSON file at the repo root, and that file is the only thing you
edit when an update goes out:

| Board | Data file | Road element |
|---|---|---|
| Gen 2 Pets | `gen2-pets-progress.json` | `#g2p-road` |
| Gen 2 Creatures | `gen2-progress.json` | `#g2-road` |

Both are rendered by the same code ([js/gen2.js](js/gen2.js)); the `BOARDS` array at the top of
that file maps each data file to its DOM ids, its i18n prefix, and the icon plus accent colour
for every set. Adding a set means adding it to `BOARDS[n].sets`, to the JSON, and adding a
`<prefix>.set.<id>.h` key to [locales/en.json](locales/en.json).

Per set in the JSON:

- `done` — how many stages are fully finished. Pets run **1 Direction, 2 Concepts, 3 Feedback,
  4 Final art, 5 In game**; creatures run **1 Direction, 2 Concepts, 3 Sketches, 4 Final art,
  5 In game**. The stop cards only list stages 1 to 4; `done: 5` flips the whole stop to
  "Complete".
- `active: true` — being worked on right now, which lights the stop and shows stage `done + 1`
  as in progress. More than one set can be active.
- `status: "next"` — an "Up next" chip on a set nobody is working on yet.
- `note` — shown verbatim on the card.

And per file: `updated` (the announcement date), plus `focus` on the **creature** file only, the
"next two weeks" card under its pipeline. The pets board has no focus card and no
"what's slowing this down" card; both were built and then cut on the owner's call, so its per-set
`note` fields are the only place it states where the work is. Don't add a `focus` or `blocker`
field to `gen2-pets-progress.json`. Any field can carry per-language overrides the same way
`changelog.json` entries do: `"i18n": { "pt": { "note": "…" } }`.

The array order in the JSON is the order the road is drawn in.

The static markup in [index.html](index.html) is a **fallback**, not decoration: if the fetch
fails the page still shows a truthful board, so keep it in step with the JSON when the state
changes materially. Both files are served straight from the root, so each is in `PUBLIC_FILES`
in [server.js](server.js).

Editorial rules for these pages live in the project brain (`60 Decisions/Roadmap Editorial
Rules`): no internal dates, no resourcing, no scope debates, and nothing about how Gen 2 gets
delivered or monetised.

## Collections (the release archive)

The Collections tab holds two views, as sub-tabs: **Releases** (`/collections`), the club's
back catalogue, and **Creature Traits** (`/collections/traits`), every trait the Creatures
themselves are built from. The archive answers "what did the club put out"; the trait view
answers "what are the Creatures made of". They share their stat band, chips and search box
so the tab reads as one page.

The **Releases** view (`/collections`) is the club's full back catalogue: 131 releases
and 1,470 items, oldest to newest, on a year-by-year timeline. Each release card opens
into a grid of its items with their in-game art, rarity and copy counts. You can filter
by type (drops, grabs, Creature Store, events, giveaways, collabs), search across item and
release names, and flip the order.

A release lists its items **rarest first**, then by slot, then by name. Rarity leads
because that is what anyone reading a release card is looking for: the mythical piece, not
the fourth colourway of a tee. Slot next, so a rarity band still reads like with like, and
the name last, so colourways stay in a predictable run.

A collapsed card carries a preview strip of the release's first seven items that have a
picture, so the strip and the grid tell the same story, with a `+N` chip for the rest. The
build holds them as row indices (`hero` in the JSON), and cuts each one a small thumbnail
of its own (see below). Skipping the pictureless items matters: a strip of placeholders
reads as a broken card rather than a thin archive, and where a release has no pictures at
all the strip drops out and the card leads with its note instead.

Clicking any item (in the grid or on a card's preview strip) opens it in a floating
inspect card: the item blown up, its rarity, slot, copy count and release, and the whole
avatar render for context. Arrow keys walk the rest of the release, Escape closes.

Two things feed it, and only one of them is in the repo:

- `collections.json` (~184 KB) — the release and item data, served static
- the `collection_art` table in Postgres — every item's picture, 2,072 rows, 31.8 MB
  (the trait showcase keeps its tiles in a `trait_art` table beside it, for the reason
  spelled out under Creature Traits below)

**No item art is committed.** The repo used to carry 561 files and 6.9 MB under
`img/collections/`; those bytes now live in the database and reach the browser through
`/api/collections/art/<variant>/<art_id>.webp`. That also closed the last id leak: an
`art_id` is a hash of the picture's own bytes, so nothing in the repo or on the page names
a Highrise item. See "About the item art" below for what this costs and what it buys.

Everything that makes those two lives in `tools/`, which is **gitignored**: the build
script, the workbook-derived maps, the asset-portal art, and the render cache. None of it
is needed to run or deploy the site.

Keep a copy of `tools/` wherever you build from. To regenerate:

```bash
pip install openpyxl pillow numpy psycopg2-binary
python tools/build-collections.py path/to/hcc_items_release_matching.xlsx
```

That reads a database URL from `COLLECTIONS_DATABASE_URL`, `DATABASE_PUBLIC_URL` or
`DATABASE_URL` (environment first, then the gitignored `.env`) and loads the pictures
straight in. Rerun it when new releases ship, then commit the regenerated JSON.
`--skip-art` builds the JSON alone and touches no database, which leaves every item
showing a placeholder. `--refresh-art` re-encodes and reloads everything.

**A release the workbook has never heard of** — anything that shipped after the last hand
export — goes in `EXTRA_RELEASES` as a `catalogue_items()` block, straight off the item
catalogue: `(disp_id, name, category, rarity[, window])`. The window is `[x0, y0, x1, y1,
W, H]` and the client reads it as fractions of the frame `W x H`, so it must be measured
against **that item's own render**, whatever size it arrives at — the asset portal trims
each render to its item, and a face item comes back on a whole mannequin about 276x783
where the archive's 600x800 `HEAD_WINDOW` fractions would cut through the face.

**When an item has no picture at all**, the CDN says so by answering HTTP 200 with one
shared bare mannequin (`BLANK_RENDER`). That is worse than a 404: it looks like a picture,
and two such items then quietly share one, below the three-or-more check that catches this
in bulk. The build hashes every render against it, treats a match as no picture, names the
items in its output, and drops them from the strip on the collapsed card — which is chosen
before any picture is fetched, on the assumption that a worn slot always has a render.

The picture of last resort is then the archetype's own **`thumbnail_url` / `image_url`**, a
CloudFront webp the artist uploaded by hand. The catalogue's list call doesn't return either
field; the full record does. Save the 800px one into `tools/item-art/<disp_id>.webp` and it
wins over everything. Ghost Town's two Haunted Caps are the worked example — and since the
full record also carries `release_date`, that release is dated exactly rather than from its
median asset time. Check that date before trusting it: this catalogue's `release_date` is
sometimes a century out.

**Rows the archive leaves out.** Two separate filters.

The build drops 54 catalogue rows that aren't really separate items to browse: `hair_back`
entries (30, each rendering identically to its `hair_front` twin), pet body parts (18 — a
pet species' own ears, eyes, tail and wings, spotted by the doubled `pet_pet` marker in the
disp_id, so pet *clothing* in the same slot is kept), unnamed entries whose name is nothing
but dashes, `Fake Inverted Fangs`, and one spare archetype: a second Year One White Tee
that nobody was ever given, which read on the card as the same shirt listed twice.
Spares go in `DROP_ITEMS` one id at a time rather than by a "zero copies" rule, because 136
rows read as zero copies and nearly all of them are real items whose count the stats pull
missed.

It also drops content that isn't the club's, on holder feedback. The workbook flags an
item HCC when Tom authored it, which is not the same as club-exclusive, and eight releases
were ordinary public ones: Ectoplasm Collection, Whispering Spirits Chase, Moonlight
Phantoms Chase, Halloween Wolf Grab, Tom's Mouth, and the Clown, Hellhound and Kitsune
Spell grabs. The last three cost ectoplasm rather than Creature Coins, which holders
checked in game; the catalogue tags ectoplasm items HCC anyway, and that indexing bug is
what put them here. See `DROP_RELEASES` in the build for the list.

Earth Day Drop was nearly cut down the same way and then kept whole. The first read was
that its high-copy items were a public tip-war payout; a correction came back saying the
tip-war pieces were in fact the one-of-a-kind and three-made ones, and that keeping them on
the page was fine. So all 88 items stay and the card carries a note instead.

Release item counts, rarity mixes and copy totals are all summed over what survives, so the
numbers on a card match what it lists. Note they are copies *minted*, not sold: a giveaway
of 3,000 and a store sale of 3,000 look identical here.

**About the item art.** Every picture is served by us, out of `collection_art`, at
`/api/collections/art/<variant>/<art_id>.webp`. Two variants share one id:

- **`full`** is the whole render at its native size, usually 600x800. The item grid crops
  it to the item with a CSS window; the inspect card shows it both ways.
- **`thumb`** is a 104px square, cropped to the item when it was encoded, for the 52px
  boxes in a collapsed card's strip. 564 items need one, the ones a strip can show.

**Items the avatar render can't show.** Most pictures are the CDN's 600x800 worn render, but
some items don't appear on a mannequin at all: furniture and room floors have no render, and
a few worn items (the Creature Gold Bars, for one) render as a bare body. The fix in every
case is to stage the item's own picture as `tools/item-art/<disp_id>.png|.webp`, which the
build prefers over any render and leaves uncropped.

Finding that picture is the hard part. The asset portal has a route for each kind, and neither
is discoverable from an archetype record — its `image_url` and `thumbnail_url` fields are empty
for every item that needs one, so go by the route, not the field:

- **Furniture, room floors and decals**: `furnitureitem/<state>/<disp_id>.png`. 256x256,
  transparent, the piece on its own. `<state>` is the rotation, `0` upward; a four-state piece
  answers on 0 to 3, and state `0` has been the right view every time. Square and already
  framed, so it needs no crop window and fills the tile.
- **A worn item that renders as a bare body**: `avataritem/front/<disp_id>.png`, which draws it
  properly where the public CDN render returns an empty mannequin. This one arrives *on* a full
  mannequin, so crop it to the item's own bounding box and cap the long side at 400px before
  staging — the build gives staged art no crop window, so an uncropped beret lands as a speck.
  Keep the body pixels inside the box rather than colour-keying the mannequin out: the
  mannequin's anti-aliased ramp is over 1,300 colours wide, and keying punches holes straight
  through anything peach or pink.
- **Pets** have to be composed from part `.zip`s. See "Composing the pets".

Both portal routes need the session cookie, which is why their output is staged in `tools/`
rather than fetched at build time. A handful of archetypes do carry `image_url` (1024px) and
`thumbnail_url` (512px) outright — that is where the Creature Gold Bars' art came from — but
it's the exception, so don't plan around it.

The build warns when one `art_id` serves three or more differently-named items, which is how
a bare-mannequin render gives itself away. Two items sharing a picture is routine and
honest: a coat and its `- Double` variant really do look identical worn.

`art_id` is a SHA-1 of the source bytes, first 16 hex. Content-addressed does three jobs:
the URL names nothing, two items with identical art share a row, and because the bytes
behind an id can never change the serve route sends `immutable` with a year of
`max-age`. That is the one exception to the caching policy in
[.claude/CLAUDE.md](.claude/CLAUDE.md), and it is safe for exactly the reason the policy
forbids it elsewhere: these URLs really are fingerprinted.

**Why WebP at native size.** The Highrise CDN only serves PNG, averaging 93 KB. Re-encoded
at quality 88 the same 600x800 render is **21 KB**, so shrinking it buys almost nothing
(512px only saves another 2.5 KB) and full detail is kept for the inspect card. Thumbnails
are quality 82 and average 3.2 KB.

What that adds up to, measured in a browser against the same pages:

| | before, off the Highrise CDN | now, from Postgres |
|---|---|---|
| glance at the page | 4.73 MB | **192 KB** |
| scroll all 102 cards | 44.3 MB | **1.45 MB** |
| open a 56-item grab | 5.07 MB | **1.15 MB** |
| repeat visit | revalidates every picture | **0 bytes**, straight from cache |

All of it verified in a browser against the real database, including the last row: on a
revisit or a reload every picture comes back with `transferSize: 0`.

**Latency, not just bytes.** The one thing this design gives up is edge delivery: a first
visitor now waits on our origin instead of a CDN. `getCollectionArt()` keeps what it has
read in a bounded in-process cache (48 MB, comfortably the whole table), which is safe
precisely because an id names fixed bytes. Measured on a 56-item grid, 42 tiles in view:
cold, 8s to fill; with the pictures already in the server's memory, under 1s. Locally the
cold figure is inflated because every read crosses the public proxy to Railway; in
production the app and Postgres share the private network. If first-paint latency ever
matters more than this, a CDN in front of the domain is the fix, not a change here.

So the tab is lighter than it ever was on the CDN, grids included. Two trades. Those bytes
are now our egress rather than Highrise's. And **Collections needs Postgres**: with no
database the timeline, stats, search and filters all still work off the JSON, but every
tile shows its placeholder and the browser logs a 404 per picture.

**Where the pictures come from.** The build encodes one source per item, in this order:

- `tools/item-art/<disp_id>.png`/`.webp` when present, used uncropped and ahead of
  everything else. 111 files: 44 avatar items from the portal's `avataritem/front/`, 42
  furniture pieces and decals from its `furnitureitem/0/`, 6 sets, 2 containers, 2 gold bars,
  and 15 pet and emote composites. The portal ones need the session cookie the HighriseHelper
  bot keeps in its `prod_api_settings` table, which is why they sit in `tools/` rather than
  being fetched at build time. `--extra-images DIR` points elsewhere.
- the workbook preview, which **nothing now uses as a picture** — every unworn item has real
  portal art instead. Previews are still read, but only to measure crop windows.
- otherwise `cdn.highrisegame.com/avatar/<disp_id>.png`, fetched once per item and kept in
  `tools/render-cache/` so later rebuilds ask for nothing. One request each, no retries; a
  failure becomes a warning and that item shows a placeholder until the build is rerun.
  Reruns are cheap because the cache holds everything already fetched.

**Crop windows.** 1,153 of the items carry a crop window (`b` in the JSON) framing just
the item, so the grid can zoom past the mannequin; the inspect card still shows the whole
render below it. `zoomStyle()` reads a window as fractions of its frame and scales one
axis only, leaving the other `auto`, so the image keeps its own aspect and no render can
come out stretched however large it arrives.

A window still only means something in the frame it was measured in, and 14 of the
renders Highrise serves come back trimmed instead of 600x800 — some to the item alone, one
to the avatar (298x783). Each is trimmed differently, so there is nothing to map.
`checkFrame()` compares the loaded shape against the frame the window names and, if they
disagree, drops the zoom and shows the picture whole. That guard now only matters for the
grid and the inspect card: strip thumbnails are cropped when they are encoded, against the
real pixels, so the one trimmed render that used to show a small avatar in the strip is a
proper close-up.

Most come from differencing a render against its category's median render, measured on the
workbook preview. That only works where the preview shares the render's 3:4 shape — the
workbook trimmed about 100 of them to odd shapes (32x90, 90x90, ...), and a window measured
on one of those maps nowhere on the render and stretches it badly. Those are skipped.

Face, neck, hat and hair windows are fixed fractions rather than measured, so they are
stated against the 600x800 render directly and keep working for the odd-shaped ones. The
head window itself is measured: across face-slot renders the head sits at x 17-48, y 1-36
of a 67x90 frame, padded out to a square. It has to reach the very top — starting even 2%
down clips the crown, which reads as the head being squashed vertically.

The only items with no window are the three whose bundled art is already the item alone.

**Releases the workbook doesn't have.** The workbook only exports items already matched
to a release, so a club item it never matched simply isn't there. `EXTRA_RELEASES` in the
build declares those by hand. Two so far, the Krampus Snugglin eggs: **Krampi** (Creature
Store, 50,000 Creature Coins) and **Krambi** (member giveaway). The catalogue marks both
"Creature Club Exclusive Item", which is what settled that they belong here.

Their dates come from the first four bytes of each archetype's ObjectId, which is its mint
time, so they carry `approx` precision for the same reason the workbook's median dates do:
that is when the item was made, not necessarily the day it went out. Art is staged in
`tools/item-art/` under the egg's `disp_id` like any other replacement picture, pulled from
`cdn.highrisegame.com/container/<disp_id>/full` — a different path from the `/avatar/` one
worn items use, and the only place these eggs have a picture. A missing staged file is
reported as a warning rather than shipping a placeholder silently.

The eggs sit in a `container` category, which is in `NOT_WORN_SLOTS` (and `NOT_WORN` on the
client) so nothing tries to find an avatar render for them, and reads as "Egg" on the card.
Each release also lists the snugglin the egg hatches, in a `pet` category (also not-worn,
reads as "Snugglin"), first in the list so it takes the hero thumbnail.

**The pet giveaways.** The club handed members a one-off pet eleven times between July 2023
and February 2026 — three slimes on `pet_slime_legendary`, two more on `pet_slime`, and six
bunnies on `pet_bunny_mythical`. None of them has a catalogue release row, so each is an
`EXTRA_RELEASES` entry built by the `pet_giveaway()` helper: one `pet` item and the rarity
from its archetype. Dates are read off the giveaway bot's own posts, so they are `exact`
rather than `approx` and every one wears the Announced badge. No note either — the card's
picture says what the creature is better than a sentence would.

Finding a pet's parts takes one look at the admin panel and no API access. Its character
page lists the traits, and one trait id gives away the whole set, because the family shares
a naming pattern: `body-pet_petbunny2024<slot><suffix>` for the bunnies,
`body-pet_<slot><datecode>` for the slimes. The rest come from probing that pattern against
the public CDN, where a wrong guess just 404s. The slot vocabulary across every pet here is
`body ears eyes mouth nose blush tail wings hat freckle` for bunnies and
`base eye mouth antenna` for slimes. Two of them hide something: a third eye ships as
`freckle`, and a unicorn horn ships as `antenna`.

**Composing the pets.** No pet has a picture anywhere upstream: the archetype rows carry no
`image_url`, `thumbnail_url` or `icon_url`, and no render endpoint applies a pet's own skin
— ask one for a snugglin and you get a peach avatar. So they are composed from their own
part assets, the same way the game does it and the same algorithm
[lib/land-pets.js](lib/land-pets.js) already uses for LAND's slimes:

1. Each part is a zip on the public avatar CDN, `/avatar/<item_id>.zip`. Inside, every
   `front-<item_id>-<Layer>.vec` entry is a plain SVG carrying its own bounds in a leading
   fixed-width comment.
2. Stack the layers in rig order and union the bounds. Order is keyed on the layer name
   (the rig slot: `Head`, `CoreBody`, `EarLeft`, `Tail`, `HatUpper`, …), not on the item id
   — a pet part fills several slots at once, unlike a slime part, which is why
   `lib/land-pets.js` can get away with keying off the id and this can't. Four rigs, four
   orders:
   * **plushie** (snugglins) — `CoreBody` sits *above* the torso: it is where the HCC badge
     and the keepsake pin go.
   * **bunny** — far-side limbs behind the body, near-side in front. The art says which is
     which, since every `Right*` layer is shaded darker than its `Left*` twin. Headwear
     (`HatUpper` / `BagUpper`) is a left-right pair on top of the head, not a front-back one.
   * **slime** — body, face, then whatever sits on top.
   * **bat** (Creature the Vampkin) — wings, ears, body, legs, head, eyes. The head plate
     overlaps both the ear bases and the top of the torso, so those go behind it, and the
     darker twin of each pair is the far side. Its mouth part is `batmouthempty`, which draws
     nothing at all, so a rig can legitimately come up a layer short.
3. Skip the alternate animation frames shipped alongside the idle ones (`*Closed` blink
   frames, `HappyMouth`, `SadMouth`).
4. Recolour when Active Palette isn't 0. Every bunny and slime here reports 0 in the admin
   panel, so for those the palette baked into the art *is* the final look and nothing is
   remapped. Two exceptions, and they are exceptions of different kinds.

   **Creature the Vampkin is the easy kind, because the palette is published.** It wears
   palettes 1 and 15, and its trait archetypes carry a `color_palettes` array, so Active
   Palette *N* is just an index into it. Both 1 and 15 resolve to the same mint ramp, and
   palette 0 is the purple ramp the art ships in, so the recolour is an exact five-colour
   substitution. **Do it on the SVG, not on a raster.** In vector form the only fills present
   are the flat palette colours, so the ramp maps and the navy, outline and eye white are left
   alone. The portal's flat `avataritem/front/<trait>.png` renders tempt you here and are a
   trap twice over: each frames its own part independently so they cannot be stacked, and their
   mid tones are ramp-over-navy blends that no colour lookup handles cleanly.

   **The snugglins are the hard kind:** their art ships peach-furred with blue eyes and no
   palette source available here covers what a real one applies, so all three ramps are
   reconstructed. Three source ramps map to three targets:
   * **fur** (the peach ramp's light and mid tones) → near-black, per both eggs.
   * **accent** (the same ramp's dark browns) → crimson for Krampi, pink for Krambi. These
     are not fur: they are the horns, hooves, tongue, blush rings and eye rims, which the
     reference art the community circulated shows in the pet's accent colour. Anchored on
     each pet's own baked trio — the keepsake and teddy already bake `5E1123`/`7A233A`/
     `C13A5E` and `E35D93`/`E679A5`/`F299C2`.
   * **eye/halo** → the two colours the pet's own colorpatch bakes, plus a near-white tip.

   Splitting fur from accent matters twice over. Mapping one ramp across both zones turned
   the horns and tongue black, and it stretched the range so the body's dominant `B56551`
   landed mid-ramp and came out charcoal instead of black. `9E4733` is the one hex that
   straddles them; it stays with the fur, because it shades the ear insides and tail tip
   where the difference shows, and a dark rim reads the same as a black one on black fur.

So every pet here is exact official art except the snugglins' three reconstructed ramps.
Nothing carries a crop window: the card shows each pet whole.

Pets are staged under **our own key** (`hcc-<slug>`), not a Highrise id, because nothing
upstream looks them up. The key and the staged filename have to match exactly.

Bluluvey is the one pet that skips all of this: it ships as a single flat SVG under
[assets/pets/](assets/pets/) rather than as separate parts, so it is rasterised as-is.

**Release notes.** `RELEASE_NOTES` in the build attaches a short editorial note to a
release, rendered as a framed aside under the card's quote (`.col-annot`). It exists for
context the catalogue cannot carry: Earth Day Drop's rarest pieces came out of a charity
tip war rather than a club release, which no column in the workbook records. The label is
`t('col.annot')`, just "Note" — a note carries no byline, so nobody is on the hook for an
editorial call. The text itself is not translated, same as `quote`, since both are specific
to one release.

Mind the class name: `.col-note` was already taken by the approx-date fineprint, and reusing
it wrapped that in a border and a background on all 49 approx-dated cards. Hence `.col-annot`.

**Sets.** `tools/item-sets.json` maps a set's `disp_id` to the `disp_id`s it contains,
and that membership overrides the workbook's `release_name`. It has to: the Year Four
recolours were all filed under the Whiteout release even though each colourway shipped as
its own set, so without it the pink, blue and red items sat in the wrong place. Rebuilding
regroups 38 rows. Set art comes from the set record's `image_url` on CloudFront and lives
in `tools/item-art/` with the rest. Override with `--item-sets FILE`.

To refresh it after a new set ships, ask the asset portal for
`{"_type": "GetItemRequest", "disp_id": "<set disp_id>"}` and read `clothing[].item_id`
and `image_url` off the reply. Like the rest of `tools/`, the file is local only.

**What the JSON deliberately leaves out.** The inspect card used to carry a "View on
Highrise" link, which meant shipping every item's Highrise catalogue id: over 1,200 internal
ids in a public repo, as a bulk machine-readable index. Both the link and the ids are gone,
which took the JSON from 227 KB to 189 KB.

`disp_id` (`d`) is still there, because it is the only way to name an item's picture:
`cdn.highrisegame.com/avatar/<disp_id>.png` for the grid and inspect card, and the
thumbnail filenames. Removing it would mean serving every render from here instead, which
is 15 MB or more of committed art, or proxying the CDN through the server. Note the id is
already visible in each of those image URLs either way.

**About the dates.** Only 20 releases carry a posted release date, and the announcements
channel doesn't go back past March 2023. The build fills the gaps from the club's gift log
(a real dated distribution event) and, failing that, from when the items were authored.
Worked-out dates render as a month with a `~` marker and say so on the card, so the
timeline never shows a guessed date as a known one. The build also reports anything
suspicious — re-gifts of older sets, and releases whose date disagrees with the year in
their own name — so you can check those against the announcements.

## Creature Traits (the trait showcase)

`/collections/traits` lists all **466 traits across 13 slots** that the 11,111 Creatures are
assembled from — every Eyes, Hair, Outfit and Aura — as a grid of tiles grouped by slot,
rarest first. Each tile shows how many Creatures wear the trait, its share of the
collection, a log-scaled scarcity bar against the rest of its slot, and an "on sale" pill
when any wearer is listed. Filter to one slot, search, sort (rarest, most common, A-Z, most
on sale) or show only what's for sale.

Opening a trait gives you its numbers, the last four sales of a Creature wearing it, and two
ways into the marketplace with the filter already applied — the listed ones, or every
Creature that has it. Arrow keys walk the slot, Escape closes.

**Everything comes from `/api/market/creatures/traits`**, which is built from the two
in-memory indexes Browse already keeps (the daily full-collection sweep and the 60s listings
snapshot), so the endpoint costs no upstream calls and nothing about the trait list is
hand-maintained. Gen 2's traits will appear here the day that collection is indexed.

### Outfits, broken into the items they're made of

An **Outfit** trait names a whole look rather than one item, and until you know the pieces the tile
is a crop of a Creature with no explanation. The composition turns out to be **in the item ids**:
every 2021 garment is `<category>-n_hrcc2021<word><NNN>[variM]`, and one outfit is one
`(NNN, variM)` across the clothing categories. So `Super Belted Trench Dress Outfit` is
`012vari3` — a Red Belted Trench Dress, Red Button Buckle Clogs, Knee High Layered Fishnet Socks
and Black with Red Bow Undies.

**12 look numbers × 4 variants = 48**, plus **10 named-character looks** (Calcifer, Lilith,
Squatch…) whose items carry the character's name instead of a number. 48 + 10 = 58, exactly the
Outfit trait's value count, which is what proves the scheme is complete.

The one thing the ids don't say is which of a look's four names is which variant. The tier word
(`Simple` / none / `Colorful` / `Super` / `Legendary`) runs plainest-to-rarest with the absent
label left out, so it **shifts a place** between the ten looks that have a `Simple` and the two
that end on `Legendary` — `Super` is vari4 on one family and vari3 on the other. That got settled
against the art: each outfit's representative Creature, torso-cropped, matched to each candidate
variant's own render, all four assigned at once so the answer has to be a permutation. All 48
pairs were then checked by eye against `tools/outfit-proof.png`.

```bash
python tools/build-outfits.py          # after fetch-panel-items.py + fetch-panel-art.py
```

Writes `tools/outfit-items.json` (with Highrise ids, local only) and the tracked
**`creature-outfits.json`** — item name, category, rarity and the slug its tile is baked under,
and **no ids**. The server reads that at boot, hands the pieces to the Outfit tiles, and
synthesises a slot per garment category (Tops, Bottoms, Shoes, Socks, Skirts, Full body) so each
of the 186 garments also gets a tile of its own. Those slots sit behind their own chips rather than
in "every slot": a look and its four garments shown together would say the same thing twice, and
the count of real traits would stop meaning anything. A piece's numbers are its outfit's, which is
exact — an item belongs to one look, so the Creatures wearing that look are the ones wearing the
item — and its marketplace link filters on the outfit, since no trait exists for a single garment.

**The ten 1/1 characters bring 73 more pieces the collection's metadata never recorded.** Their
tokens carry **three** attributes — Body, Outfit, Rarity — where an ordinary Creature carries
fourteen (verified on #3295 "Zedd" and #4191 "Calcifer"). Their eyes, mouth, nose, brows, hair,
horns and aura were drawn as real Highrise items and then never written into the metadata, which is
why the Eyes slot has no 1/1 trait value in it and can't have one. Fixing that is upstream work:
Highrise would have to write the missing attributes into those ten tokens.

Until then the site puts each part **in the slot it would be a trait of** — `PIECE_MERGE` in
`server.js`: eyes into Eyes, hat into Head accessory, and so on — so the ten rarest Creatures turn
up where someone browsing eyes would look for them. Eyebrows and Handbag get slots of their own,
since the collection has no trait for either. Each such tile is **badged "1/1 part"**, its card
says which look it came out of, and its marketplace link filters on **that look**, because there is
still no trait to filter on. The slot's chip counts what it shows (Eyes 72); the stat tile keeps
counting traits only (466), and `count` / `parts` on the payload keep the two apart.

Their renders are worn mannequins like the trait items, so they crop to `PIECE_WINDOW` by category
rather than to their alpha bounds. **Every tile keeps the item's own colours**, the same as the rest
of the showcase.

> **Tried and dropped: tinting a 1/1's parts to its character's colour.** The parts are drawn on the
> default beige mannequin, so Dimitri's face parts don't match his purple portrait. Recolouring the
> mannequin's skin to a colour sampled off the character's art worked on paper and looked wrong in
> practice, so it was removed on 2026-08-05. What it cost, in case anyone tries again: the skin
> palette has to be *derived* (a flat fill covering a chunk of the head window in most of the 73
> renders is body, not item — `#f4d5bf` and `#e6bba8`, in 59 and 53 of them); the target has to come
> off two cheek patches of the art, because the painted background turns Zedd the green zombie
> purple and the Body trait's name says "Moonlit Purple" where the visible face is white fur; and
> recolouring exact matches alone leaves a pale anti-aliased rim that reads as a glowing outline on
> a dark character, while a plain colour tolerance eats art instead (Dimitri's ear lining ramps from
> 4 to 160 units off skin, so any single cut tints one ear and not the other). Requiring *both* near
> a palette colour and within two pixels of solid skin fixed the rim without eating art — and the
> result still wasn't good enough, because a dark or desaturated character turns the mannequin's
> careful shading to mud. The item's own art is what the game shows.

One piece has no tile at all: **Calcifer Glow**'s whole render peaks at alpha 70 over RGB 67 — an
additive glow meant to sit over the Creature, a black square on its own — so the card names it and
shows a placeholder.

**The marketplace card shows the same breakdown.** `/api/market/creatures/token/<id>` returns a
`parts` array beside `attributes` — a tile per real item, the Outfit opened up into its garments —
resolved from the same in-memory art map and `creature-outfits.json`, so the modal costs no extra
fetch and no upstream call. Body, Background Color and Rarity are left out (a skin colour, a
backdrop and a tier aren't items you could hold, and all three sit in the trait list right above
it), `None` drops out, and the order is head to toe. On a 1/1 the effect is the whole point: #3295
lists three attributes and thirteen items.

### Where the tile art comes from

**Every trait is a real Highrise item, and the tile shows that item's own art** — the game's
own preview of the thing, not a crop of some Creature that happens to wear it. Two inputs,
joined on the item's **name**: the trait list from the API, and the item catalogue workbook
(`.tmp/Highrise Creature Club — All Items & Traits.xlsx`, one sheet per category, gitignored
like every other build input — keep a copy wherever you build from). Which item a trait may
match is fenced per slot by `SLOT_CATS`, with pet parts dropped, so a name that only exists as
furniture or a pet's beak is a miss rather than a wrong tile. **371 of the 466 match, with no
ambiguity at all.**

Their renders come from the asset portal, `avataritem/front/<item_id>.png`, which needs the
session cookie. The public CDN is no use here: `cdn.highrisegame.com/avatar/<item_id>.png`
*answers* for a trait id and hands back the shared blank mannequin (sha1 `733985b4…`) for
hair, mouths, ears, freckles and hats, and a 1x1 pixel for auras. The portal draws all of
them.

A portal render is one of two shapes, and the item's **category** says which — never the
pixels, because every cheap "is there a body here" test has a counter-example (long hair
covers the chest, a glow tints the arms, and the legs are posed differently from one render
to the next):

- `aura`, `bag` and **all clothing** come back as the item alone on transparency, so its own
  alpha bounds it.
- everything else comes back worn on a mannequin, and `SLOT_WINDOW` in the build script says
  what to crop. The body is drawn identically in every render from the chest up — the head
  runs x 160-440, y 11-334, and being a chibi it's the top 40% of the figure with the whole
  face crowded into the bottom third of it (eyes 166-230, nose 225-270, mouth 269-323). Each
  window is square, so it's exactly what the square tile shows; a mouth on its own bounding
  box would be a pair of floating lips, and the head window makes it a face.

**Three slots have no item and can't have one.** An Outfit trait names a whole look rather
than one archetype ("Bell Sleeve Outfit" shipped as a top and trousers under other names),
Body is the creature's skin colour, and Background Color is the picture behind it. Those 95
tiles are a picture of a Creature that has the trait, framed by `TRAIT_FRAMES` in `server.js`
(`[centre x, centre y, side]` on the 666px render, `null` for the whole thing). **Outfit is
`null`** — a look is the whole Creature, and cropping it to the waist down showed trousers and
shoes while hiding the top half of what the name promises. Which
Creature: the endpoint picks the **plainest wearer** — fewest non-"None" traits, then the
most ordinary of those — so nothing crowds the trait. Rank is unique, so a trait keeps the
same Creature across rebuilds. Each slot is uniform either way, so a block of tiles always
reads as one set.

The tiles are baked rather than cropped in the browser: a Creature render is 445 KB and a
slot of 64 traits would pull 28 MB of them, against ~9 KB for a 240px crop.

```bash
python tools/build-trait-art.py                    # against the local server
python tools/build-trait-art.py --api https://hcc.highrise.game
```

**The tiles live in Postgres, not the repo** — the `trait_art` table, reaching the browser
through `/api/collections/art/trait/<art_id>.webp`, exactly as the release archive's pictures
do. Same two reasons: no binary in the repo, and the URL is a hash of the bytes rather than the
trait's name, so it can be cached for a year and nothing published names an item. It's a table
of its own rather than a third variant of `collection_art` for one specific reason: that table's
stale sweep deletes by `art_id` **without scoping to a variant**, so trait rows parked there
would be wiped by any collections build (it has already eaten 1,111 rows once).

Keyed by `slug` (`<slot>--<trait>`) with `art_id` as the served handle, so re-baking a tile
swaps its bytes *and* its URL and no cache can serve the old one. A rebuild that changes nothing
touches no rows. Renders cache under `tools/trait-render-cache` and `tools/creature-cache`, so a
re-run costs no requests either.

`server.js` reads slug → art_id once per boot. A trait with no row — a new one between builds,
or no database at all — tells the client to frame a Creature render live instead: heavier
(445 KB a tile) but never broken, and it's what a brand-new Gen 2 trait would do before the
next build.

### The panel mirror (item list + art, for any build that needs it)

Two tools pull the club's whole catalogue off the asset portal so no build has to wait on a
hand-made export. Both are local-only (`tools/` is gitignored) and both read the session cookie
straight out of the Discord Center database — it's never printed or written anywhere.

```bash
python tools/fetch-panel-items.py     # 5 calls  -> tools/panel-items.json  (3,106 items, 1.3 MB)
python tools/fetch-panel-art.py       # 1 per item -> tools/panel-art/<disp_id>.png + index.json
```

**The item list is five calls, not 3,000.** `GetItemsRequest` returns up to 1000 rows a page, but
it needs **`offset` and `sorts`** alongside `filters` and `limit` — without them it answers
`500` with an empty body, which is easy to misread as a dead cookie. Three id families are asked
for separately, because a substring match on `hcc` cannot see `hrcc` (h-r-c-c doesn't contain
h-c-c) and neither sees `creatureclub`: that blind spot kept 1,609 items out of the release
archive for a year, and the workbook export still misses the 33 `creatureclub` ones. Each row
carries the item's ObjectId, category, rarity, gender, `asset_status`, `is_purchasable`,
`affiliations` and `updated_at`. **Copy counts are not in it and can't be** — those need
`GetItemStatsRequest`, which is off limits, so they still only come from a supplied workbook.

**The art is one request per item**, routed by archetype type — `DAvatarItemArchetype` →
`avataritem/front/<disp_id>.png` (worn, 600x800), `DStructureArchetype` →
`furnitureitem/0/<disp_id>.png` (the piece alone, 256px square). Every category in the catalogue
was probed against those two before the sweep ran. `index.json` holds what came back for every id
— hash, size, dimensions, or the status that failed — so a later build can tell "this item has no
art" from "we never asked", and a re-run only fetches what's missing. Pet parts are skipped by
default (`--pets` includes them): a pet is composed from its part zips, and the per-part portal
render frames each part on its own canvas.

The full sweep, 2026-08-04: **2,453 items asked, 2,438 drew, 0 failures, 221 MB.** The 15 that
didn't are all explained, and none of them is a gap to chase:

- **6 `set` archetypes and the Ignition Boost emote** answer `200` with a **1x1 pixel**. A set is
  a bundle and an emote is an animation, so neither has art of its own.
- **3 unnamed rows** (name `---`) the archive drops anyway, and one real item with no render at
  all: the **Fallen Grace Distressed Tee**.
- **4 come back as the blank mannequin.** Two are *correct* — Invisible Hair, front and back,
  is invisible. The other two are the **Creature Gold Bars**, whose art only ever existed in their
  archetype's `thumbnail_url` and is already staged in `tools/item-art/`.

## Market data

The **Market** tab shows floor prices and weekly sale-price history for Creatures and LAND.

- **Creatures** — floor + sale history from the Immutable zkEVM API (no key required).
- **LAND** — floor + 30-day stats + sale history from OpenSea when `OPENSEA_API_KEY` is set.
  Without a key it falls back to CoinGecko for the current floor only (no history line).

All data is fetched server-side and cached for 30 minutes (`/api/market`), so no
database is needed — history is recomputed from on-chain/marketplace sales each refresh.

### Every view has an address

The marketplace is one panel with several views, and each one is a real URL the server also
serves, stamps a head for, and lists in `sitemap.xml`:

| Path | View |
| --- | --- |
| `/trade` | Buy — the front door. `/trade/buy` is the same page and normalises to this. |
| `/trade/sell` | Sell / mass-list |
| `/trade/transfer` | Transfer creatures, LAND or coins |
| `/trade/sales` | Sales history + price chart |
| `/trade/history` | This wallet's own activity |
| `/trade/add-funds` · `/trade/cash-out` | The two money views |
| `/profile/{slug}` | A holder's public showcase (opt-in) |

What's a path and what's a query is the split between *which screen* and *what it's showing*:
`?coll=land` (the collection), `?token=` (an open detail modal) and `?t=Type:Value` (a filter
deep link from the trait showcase) mean the same thing on every view, so they ride as
parameters and survive a tab switch — `/trade/sales?t=Eyes:Grey%20Sweetie%20Eyes` is a
shareable "what does this trait actually sell for".

The LAND market is the exception that gets its own head: `?coll=land` is not a detail of the
Creature market, it's a different market on a different chain, so those addresses carry their
own title, description and canonical, and their own lines in the sitemap.

Client side, `openTradeTab()` in [js/marketplace.js](js/marketplace.js) is the one door — the
tab strip, an in-page `<a href="/trade/sales">` and the router all go through it, so the view,
the address and the browser-tab title can't disagree. Tab changes `pushState` (Back walks
them); a collection switch or opening a token `replaceState`s, because those are the same
place seen differently.

### Sales history, and the Immutable X years

The marketplace's **Sales History** tab is a separate feed: every completed sale, filtered by
the same faceted search as Browse, with a price chart over the matched set (each dot is one
sale, the line is a bucketed average). Both ride `/api/market/{creatures,land}/sales`; the
chart is sent with page 0 only, since it describes the whole match rather than the page.

Zoom the chart into a period and the six figures above it (sales, average, median, low, high,
volume) answer for **that period**. Where the scatter is the whole matched set the browser
works them out on the spot; past a few hundred sales the scatter is an even sample — which can
say what things went for but not how many or how much — so the same endpoint answers exactly,
via `&from=<ms>&to=<ms>` (a ~500-byte stats-only reply off the already-memoized view). The card
list below is deliberately left alone: a zoom is a question about the numbers, not the sort.

Creatures traded on **Immutable X (StarkEx) from 2021 until the July 2025 move to zkEVM**, and
that's about 95% of the collection's sale history. `api.x.immutable.com` was switched off with
the rollup, so those years come from **immutascan.io's archived index** (`lib/imx-archive.js`,
the same public GraphQL endpoint its own site reads). No key of ours, no config: the sweep runs
once in the background at boot (~70 paged calls, under a minute, ~13.2k trades) and is held for
the life of the process, because StarkEx is sunset and the archive can never grow.

- Token ids survived the migration 1:1, so an archived sale joins the Creature catalogue by the
  same id — same name, art, traits and rarity rank as a zkEVM one.
- Each archived trade carries the **ETH/USD rate at the moment it happened**, which is what
  values a 2022 sale in 2022 dollars. (Our own daily table only reaches back a year.)
- Roughly 0.6% of them settled in IMX or mainnet USDC. Their ETH-equivalent would need a rate
  for a date we have none for, so they're dropped rather than quoted wrong.
- If the archive is unreachable the tab is exactly the live zkEVM feed — it only ever extends
  the history backwards.

## Where you live changes the answer (the country picker)

Both money guides — **Guides › Marketplace › Funding** and **› Cash out** — end with a
country picker. Pick a country (and a state in the US) and the block rewrites itself: which
of the options above actually work there, over which bank rail, which local exchange to use
instead, and the notes that change the decision. The two blocks share one pick, so choosing
Brazil on Cash out already applies on Funding.

Nothing detects location. The site has no geo lookup and its CSP allows no third-party call
that could do one; the pick is the member's own and lives in `localStorage`. The only nudge
is a button offering the region the browser already declares.

The data sits in two files, kept apart on purpose:

- **`js/region-data.js` is generated. Never hand-edit it.** It carries MetaMask's per-country
  and per-US-state buy/sell flags with the payout rails for each, Binance's signup coverage,
  and Transak's coverage for the card on our own Add funds page.
- **`js/region-curated.js` is maintained by hand**, for what nobody publishes. Kraken's
  prohibited-regions list and the nine currencies it pays out, the markets Binance announced
  it was leaving, Coinbase per country, the local exchanges, and every country note. Each
  block names the page it was read from and the date.

Each provider gives up a different amount, and the copy is careful to claim only what its
source supports:

| Provider | What its own systems give us | What they don't |
|---|---|---|
| MetaMask | buy/sell per country and US state, payout rails for each | nothing important |
| Binance | the signup country list | any bank rail, and its market exits |
| Transak | currency and payment methods per territory | a real country list |
| Coinbase | nothing any more | everything |
| MoonPay | a second, independent off-ramp view, cross-check only | it isn't an option on the page |

Binance's list is evidence about a dropdown, not about service, and it lags reality by
years. Every country below is still in that dropdown today:

| Country | What's actually true | Where it lives |
|---|---|---|
| Canada, Netherlands | announced exits, accounts moved to withdrawals only, 2023 | `BINANCE.left` |
| the 30 EEA countries | service suspended 1 July 2026, no MiCA licence | `BINANCE.mica` |
| Russia | announced a full exit in 2023 and sold the business, but some accounts still work | `BINANCE.exiting` |
| United Kingdom | no new customers since 16 October 2023 | `BINANCE.frozen` |
| Philippines | site and app blocked by the SEC and NTC since 2024 | `BINANCE.blocked` |

That is why the generic row never says "opens accounts here", only that the signup list
still includes the country. **Treat a fresh build's Binance flag as a starting point, not
an answer**, and check the news for any market before trusting it. The four maps say what
kind of gap each one is: `left` is gone, `mica` is a suspension with withdrawals still
open, `exiting` is announced but not complete, `blocked` is the country's own regulator
rather than Binance.

Refresh the generated half with:

```bash
npm i -D playwright                        # once; Transak's edge blocks a plain fetch
node scripts/build-region-data.mjs         # writes js/region-data.js
node scripts/build-region-data.mjs --check # fetch and report, write nothing
```

It takes a few minutes: MetaMask is asked for the payout rails of all 219 sell-capable
countries plus every US state, gently, because it rate-limits. A run that loses a region to
a 429 keeps the previous answer for it, so running it twice fills the gaps. Read the header
comment before changing it — it records which of MetaMask's three ramp hosts is the one with
real flags, why Transak's `/countries` is not its coverage, why Binance's signup list is only
half an answer, and why Coinbase is not in there at all.

**MoonPay is a check, not a fifth option.** Its country API is public and keyless and gives
`isSellAllowed` per country plus per US state and per Canadian province, and MoonPay is one
of the payment companies behind MetaMask Sell. It is deliberately kept off the page: the
four options were each vetted and written up, and members here distrust MoonPay by name.
What it earns its place for is catching a coverage claim that has gone stale. The build
prints two buckets: countries where both refuse (a corroborated dead end, currently 30) and
countries MetaMask refuses but MoonPay allows (a route the page would be silent about,
currently none). If that second bucket ever fills, somebody should look.

If you ever go back at Coinbase: `api.coinbase.com/v2/countries` 404s now, and
`help.coinbase.com` sits behind a Cloudflare bot check that turns away curl, WebFetch and
headless Chromium alike. One article came through on a patient retry loop; the
supported-countries and per-region funding articles did not.

**The honesty rules this block exists to keep.** Every row has four states, and "Unchecked"
is a real one: it says we could not confirm the country and points at the company's own
signup screen. Never turn an unconfirmed row into a "works" to make the table look complete,
and never let a missing country read as "not available there". Countries under comprehensive
sanctions are listed in the picker on purpose — a member in Iran is a large share of this
club, and "none of these serve you" in one tap beats a country missing from the dropdown.

## Gas assist (we pay the member's gas)

**Ships dark. It does nothing until `GAS_FAUCET_ENABLED=1` and a funded key are set, and it
should not be switched on until the compliance sign-off below is done.**

### The problem

IMX is the native gas coin on Immutable zkEVM, so every action needs a little of it.
Measured on our own contract in August 2026:

| Action | Gas cost | USD at IMX ≈ $0.157 |
| --- | --- | --- |
| `safeTransferFrom` (send a Creature) | 0.0005 – 0.0007 IMX | ~$0.0001 |
| `fulfillAvailableAdvancedOrders` (buy) | 0.004 IMX avg, 0.016 IMX worst seen | ~$0.0006 |

A holder with an empty wallet can't sell, transfer or even gift their Creature, and getting
IMX from scratch costs about $30 through a card on-ramp. Spending $30 to unlock $0.0006 of
gas is the whole problem. A sample of the 600 largest holder wallets found **61% holding
exactly zero IMX** and 65% below the 0.01 IMX threshold, so this is the common case, not an
edge case.

Note the sizing: **0.01 IMX would not reliably cover one purchase** (a single heavy buy has
been seen at 0.016 IMX). The default grant is 0.02 IMX, about $0.003, which is roughly 5
buys or 30 transfers. That clears the worst buy we have measured, but only just, so this is
the first number to raise if grants start running out mid-trade.

### How it works

Just-in-time, not a faucet page. When a member hits Buy / Sell / Transfer with an empty
wallet, the existing gas panel offers to cover it (`showGasHelp` in
[js/marketplace.js](js/marketplace.js)); the bridge and card on-ramp stay as the fallback.
There is no standalone "claim free crypto" page, and deliberately so: that shape is what
wallet drainers imitate.

- `GET /api/market/creatures/gas/assist` — may this member be covered right now.
- `POST /api/market/creatures/gas/assist` — do it. Re-checks every gate against the chain
  and the ledger; the GET is a UI hint, never an authorisation.

**A claim is once per member, for good.** Not a cooldown, not a monthly allowance: one
payment, then never again. That's what makes it safe to pay whichever wallet the member has
connected instead of demanding a particular one. The *Creatures* are only tainted for 30
days, though — see below for why that one is deliberately not permanent.

The gates, in order:

1. **Discord session required.** The session carries the two identities that matter: the
   Discord account and the Highrise account behind it.
2. **Paid to the wallet the member has connected**, passed as `address`. A connected wallet
   proves nothing about who owns it, so nothing is trusted to it — see the trust model
   below. Nothing is signed or approved by the member.
3. **That wallet must hold at least one Creature**, read live from the chain.
4. **Must be below `GAS_FAUCET_TRIGGER_IMX`** (default 0.01), read live from the chain.
   Grants top up *to* the target, so 0.009 IMX gets 0.011, not a flat 0.02.
5. **Sanctions screen** on the destination — see below.
6. **Once per lifetime**, on all three identities:
   - the Discord account (`gas_grants.discord_id`)
   - the Highrise account behind it (`gas_grants.highrise_id`)
   - the paid wallet (`gas_grants.wallet`)
7. **Every Creature in that wallet is tainted for 30 days** (`gas_asset_locks.tainted_until`,
   `GAS_FAUCET_TAINT_DAYS`), and a claim needs at least one Creature that isn't currently
   tainted. Deliberately **not** permanent: a Creature outlives its owner's claim, so marking
   it for life would hand whoever buys it next a dead claim they never made. 30 days makes
   bag-splitting pointless without damaging the asset.
   **The member is told the window exists, never how long it runs** (see `gasAssistTermsHtml`
   in [js/marketplace.js](js/marketplace.js)). Naming a number only invites people to count
   it down over a rule that bites nobody trading normally, so `gasFaucet.policy()` doesn't
   carry it and the copy doesn't either. Don't put it back.
8. **Site-wide daily cap** (`GAS_FAUCET_DAILY_CAP`, default 200) as a circuit breaker, and
   a **float reserve** so a misconfigured target can't drain the wallet.

### Why paying an arbitrary connected wallet is safe

Because the claim is bound to the **asset**, not the wallet. Connecting a different wallet
gains nothing: the Discord and Highrise accounts are already spent, for good. Using a
different Discord account gains nothing inside the taint window: the taint follows the
token, so shuffling Creatures between wallets doesn't reset it. To claim twice you would
need a second Highrise account *and* a Creature that isn't tainted — at which point you are
simply a second holder, which is who this is for.

The member does choose the destination, since it's their connected wallet. That's their own
one and only claim to spend, so there is nothing to steal from anyone else, and the address
comes from the injected provider on our own page rather than a text field.

All the checks and the insert run in one transaction under advisory locks on the account,
the Highrise id and the wallet, so two tabs can't both pass the gate.

A grant row is written *before* signing, and deleted again if the send fails, so a broken
RPC never burns someone's one and only claim. `gas_grants` is the permanent payout ledger;
`gas.granted` / `gas.blocked` / `gas.send_failed` / `gas.faucet_empty` land in `audit_log`.

The rule is stated in the UI before the button — where the IMX goes, that it's one-off, and
how long it puts the wallet's Creatures out of action. Nobody should discover this after
clicking, and the day count is read from the server so the copy can't drift from the rule.

### The hot wallet

This is the **only** place in the codebase that holds a private key or signs a transaction.
Everything else is non-custodial: the member's wallet signs and the server only reads. To
keep that boundary sharp, [lib/zk-tx.js](lib/zk-tx.js) can only send native IMX to an
address — `data` is hard-coded empty and there is no calldata parameter, so it cannot call a
contract, grant an approval, or move a token. If something later needs those, give it its
own reviewed module rather than widening this one.

Operational rules:

- Use a **dedicated wallet holding nothing but the float**. Never a wallet with Creatures,
  ETH, or any other asset in it.
- Keep it small. 50 IMX (~$8) covers 2,500 grants. Top up by hand; don't automate refills.
- `GAS_FAUCET_KEY` goes in Railway **Variables** only. It is never logged (the boot line
  prints the public address and the float, never the key).
- The boot log reports the float on every deploy and flags it when low. Watch for
  `[gas-faucet] float exhausted` in the logs.

### Sanctions screening (required)

[lib/sanctions.js](lib/sanctions.js) screens every destination against the OFAC SDN list via
Chainalysis's free on-chain sanctions oracle, queried on Ethereum mainnet through
`ETH_RPC_URL` (it isn't deployed on zkEVM; an address is the same address on both chains).
No API key. It **fails closed** — a screen we can't complete refuses the payment.
`SANCTIONS_DENYLIST` is a manual comma-separated block list on top. `SANCTIONS_FAIL_OPEN=1`
relaxes the fail-closed rule and is for local dev only.

### Before switching it on

Ship the code first, leave it dark, then:

1. **Get a compliance/legal sign-off.** This distributes a crypto asset from a Pocket
   Worlds wallet to members worldwide. The amount ($0.003) doesn't change the analysis.
   Confirm the sanctions screen and the audit trail satisfy them, and ask whether any
   geo-restriction is wanted on top.
2. **Pin `ETH_RPC_URL` to a provider you control.** The sanctions screen is only as
   trustworthy as the node that answers it. The default is a public endpoint: it fails
   closed if that's unreachable, but a compromised one could answer "not sanctioned".
3. Generate a fresh key for a wallet that has never held anything else. Fund it with a
   small float.
4. Set `GAS_FAUCET_KEY`, then `GAS_FAUCET_ENABLED=1`, and confirm the boot log reports
   `LIVE` with the float you expect.
5. Confirm the market analytics ignore self-trades before launch. Free gas makes
   wash-trading cheaper, and the site publishes floor and volume figures.
6. Watch `gas_grants` for the first day.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAS_FAUCET_ENABLED` | *(off)* | `1` to arm it. Without this, nothing pays out. |
| `GAS_FAUCET_KEY` | — | Faucet wallet private key (32-byte hex). Railway Variables only. |
| `GAS_FAUCET_TARGET_IMX` | `0.02` | Top up *to* this balance. |
| `GAS_FAUCET_TRIGGER_IMX` | `0.01` | Only help wallets below this. |
| `GAS_FAUCET_RESERVE_IMX` | `2` | Never spend the float below this. |
| `GAS_FAUCET_TAINT_DAYS` | `30` | How long a claim blocks the Creatures it was made on. |
| `GAS_FAUCET_DAILY_CAP` | `200` | Site-wide payouts per 24h. |
| `SANCTIONS_DENYLIST` | *(empty)* | Extra addresses to refuse, comma-separated. |
| `SANCTIONS_FAIL_OPEN` | *(off)* | Local dev only. Allows payment when screening is down. |

### Testing locally

`server.js` calls `process.loadEnvFile()` unconditionally, so running it from the repo root
**always** loads `.env` — and the local `.env` points at the production database. To test
against the in-memory store, run it from another directory with its own `.env`:

```bash
mkdir -p /tmp/hcc-test && cd /tmp/hcc-test
cat > .env <<'EOF'
DEV_LOGIN=1
GAS_FAUCET_ENABLED=1
GAS_FAUCET_KEY=<a throwaway key>
PORT=3198
EOF
node /path/to/hcc-player-council/server.js     # logs "using in-memory store"
```

Then sign in as a holder that genuinely has a Creature and no gas, and hit the endpoints:

```bash
curl -c c.txt "localhost:3198/api/auth/dev-login?user=Test&creatures=1&wallet=0x<real holder>"
curl -b c.txt "localhost:3198/api/market/creatures/gas/assist?address=0x<same wallet>"
```

An unfunded faucet key returns `faucet_empty` and spends nobody's claim, so the whole path
is safe to exercise without moving real value.

Credit: [Sam](https://www.communityhr.live/imxfaucet) (@Community on HR) built the first
IMX faucet for HCC middlemen and suggested we run one too. Ours is a separate
implementation on our own infrastructure; we don't link members to third-party faucets.

## Apply & Vote (the First Election)

The **Council › Apply & Vote** sub-tab (`/council/vote` — the old `/apply` links
redirect there) runs the Council's first election end-to-end: a holder signs
in with Discord, sees whether they can vote and which seat bracket they can run for,
self-nominates if eligible, and uses the Voting Advice Application to find their
best-matching candidates.

**Sign-in & eligibility.** `/api/auth/discord/login` → Discord OAuth2 (scope `identify`) →
`/api/auth/discord/callback` → look up the Discord account's linked ETH wallet via
the Highrise web API (`/discord/users/<id>/wallet`) → match that wallet against the
current Creature + LAND holder snapshot → compute the running bracket → create
a session. `GET /api/me` returns the logged-in user's eligibility for the front-end.

Brackets gate *running*, not voting — every eligible holder votes on all four races.
They're defined in [lib/eligibility.js](lib/eligibility.js):

- **1–4 assets** → 2 seats
- **5–14 assets** → 1 seat
- **15+ assets** → 1 seat

That's 4 elected seats; 3 more are appointed for continuity.

**Self-nomination.** `POST /api/application` saves a candidate's draft and submission
(short pitch, questionnaire answers, and a stance per VAA position). `POST
/api/application/derive` optionally drafts those stances from the candidate's own
answers with an AI assistant (OpenAI, strict JSON schema — see
[lib/derive-positions.js](lib/derive-positions.js)); the candidate reviews and edits
every line before submitting. Final submission is gated by `APPLICATIONS_OPEN`.
A submitted application can be edited (full validation re-runs) until voting begins —
through the candidacy window and the quiet period after it. It always stays submitted —
a draft save can't silently withdraw a candidacy — and it locks once `VOTING_OPEN` is
set, so the field can't shift mid-vote.

**Election board.** `GET /api/election` returns the public race snapshot — seats and
candidate counts per bracket — that powers the status board. No auth or wallet needed;
it's the same picture every voter sees.

**Voting Advice Application.** `GET /api/vote` returns the propositions; `POST /api/vote`
takes the voter's stances and ranks candidates by affinity. Matching runs **entirely
server-side** so candidate positions never ship to the browser, and the voter's answers
are never stored or logged. Candidate names and free-text answers stay hidden during the
candidacy phase and are revealed once `VOTING_OPEN` is set.

**The official ballot.** `GET /api/ballot` returns the voter's races (mode, candidates,
their own ballot if cast); `POST /api/ballot { bracket, choice }` casts a vote. The
published rules, enforced in code:

- **One vote per seat** — a race elects `seats` seats and each voter gets that many
  votes in it (the Member race elects 2, so members pick two candidates; single-seat
  and confirmation races give one). The top `seats` candidates win. Never weighted by
  holdings. Picks are cast one at a time and a candidate can't be picked twice.
- **Each pick is final once cast** — ballot storage is insert-only, one row per pick
  ([lib/db.js](lib/db.js)); the per-race cap and de-dupe are enforced under an advisory
  lock so concurrent submits can't exceed it. A voter can ADD their unused picks later
  but can never change a cast one (a duplicate or over-cap pick gets a 409).
- **Secret ballot.** The voter↔choice row exists only to enforce one-vote-per-race and
  never leaves the server; the audit log records *that* a ballot was cast, never the
  choice; there is no live tally. Each voter gets a private receipt code as proof their
  vote was counted. Only aggregate per-seat tallies are ever published, and only once
  `RESULTS_OPEN` is set.
- **Inclusion verifiability.** With the results, each race publishes its full list of
  receipt codes (codes only — random, sorted, linked to neither voter nor choice).
  A voter finds their own code to confirm their ballot is in the count, and the list's
  length always equals the published turnout. Receipts deliberately do NOT encode the
  choice — a receipt that could prove *how* you voted would invite coercion and
  vote-buying.

**The frozen electorate (continuous-holding rule).** True continuous holding can't be
proven from a single chain read, so it's enforced as **two checkpoints**: set
`VOTER_SNAPSHOT=<label>` and the server captures the current holder set **once** at
startup (bulk holder data unioned with the authoritatively-verified `applicants`
wallets, so indexing gaps can't disenfranchise a real holder). From then on, casting a
ballot requires the voter's wallet to be **in the snapshot AND holding at vote time**
(eligibility is recomputed live on every ballot request — a stale session can't vote
with an emptied wallet). Assets bought after the snapshot can't vote in this election.
Operations notes:

- Capture is idempotent: restarts find the existing snapshot and reuse it; the
  electorate stays frozen. Verify the capture in the deploy logs
  (`[snapshot] '<label>' captured: N holder wallets`) before opening voting.
- **Fail-closed**: while `VOTER_SNAPSHOT` is set but capture hasn't completed,
  ballots are rejected (503) rather than silently skipping the check.
- Transparency: `/api/election` publishes the snapshot's size and capture date
  (never the wallet list), and the board states it under the race cards. Voters not
  in the snapshot see a clear gate explaining the rule instead of a 403.
- A wrongly-excluded holder can be remedied with a manual
  `INSERT INTO voter_snapshots` row — auditable, and far rarer than the union
  capture leaves room for.

**Unopposed races — the confirmation-vote rule.** A race with no more candidates than
seats (e.g. one 15+ candidate for the one 15+ seat) is *not* auto-won. The ballot for
that race becomes **"Seat the candidate(s)" vs "Reopen nominations"**:

- Seat wins a majority of votes cast on that race → seated with a real mandate.
- Reopen wins a **strict majority** (ties favour seating) → that bracket's candidacy
  window reopens once. A new candidate entering turns the re-run into a normal
  contested race; if **nobody new enters by the deadline, the original candidates are
  seated by rule**.

Rejection therefore has to be constructive: the only way to unseat an unopposed
candidate is to field someone who beats them. Since brackets gate running but not
voting, the wider electorate could otherwise veto a small bracket's only candidate at
zero cost — a brigade can force a real contest, but never vote a seat into a vacancy.

Election phases are driven by env flags, in order:

1. `APPLICATIONS_OPEN=1` — candidacy window (the application form accepts submissions).
2. `VOTER_SNAPSHOT=<label>` (with everything else still closed) — freezes the
   electorate; verify the capture count in the logs.
3. `VOTING_OPEN=1` — voting; names go public, ballots can be cast.
4. `RESULTS_OPEN=1` (with `VOTING_OPEN` cleared) — `/api/election` publishes tallies
   and per-race outcomes; the board renders them.
5. If a confirmation race resolved to "reopen": set `REOPENED_BRACKETS=whale` (csv) and
   `REOPEN_DEADLINE=<ISO date>` — that bracket's application window reopens until the
   deadline (everything else stays closed). If new candidates entered, re-run the vote
   with `VOTE_ROUND=2` + `VOTING_OPEN=1` (only reopened brackets are votable in round 2);
   if nobody entered, just re-set `RESULTS_OPEN=1` — the board shows the original
   candidates seated by rule.

Required env vars (see `.env`):

- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` — from the Discord developer portal.
- `HIGHRISE_API_KEY` — for the wallet lookup (sent as `X-Api-Key`).
- `SESSION_SECRET` — change from the dev default in production.
- `DATABASE_URL` — Postgres connection string. Railway injects this when a Postgres
  plugin is attached. Without it, the app uses an in-memory store (fine for local dev,
  data lost on restart).
- `APPLICATIONS_OPEN` — gates candidacy submission. Until it's truthy (`1`/`true`/`yes`/`on`),
  the eligibility check and draft-saving stay live but final submission is blocked.
- `VOTING_OPEN` — distinct from `APPLICATIONS_OPEN`. Until it's set, candidates are an
  anonymous preview (pitch + matchable positions only); once set, names and full answers
  go public, the matcher returns live results, and the ballot accepts votes.
- `RESULTS_OPEN` — set after voting closes to publish per-race tallies and outcomes on
  `/api/election`. Aggregates only; never set together with `VOTING_OPEN`.
- `REOPENED_BRACKETS` / `REOPEN_DEADLINE` / `VOTE_ROUND` — the one-time reopen flow for
  a confirmation race that resolved to "reopen nominations" (see above).
- `VOTER_SNAPSHOT` — label of the frozen electorate snapshot (see above). Captured once
  at startup; voting is gated on membership while set. Local testing can seed it with
  `VOTER_SNAPSHOT_SEED=<csv wallets>` (honored only when the gitignored dev-login
  helper is present — inert in production).
- `OPENAI_API_KEY` — enables AI-assisted position drafting on the self-nomination form.
  Optional; without it the form still works, candidates just fill in stances themselves.
  `OPENAI_MODEL` overrides the default (`gpt-5.4-mini`).
- `ETH_RPC_URL` — optional override for the Ethereum RPC used in per-wallet holdings
  lookups (defaults to a public Blockscout endpoint).

In the Discord developer portal, register these **OAuth2 → Redirects**:

- `https://hcc.highrise.game/api/auth/discord/callback` (production)
- `http://localhost:3000/api/auth/discord/callback` (local dev)

The redirect URI is derived from the request host automatically (so both work);
set `DISCORD_REDIRECT_URI` only if you need to override it.

### Testing eligibility screens locally (no wallet needed)

To exercise every eligibility state without a real wallet/NFT, enable the local
dev-login helper:

1. Copy the template: `cp lib/dev-login.example.js lib/dev-login.js`
   (the active `lib/dev-login.js` is **gitignored** — it is never committed or deployed,
   so this auth bypass cannot exist in production).
2. Set `DEV_LOGIN=1` in `.env` and restart.
3. Visit, e.g.:
   - `…/api/auth/dev-login?user=Whale&creatures=4&land=2` → 5+ bracket
   - `…/api/auth/dev-login?creatures=3` → 2–4 bracket
   - `…/api/auth/dev-login?creatures=1` → single bracket
   - `…/api/auth/dev-login?creatures=0&land=0` → holds nothing
   - `…/api/auth/dev-login?linked=0` → no wallet linked
   - `…/api/auth/dev-login?creatures=2&holders=0` → holder snapshot loading

**Never** create `lib/dev-login.js` or set `DEV_LOGIN` on Railway.

### Testing the voting screens locally (test wallet + snapshot)

The repo `.env` points at the production database — **don't** run voting experiments
through it. Start the server from a directory without a `.env` so it uses the
in-memory store, and seed the snapshot with the dev wallet:

```powershell
cd $env:TEMP   # any directory without the repo .env
$env:DATABASE_URL=''; $env:DATABASE_PUBLIC_URL=''          # in-memory store
$env:DEV_LOGIN='1'; $env:APPLICATIONS_OPEN='1'; $env:VOTING_OPEN='1'
$env:VOTER_SNAPSHOT='local-test'
$env:VOTER_SNAPSHOT_SEED='0xdev0000000000000000000000000000000000dead'
node d:\hcc-player-council\server.js
```

- `…/api/auth/dev-login?user=Voter&creatures=2` → uses the default dev wallet, which
  is seeded → full ballot renders (submit a candidate first to populate races).
- `…/api/auth/dev-login?user=LateBuyer&creatures=2&wallet=0xdev-late` → wallet not in
  the snapshot → the "not in the voting snapshot" gate screen.
- Add `&icon=https://cdn.highrisegame.com/...` to test candidate avatars end-to-end.

## Polls & Votes (official community polls)

The **Polls & Votes** tab (`/polls`) hosts official club-wide votes — decisions the
Council sends to every holder rather than deciding in the room (the first: the Gen 2
ship order). Same trust chain as the election ballot: Discord sign-in → Highrise-linked
wallet → live holder check. One holder, one vote — enforced per Discord account *and*
per wallet — insert-only with a private receipt code; per-option tallies and the full
receipt list are published only after the poll closes.

- **Definitions** live in [lib/polls.js](lib/polls.js) (id, i18n key, option ids).
  Copy lives in the locales under `polls.p.<key>.*` — the API never ships display text.
- **Scheduling** is env-driven, no redeploy needed: e.g. `POLL_GEN2_OPENS` /
  `POLL_GEN2_CLOSES` (ISO timestamps). Unset opens-at → the poll shows as "opens soon";
  unset closes-at → open-ended until the env is set.
- **API**: `GET /api/polls` (viewer context + polls; results once closed),
  `POST /api/polls/vote` `{ poll, choice }` (401 signed-out, 403 non-holder/closed,
  409 already-voted).
- **Local testing**: use the in-memory recipe above with
  `$env:POLL_GEN2_OPENS='2026-01-01T00:00:00Z'` to force the poll open, then
  dev-login as a holder and vote. Set `POLL_GEN2_CLOSES` in the past to see results.

## Railway

Railway can deploy this repo directly. The app listens on `process.env.PORT` and serves `index.html`.

To get the LAND history line in production, add `OPENSEA_API_KEY` to the Railway service's
**Variables** (the local `.env` is gitignored and not deployed). Without it, LAND still shows
its current floor via CoinGecko.
