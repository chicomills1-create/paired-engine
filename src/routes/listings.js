// Listings: artist-owned artworks.
//
// Ownership law: every mutation resolves the owner from the caller's token
// (req.account), never from body params. A listing that is not published is
// invisible to everyone but its owner — non-owners get 404, so drafts never
// leak their existence. Published listings are public.
//
// Inventory state is NOT writable here: it moves only through the atomic
// transitions in src/lib/inventory.js (checkout lands in M3).
import { requireAuth, resolveOrCreateAccount, verifySessionToken } from '../auth.js';
import { keyInNamespace, presignDownload } from '../lib/storage.js';
import { recordListingView } from '../lib/views.js';
import { musicPublishCheck } from '../lib/music.js';
import { artistFeeTier } from '../lib/checkout.js';

const LISTING_TYPES = ['physical', 'digital'];
const LISTING_STATUSES = ['draft', 'published', 'archived'];
const LISTING_MEDIA_KINDS = ['image', 'audio', 'cover'];
const RELEASE_TYPES = ['single', 'ep', 'album'];
const CONTENT_KINDS = ['original', 'cover', 'sample', 'remix'];

function badRequest(reply, message) {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

function notFound(reply) {
  return reply.code(404).send({ error: { code: 'not_found', message: 'Listing not found' } });
}

/**
 * Soft auth for public reads: resolve the caller when a valid token is
 * present, otherwise treat the request as anonymous. Never rejects.
 * Shared: listings use it for public reads, briefs for board reads.
 */
export function optionalAuth(pool) {
  return async function optionalAuthPreHandler(req) {
    req.account = null;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
    if (!token) return;
    try {
      const claims = await verifySessionToken(token);
      if (!claims?.sub) return;
      const account = await resolveOrCreateAccount(pool, claims.sub, claims.email || null);
      if (account.status === 'active') {
        req.account = { id: account.id, clerkUserId: account.clerk_user_id };
      }
    } catch {
      // Anonymous read: public listings stay public, everything else 404s.
    }
  };
}

async function mediaForListing(pool, listingId) {
  const { rows } = await pool.query(
    `SELECT id, object_key, kind, position, title, duration_sec, size_bytes, created_at
       FROM listing_media
      WHERE listing_id = $1 ORDER BY position ASC, created_at ASC`,
    [listingId],
  );
  const media = [];
  for (const row of rows) {
    media.push({
      id: row.id,
      key: row.object_key,
      kind: row.kind,
      position: row.position,
      title: row.title,
      durationSec: row.duration_sec,
      sizeBytes: Number(row.size_bytes) || 0,
      url: await presignDownload(row.object_key),
    });
  }
  return media;
}

export async function listingView(pool, row, viewerId = null) {
  const media = await mediaForListing(pool, row.id);
  // Full songs are the product (Sound plan §4): a music listing's AUDIO
  // urls are served only to its owner here — buyers receive theirs from
  // the shelf (src/routes/sound.js) after a settled purchase, keyed to
  // their order. Everyone else gets track metadata, never a file URL.
  if (row.medium === 'music' && viewerId !== row.account_id) {
    for (const m of media) {
      if (m.kind === 'audio') m.url = null;
    }
  }
  const view = {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    description: row.description,
    category: row.category,
    priceCents: row.price_cents,
    type: row.type,
    medium: row.medium || 'visual',
    status: row.status,
    inventoryState: row.inventory_state,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    media,
  };
  if (view.medium === 'music') {
    // The release face of the listing: tracks are the audio media rows,
    // in order; the cover is the cover/image row. Public reads carry
    // track METADATA only — audio URLs ride the owner's Studio and the
    // buyer's shelf, never this view (media[] above is the owner's and
    // the piece page's image channel; audio entries there are stripped
    // of URLs by the sound routes for public catalog reads).
    view.release = {
      releaseType: row.release_type,
      genre: row.genre,
      explicit: row.explicit === true,
      releaseDate: row.release_date,
      artistCredit: row.artist_credit,
      contentKind: row.content_kind,
      rightsState: row.rights_state,
      rightsDeclared: row.rights_recording === true && row.rights_composition === true,
    };
    view.tracks = media
      .filter((m) => m.kind === 'audio')
      .map((m) => ({
        id: m.id,
        title: m.title,
        durationSec: m.durationSec,
        sizeBytes: m.sizeBytes,
        position: m.position,
      }));
  }
  return view;
}

async function getListing(pool, id) {
  const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Publish guards (M2): a public listing needs a real title and a real price. */
function publishProblem(listing) {
  if (!listing.title || !String(listing.title).trim()) return 'a title is required to publish';
  if (!Number.isInteger(listing.price_cents) || listing.price_cents <= 0) {
    return 'a price above zero is required to publish';
  }
  return null;
}

function validPrice(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Validate + normalize the music fields of a create/PATCH body against
 * the listing they will land on. Returns { error } or { fields } with
 * DB column names. Music is always type 'digital'; the medium itself
 * never changes after creation (a listing is born visual or music).
 */
function musicFields(body, base = {}) {
  const fields = {};
  if (body.releaseType !== undefined) {
    if (body.releaseType !== null && !RELEASE_TYPES.includes(body.releaseType)) {
      return { error: `releaseType must be one of: ${RELEASE_TYPES.join(', ')}` };
    }
    fields.release_type = body.releaseType;
  } else if (base.release_type !== undefined) fields.release_type = base.release_type;
  if (body.genre !== undefined) {
    fields.genre = typeof body.genre === 'string' ? body.genre.slice(0, 120) : null;
  }
  if (body.explicit !== undefined) fields.explicit = body.explicit === true;
  if (body.releaseDate !== undefined) {
    fields.release_date =
      typeof body.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.releaseDate)
        ? body.releaseDate
        : null;
  }
  if (body.artistCredit !== undefined) {
    fields.artist_credit = typeof body.artistCredit === 'string' ? body.artistCredit.slice(0, 200) : null;
  }
  if (body.contentKind !== undefined) {
    if (!CONTENT_KINDS.includes(body.contentKind)) {
      return { error: `contentKind must be one of: ${CONTENT_KINDS.join(', ')}` };
    }
    fields.content_kind = body.contentKind;
  }
  if (body.rightsRecording !== undefined) fields.rights_recording = body.rightsRecording === true;
  if (body.rightsComposition !== undefined) fields.rights_composition = body.rightsComposition === true;
  return { fields };
}

/**
 * The full publish gate for one listing: the M2 base guards, plus —
 * for music — the Sound gate (tracks, rights declaration, originals
 * hold, tier capacity, storage) evaluated by src/lib/music.js. A held
 * release has its rights_state persisted so the hold is a record, not
 * a toast. Returns an error message or null.
 */
async function publishGate(pool, listing) {
  const problem = publishProblem(listing);
  if (problem) return problem;
  if (listing.medium === 'music') {
    const { tier, entitledTier } = await artistFeeTier(pool, listing.account_id);
    const check = await musicPublishCheck(pool, { listing, tier, entitledTier });
    if (!check.ok) {
      if (check.held) {
        await pool.query(
          `UPDATE listings SET rights_state = 'held_for_review', updated_at = now() WHERE id = $1`,
          [listing.id],
        );
      }
      return check.reasons[0];
    }
  }
  return null;
}

export function registerListingsRoutes(app, pool) {
  const auth = requireAuth(pool);
  const softAuth = optionalAuth(pool);

  // POST /v1/listings — create a draft. Creating a listing is an artist
  // act: the artist role is granted server-side.
  app.post('/v1/listings', { preHandler: auth }, async (req, reply) => {
    const body = req.body || {};
    const medium = body.medium === undefined ? 'visual' : body.medium;
    if (!['visual', 'music'].includes(medium)) {
      return badRequest(reply, 'medium must be one of: visual, music');
    }
    // Music is delivered digitally by definition (Sound plan §4).
    const type = medium === 'music' ? 'digital' : body.type === undefined ? 'physical' : body.type;
    if (!LISTING_TYPES.includes(type)) {
      return badRequest(reply, `type must be one of: ${LISTING_TYPES.join(', ')}`);
    }
    if (body.priceCents !== undefined && body.priceCents !== null && !validPrice(body.priceCents)) {
      return badRequest(reply, 'priceCents must be a non-negative integer (cents)');
    }
    let mf = {};
    if (medium === 'music') {
      const parsed = musicFields(body);
      if (parsed.error) return badRequest(reply, parsed.error);
      mf = parsed.fields;
    }
    const { rows } = await pool.query(
      `INSERT INTO listings (account_id, title, description, category, price_cents, type, medium,
                             release_type, genre, explicit, release_date, artist_credit,
                             content_kind, rights_recording, rights_composition)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        req.account.id,
        typeof body.title === 'string' ? body.title.slice(0, 300) : null,
        typeof body.description === 'string' ? body.description.slice(0, 5000) : null,
        typeof body.category === 'string'
          ? body.category.slice(0, 120)
          : medium === 'music'
            ? 'Music'
            : null,
        body.priceCents ?? null,
        type,
        medium,
        mf.release_type ?? (medium === 'music' ? 'single' : null),
        mf.genre ?? null,
        mf.explicit ?? false,
        mf.release_date ?? null,
        mf.artist_credit ?? null,
        mf.content_kind ?? 'original',
        mf.rights_recording ?? false,
        mf.rights_composition ?? false,
      ],
    );
    await pool.query(
      `INSERT INTO account_roles (account_id, role) VALUES ($1, 'artist')
       ON CONFLICT DO NOTHING`,
      [req.account.id],
    );
    return reply.code(201).send({ listing: await listingView(pool, rows[0], req.account.id) });
  });

  // GET /v1/listings/:id — public when published; the owner always.
  // Reading a published piece records a view event (M4): the Studio's
  // views count traces to listing_views rows (src/lib/views.js).
  app.get('/v1/listings/:id', { preHandler: softAuth }, async (req, reply) => {
    const listing = await getListing(pool, req.params.id);
    if (!listing) return notFound(reply);
    const isOwner = req.account && req.account.id === listing.account_id;
    if (listing.status !== 'published' && !isOwner) return notFound(reply);
    if (listing.status === 'published') {
      await recordListingView(pool, listing, req.account?.id || null).catch(() => {});
    }
    return { listing: await listingView(pool, listing, req.account?.id || null) };
  });

  // PATCH /v1/listings/:id — owner-only field updates. Publishing through
  // PATCH passes the same guards as the publish endpoint.
  app.patch('/v1/listings/:id', { preHandler: auth }, async (req, reply) => {
    const listing = await getListing(pool, req.params.id);
    if (!listing || listing.account_id !== req.account.id) return notFound(reply);
    const body = req.body || {};

    const next = { ...listing };
    if (typeof body.title === 'string') next.title = body.title.slice(0, 300);
    if (typeof body.description === 'string') next.description = body.description.slice(0, 5000);
    if (typeof body.category === 'string') next.category = body.category.slice(0, 120);
    if (body.priceCents !== undefined) {
      if (body.priceCents !== null && !validPrice(body.priceCents)) {
        return badRequest(reply, 'priceCents must be a non-negative integer (cents)');
      }
      next.price_cents = body.priceCents;
    }
    if (body.type !== undefined) {
      if (!LISTING_TYPES.includes(body.type)) {
        return badRequest(reply, `type must be one of: ${LISTING_TYPES.join(', ')}`);
      }
      next.type = body.type;
    }
    if (listing.medium === 'music') {
      // A music listing stays digital whatever the body claims.
      next.type = 'digital';
      const parsed = musicFields(body, listing);
      if (parsed.error) return badRequest(reply, parsed.error);
      Object.assign(next, parsed.fields);
    }
    if (body.status !== undefined) {
      if (!LISTING_STATUSES.includes(body.status)) {
        return badRequest(reply, `status must be one of: ${LISTING_STATUSES.join(', ')}`);
      }
      if (body.status === 'published') {
        const problem = await publishGate(pool, next);
        if (problem) {
          return reply.code(422).send({ error: { code: 'publish_guard', message: problem } });
        }
      }
      next.status = body.status;
    }

    const { rows } = await pool.query(
      `UPDATE listings
          SET title = $1, description = $2, category = $3, price_cents = $4,
              type = $5, status = $6,
              release_type = $8, genre = $9, explicit = $10, release_date = $11,
              artist_credit = $12, content_kind = $13,
              rights_recording = $14, rights_composition = $15,
              published_at = CASE
                WHEN $6 = 'published' AND published_at IS NULL THEN now()
                ELSE published_at
              END,
              updated_at = now()
        WHERE id = $7
        RETURNING *`,
      [
        next.title,
        next.description,
        next.category,
        next.price_cents,
        next.type,
        next.status,
        listing.id,
        next.release_type ?? null,
        next.genre ?? null,
        next.explicit ?? false,
        next.release_date ?? null,
        next.artist_credit ?? null,
        next.content_kind ?? 'original',
        next.rights_recording ?? false,
        next.rights_composition ?? false,
      ],
    );
    return { listing: await listingView(pool, rows[0], req.account.id) };
  });

  // POST /v1/listings/:id/publish — owner-only, guarded.
  app.post('/v1/listings/:id/publish', { preHandler: auth }, async (req, reply) => {
    const listing = await getListing(pool, req.params.id);
    if (!listing || listing.account_id !== req.account.id) return notFound(reply);
    const problem = await publishGate(pool, listing);
    if (problem) {
      return reply.code(422).send({ error: { code: 'publish_guard', message: problem } });
    }
    const { rows } = await pool.query(
      `UPDATE listings
          SET status = 'published',
              published_at = COALESCE(published_at, now()),
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [listing.id],
    );
    return { listing: await listingView(pool, rows[0], req.account.id) };
  });

  // POST /v1/listings/:id/archive — owner-only.
  app.post('/v1/listings/:id/archive', { preHandler: auth }, async (req, reply) => {
    const listing = await getListing(pool, req.params.id);
    if (!listing || listing.account_id !== req.account.id) return notFound(reply);
    const { rows } = await pool.query(
      `UPDATE listings SET status = 'archived', updated_at = now()
        WHERE id = $1 RETURNING *`,
      [listing.id],
    );
    return { listing: await listingView(pool, rows[0], req.account.id) };
  });

  // GET /v1/artists/:accountId/listings — public: published only.
  app.get('/v1/artists/:accountId/listings', async (req) => {
    const { rows } = await pool.query(
      `SELECT * FROM listings
        WHERE account_id = $1 AND status = 'published'
        ORDER BY created_at DESC`,
      [req.params.accountId],
    );
    const listings = [];
    for (const row of rows) listings.push(await listingView(pool, row));
    return { listings };
  });

  // POST /v1/listings/:id/media — owner confirms an uploaded object and
  // attaches it. The key must live inside the OWNER's storage namespace:
  // an artist can never attach (or point a listing at) another artist's
  // objects.
  app.post('/v1/listings/:id/media', { preHandler: auth }, async (req, reply) => {
    const listing = await getListing(pool, req.params.id);
    if (!listing || listing.account_id !== req.account.id) return notFound(reply);
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key : '';
    if (!key) return badRequest(reply, 'Body requires key (the uploaded object key)');
    if (!keyInNamespace(key, req.account.id)) {
      return reply.code(403).send({
        error: { code: 'media_namespace', message: 'Object key is outside your storage namespace' },
      });
    }
    const kind = typeof body.kind === 'string' ? body.kind : 'image';
    if (!LISTING_MEDIA_KINDS.includes(kind)) {
      return badRequest(reply, `kind must be one of: ${LISTING_MEDIA_KINDS.join(', ')}`);
    }
    // Audio masters and release covers belong to music listings only;
    // images ride any listing (the M2 behavior).
    if ((kind === 'audio' || kind === 'cover') && listing.medium !== 'music') {
      return badRequest(reply, `kind '${kind}' attaches to music listings only`);
    }
    const title = typeof body.title === 'string' ? body.title.slice(0, 300) : null;
    const durationSec =
      Number.isInteger(body.durationSec) && body.durationSec >= 0 ? body.durationSec : null;
    const sizeBytes =
      Number.isInteger(body.sizeBytes) && body.sizeBytes >= 0 ? body.sizeBytes : 0;
    try {
      const { rows } = await pool.query(
        `INSERT INTO listing_media (listing_id, object_key, kind, position, title, duration_sec, size_bytes)
         VALUES ($1, $2, $3,
           (SELECT COALESCE(MAX(position) + 1, 0) FROM listing_media WHERE listing_id = $1),
           $4, $5, $6)
         RETURNING id, object_key, kind, position, title, duration_sec, size_bytes, created_at`,
        [listing.id, key, kind, title, durationSec, sizeBytes],
      );
      const row = rows[0];
      return reply.code(201).send({
        media: {
          id: row.id,
          key: row.object_key,
          kind: row.kind,
          position: row.position,
          title: row.title,
          durationSec: row.duration_sec,
          sizeBytes: Number(row.size_bytes) || 0,
          url: await presignDownload(row.object_key),
        },
      });
    } catch (err) {
      if (err.code === '23505') {
        return reply.code(409).send({
          error: { code: 'media_duplicate', message: 'That object is already attached to this listing' },
        });
      }
      throw err;
    }
  });
}
