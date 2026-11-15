// Sound — the music lane's read faces (PAIRED-SOUND-PLAN).
//
// Releases ARE listings (medium='music', migration 0005): creation,
// media attach, publish, checkout, orders and fulfillment all ride the
// existing routes and machinery. What lives here is only what music
// adds on top:
//   · the public catalog (published releases, track metadata — never
//     audio URLs; full songs are the product, §4),
//   · the artist's Sound studio (my releases in every state + the
//     tier capacity record the upload screen prints BEFORE work
//     begins, read from the same lib the publish gate enforces),
//   · the buyer's Music Shelf (owned, not just saved: releases whose
//     order settled, with per-track signed download URLs re-issued on
//     every read — a purchase never ends at a dead link, §4).
import { requireAuth } from '../auth.js';
import { optionalAuth, listingView } from './listings.js';
import { presignDownload } from '../lib/storage.js';
import { artistFeeTier } from '../lib/checkout.js';
import { musicCapsForTier, musicUsage } from '../lib/music.js';

export function registerSoundRoutes(app, pool) {
  const auth = requireAuth(pool);
  const softAuth = optionalAuth(pool);

  // GET /v1/sound/releases — public catalog: published releases only.
  app.get('/v1/sound/releases', { preHandler: softAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT * FROM listings
        WHERE medium = 'music' AND status = 'published'
        ORDER BY created_at DESC`,
    );
    const releases = [];
    for (const row of rows) {
      releases.push(await listingView(pool, row, req.account?.id || null));
    }
    return { releases };
  });

  // GET /v1/sound/studio — the artist's own Sound record: every release
  // in every state (audio URLs included — it is the owner's face) plus
  // the capacity record for their tier.
  app.get('/v1/sound/studio', { preHandler: auth }, async (req) => {
    const me = req.account.id;
    const { rows } = await pool.query(
      `SELECT * FROM listings
        WHERE account_id = $1 AND medium = 'music'
        ORDER BY created_at DESC`,
      [me],
    );
    const releases = [];
    for (const row of rows) releases.push(await listingView(pool, row, me));
    const { tier, entitledTier } = await artistFeeTier(pool, me);
    const caps = musicCapsForTier(tier, entitledTier);
    const used = await musicUsage(pool, me);
    return {
      releases,
      capacity: {
        tier,
        entitledTier,
        label: caps.label,
        tracks: caps.tracks === Infinity ? null : caps.tracks,
        albums: caps.albums === Infinity ? null : caps.albums,
        storageBytes: caps.storageBytes,
        used,
      },
    };
  });

  // GET /v1/sound/shelf — the buyer's Music Shelf: one entry per
  // release this account has a SETTLED order for, tracks carrying
  // fresh signed download URLs (re-issued on demand, §4) and the
  // order id the download-logging endpoint keys on.
  app.get('/v1/sound/shelf', { preHandler: auth }, async (req) => {
    const me = req.account.id;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (o.listing_id) o.id AS order_id, o.listing_id, o.created_at AS purchased_at
         FROM orders o
         JOIN payments p ON p.order_id = o.id
         JOIN listings l ON l.id = o.listing_id
        WHERE o.buyer_account_id = $1
          AND l.medium = 'music'
          AND p.status IN ('succeeded', 'partially_refunded')
          AND o.status NOT IN ('canceled', 'refunded')
        ORDER BY o.listing_id, o.created_at ASC`,
      [me],
    );
    const shelf = [];
    for (const row of rows) {
      const { rows: lrows } = await pool.query('SELECT * FROM listings WHERE id = $1', [
        row.listing_id,
      ]);
      if (!lrows.length) continue;
      const view = await listingView(pool, lrows[0], null);
      const tracks = [];
      for (const m of view.media.filter((x) => x.kind === 'audio')) {
        tracks.push({
          id: m.id,
          title: m.title,
          durationSec: m.durationSec,
          sizeBytes: m.sizeBytes,
          position: m.position,
          downloadUrl: await presignDownload(m.key),
        });
      }
      shelf.push({
        orderId: row.order_id,
        purchasedAt: row.purchased_at,
        release: {
          id: view.id,
          accountId: view.accountId,
          title: view.title,
          priceCents: view.priceCents,
          release: view.release,
          cover: view.media.find((x) => x.kind === 'cover' || x.kind === 'image') || null,
        },
        tracks,
      });
    }
    return { shelf };
  });
}
