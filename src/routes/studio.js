// The Studio, both faces (M4) — every displayed value traces to a server
// record. Nothing here is computed from client state, and nothing is
// cached in the response: counts come from the saves / follows /
// listing_views / pitches / orders rows themselves, at read time.
//
// Seller face: my listings with posted-where state, saves + views counts
// per listing, the commissions pipeline, and Sales & Earnings — fee
// snapshot math per order, transfer_state and payout_state as SEPARATE
// fields (a transfer is not a payout; M0).
// Buyer face: Saved, Following, Orders, My Briefs with pitch counts.
//
// Engagement actions live here too: save / unsave, follow / unfollow,
// and the view event a public listing read records.
import { requireAuth } from '../auth.js';
import { listingView } from './listings.js';
import { orderView } from './orders.js';
import { briefView } from './briefs.js';
import { recordListingView } from '../lib/views.js';

function notFound(reply, what = 'Listing') {
  return reply.code(404).send({ error: { code: 'not_found', message: `${what} not found` } });
}

export function registerStudioRoutes(app, pool) {
  const auth = requireAuth(pool);

  // --- Saves -------------------------------------------------------------
  app.post('/v1/listings/:id/save', { preHandler: auth }, async (req, reply) => {
    const { rows } = await pool.query('SELECT id FROM listings WHERE id = $1', [req.params.id]);
    if (!rows.length) return notFound(reply);
    await pool.query(
      `INSERT INTO saves (account_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.account.id, req.params.id],
    );
    return { saved: true, listingId: req.params.id };
  });

  app.delete('/v1/listings/:id/save', { preHandler: auth }, async (req) => {
    await pool.query('DELETE FROM saves WHERE account_id = $1 AND listing_id = $2', [
      req.account.id,
      req.params.id,
    ]);
    return { saved: false, listingId: req.params.id };
  });

  // --- Views ---------------------------------------------------------------
  // The public listing read (M2) records a view event as a side effect;
  // this endpoint is the explicit form (e.g. a gallery impression the SPA
  // counts separately). Published listings only; the owner's own views
  // never count. The writer is src/lib/views.js — one rule set everywhere.
  app.post('/v1/listings/:id/view', { preHandler: auth }, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT id, account_id, status FROM listings WHERE id = $1',
      [req.params.id],
    );
    if (!rows.length) return notFound(reply);
    const result = await recordListingView(pool, rows[0], req.account.id);
    if (!result.recorded && result.reason === 'not_published') return notFound(reply);
    return result;
  });

  // --- Follows -------------------------------------------------------------
  app.post('/v1/artists/:accountId/follow', { preHandler: auth }, async (req, reply) => {
    const target = req.params.accountId;
    if (target === req.account.id) {
      return reply.code(422).send({
        error: { code: 'own_account', message: 'You cannot follow yourself' },
      });
    }
    const { rows } = await pool.query(
      `SELECT 1 FROM artist_profiles WHERE account_id = $1`,
      [target],
    );
    if (!rows.length) return notFound(reply, 'Artist');
    await pool.query(
      `INSERT INTO follows (account_id, artist_account_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.account.id, target],
    );
    return { following: true, artistAccountId: target };
  });

  app.delete('/v1/artists/:accountId/follow', { preHandler: auth }, async (req) => {
    await pool.query('DELETE FROM follows WHERE account_id = $1 AND artist_account_id = $2', [
      req.account.id,
      req.params.accountId,
    ]);
    return { following: false, artistAccountId: req.params.accountId };
  });

  // --- Seller face ---------------------------------------------------------
  app.get('/v1/studio/seller', { preHandler: auth }, async (req) => {
    const me = req.account.id;

    const { rows: listingRows } = await pool.query(
      `SELECT l.*,
              (SELECT count(*)::int FROM saves s WHERE s.listing_id = l.id) AS saves_count,
              (SELECT count(*)::int FROM listing_views v WHERE v.listing_id = l.id) AS views_count,
              EXISTS (SELECT 1 FROM listing_media m WHERE m.listing_id = l.id) AS has_media
         FROM listings l
        WHERE l.account_id = $1
        ORDER BY l.created_at DESC`,
      [me],
    );
    const listings = [];
    for (const l of listingRows) {
      listings.push({
        ...(await listingView(pool, l)),
        // Posted-where: a listing is public exactly when it is published
        // (the public reads serve published only) — stated from the record.
        postedWhere: l.status === 'published' ? 'public' : 'studio_only',
        hasMedia: l.has_media === true,
        savesCount: l.saves_count,
        viewsCount: l.views_count,
      });
    }

    const { rows: pipeRows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::int   AS pitched,
         count(*) FILTER (WHERE status = 'accepted')::int  AS accepted,
         count(*) FILTER (WHERE status = 'rejected')::int  AS rejected,
         count(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn
       FROM pitches WHERE artist_account_id = $1`,
      [me],
    );
    const { rows: acceptedRows } = await pool.query(
      `SELECT p.id AS pitch_id, p.brief_id, p.order_id,
              o.status AS order_status, f.state AS fulfillment_state
         FROM pitches p
         JOIN orders o ON o.id = p.order_id
         LEFT JOIN fulfillments f ON f.order_id = o.id
        WHERE p.artist_account_id = $1 AND p.status = 'accepted'
        ORDER BY p.updated_at DESC`,
      [me],
    );
    const commissions = {
      pitched: pipeRows[0].pitched,
      accepted: pipeRows[0].accepted,
      rejected: pipeRows[0].rejected,
      withdrawn: pipeRows[0].withdrawn,
      inProgress: acceptedRows.filter((r) =>
        ['paid', 'fulfilling'].includes(r.order_status),
      ).length,
      delivered: acceptedRows.filter((r) =>
        ['delivered', 'accepted', 'released', 'payout_pending', 'completed'].includes(r.order_status),
      ).length,
      acceptedOrders: acceptedRows.map((r) => ({
        pitchId: r.pitch_id,
        briefId: r.brief_id,
        orderId: r.order_id,
        orderStatus: r.order_status,
        fulfillmentState: r.fulfillment_state,
      })),
    };

    const { rows: orderRows } = await pool.query(
      `SELECT o.* FROM orders o
        WHERE o.artist_account_id = $1
          AND o.status NOT IN ('checkout_open', 'canceled')
        ORDER BY o.created_at DESC
        LIMIT 200`,
      [me],
    );
    const orders = [];
    let grossCents = 0;
    let settledArtistShareCents = 0;
    for (const o of orderRows) {
      const view = await orderView(pool, o);
      orders.push(view);
      grossCents += o.price_cents;
      if (view.payment && ['succeeded', 'partially_refunded'].includes(view.payment.status)) {
        settledArtistShareCents += o.artist_share_cents;
      }
    }

    const { rows: followerRows } = await pool.query(
      'SELECT count(*)::int AS n FROM follows WHERE artist_account_id = $1',
      [me],
    );

    return {
      listings,
      totals: {
        listings: listings.length,
        published: listings.filter((l) => l.status === 'published').length,
        saves: listings.reduce((n, l) => n + l.savesCount, 0),
        views: listings.reduce((n, l) => n + l.viewsCount, 0),
        followers: followerRows[0].n,
      },
      commissions,
      earnings: { orders, grossCents, settledArtistShareCents },
    };
  });

  // --- Buyer face ----------------------------------------------------------
  app.get('/v1/studio/buyer', { preHandler: auth }, async (req) => {
    const me = req.account.id;

    const { rows: savedRows } = await pool.query(
      `SELECT l.* FROM saves s
         JOIN listings l ON l.id = s.listing_id
        WHERE s.account_id = $1
        ORDER BY s.created_at DESC`,
      [me],
    );
    const saved = [];
    for (const l of savedRows) {
      saved.push({
        ...(await listingView(pool, l)),
        // A saved piece can leave the public shelf after the save; the
        // Studio says so from the record instead of pretending otherwise.
        currentlyPublic: l.status === 'published',
      });
    }

    const { rows: followRows } = await pool.query(
      `SELECT a.id AS account_id, a.display_name AS account_name,
              p.display_name AS profile_name, p.bio, p.verified
         FROM follows f
         JOIN accounts a ON a.id = f.artist_account_id
         JOIN artist_profiles p ON p.account_id = a.id
        WHERE f.account_id = $1
        ORDER BY f.created_at DESC`,
      [me],
    );
    const following = followRows.map((r) => ({
      accountId: r.account_id,
      displayName: r.profile_name || r.account_name,
      bio: r.bio,
      verified: r.verified,
    }));

    const { rows: orderRows } = await pool.query(
      `SELECT * FROM orders WHERE buyer_account_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [me],
    );
    const orders = [];
    for (const o of orderRows) orders.push(await orderView(pool, o));

    const { rows: briefRows } = await pool.query(
      `SELECT b.*, (SELECT count(*)::int FROM pitches p WHERE p.brief_id = b.id) AS pitch_count
         FROM briefs b
        WHERE b.buyer_account_id = $1
        ORDER BY b.created_at DESC`,
      [me],
    );

    return {
      saved,
      following,
      orders,
      briefs: briefRows.map((b) => briefView(b, b.pitch_count)),
    };
  });
}
