// Music capacity + rights law (PAIRED-SOUND-PLAN §2/§3) — server-side.
// The SPA printed these caps on the upload screen in v64; the engine is
// now the authority. Capacity is a PUBLISH-state rule: an artist may
// draft freely, but a release publishes only while the artist's live
// (published) music catalog stays inside the tier's caps. The tier buys
// capacity and surface, never a better cut — music commission is 0% at
// every tier (src/lib/fees.js).
//
//   Solo     5 tracks OR 1 album · 1 GB masters
//   Paired   50 tracks / 10 albums · 10 GB
//   Ensemble unlimited tracks / albums · 50 GB
//   Founding rides Paired-tier capacity (its entitled tier).
//
// Solo's OR is literal (it mirrors the v64 publish gate the artists
// already read): a Solo artist may publish ONE album (any track count
// the album itself carries) while nothing else is live, OR up to 5
// tracks across non-album releases while no album is live.
//
// Storage accounting uses the DECLARED master sizes artists attach
// with each track (listing_media.size_bytes): presigning cannot weigh
// a file the client has not sent yet, so the declaration is the ledger
// — the same honesty posture as the v64 form, now enforced here.

export const GIB = 1024 * 1024 * 1024;

export const MUSIC_CAPS = Object.freeze({
  solo: Object.freeze({ tracks: 5, albums: 1, storageBytes: 1 * GIB, label: '5 tracks OR 1 album · 1 GB storage' }),
  paired: Object.freeze({ tracks: 50, albums: 10, storageBytes: 10 * GIB, label: '50 tracks / 10 albums · 10 GB storage' }),
  ensemble: Object.freeze({ tracks: Infinity, albums: Infinity, storageBytes: 50 * GIB, label: 'Unlimited tracks / albums · 50 GB storage' }),
  inner_circle: Object.freeze({ tracks: 0, albums: 0, storageBytes: 0, label: 'Collector tier — does not sell music' }),
});

export function isAlbumType(releaseType) {
  return releaseType === 'album' || releaseType === 'ep';
}

/** Caps for a membership tier; founding rides its entitled (Paired) caps. */
export function musicCapsForTier(tier, entitledTier) {
  const effective = tier === 'founding' ? entitledTier || 'paired' : tier;
  return MUSIC_CAPS[effective] || MUSIC_CAPS.solo;
}

/**
 * The artist's LIVE music usage: published music listings only (drafts
 * and archived releases hold no capacity — the v64 rule).
 * Returns { tracks, albums, releases, storageBytes }.
 */
export async function musicUsage(pool, accountId, { excludeListingId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT l.id, l.release_type,
            (SELECT count(*)::int FROM listing_media m
              WHERE m.listing_id = l.id AND m.kind = 'audio') AS track_count,
            (SELECT COALESCE(SUM(m.size_bytes), 0)::bigint FROM listing_media m
              WHERE m.listing_id = l.id AND m.kind = 'audio') AS storage_bytes
       FROM listings l
      WHERE l.account_id = $1 AND l.medium = 'music' AND l.status = 'published'
        AND ($2::uuid IS NULL OR l.id <> $2)`,
    [accountId, excludeListingId],
  );
  let tracks = 0;
  let albums = 0;
  let storageBytes = 0;
  for (const row of rows) {
    tracks += row.track_count || 0;
    if (isAlbumType(row.release_type)) albums += 1;
    storageBytes += Number(row.storage_bytes) || 0;
  }
  return { tracks, albums, releases: rows.length, storageBytes };
}

/** One release's own footprint: { tracks, storageBytes }. */
export async function releaseFootprint(pool, listingId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS track_count,
            COALESCE(SUM(size_bytes), 0)::bigint AS storage_bytes
       FROM listing_media WHERE listing_id = $1 AND kind = 'audio'`,
    [listingId],
  );
  return { tracks: rows[0]?.track_count || 0, storageBytes: Number(rows[0]?.storage_bytes) || 0 };
}

/**
 * The publish gate for a music listing, evaluated against live state.
 * Order mirrors the v64 gate the artists read: tracks exist →
 * declaration (both legs) → originals-only hold → capacity → storage.
 * Returns { ok, reasons: string[], held: boolean } — `held` marks the
 * originals-only rights hold (the listing's rights_state is set by the
 * caller when a publish attempt lands there).
 */
export async function musicPublishCheck(pool, { listing, tier, entitledTier }) {
  const caps = musicCapsForTier(tier, entitledTier);
  const own = await releaseFootprint(pool, listing.id);

  if (own.tracks < 1) {
    return { ok: false, held: false, reasons: ['A release needs at least one track — attach the master audio first.'] };
  }
  if (listing.rights_recording !== true || listing.rights_composition !== true) {
    return {
      ok: false,
      held: false,
      reasons: [
        'RIGHTS DECLARATION INCOMPLETE — a release publishes only with both legs declared: the recording AND the composition. The declaration is retained for the life of the account.',
      ],
    };
  }
  if (listing.content_kind && listing.content_kind !== 'original') {
    return {
      ok: false,
      held: true,
      reasons: [
        'ORIGINALS-ONLY AT LAUNCH — covers, samples and remixes HOLD for per-release rights review even with a declaration on file. This release is held; it does not publish on a declaration alone.',
      ],
    };
  }

  const used = await musicUsage(pool, listing.account_id, { excludeListingId: listing.id });
  const album = isAlbumType(listing.release_type);
  const effectiveTier = tier === 'founding' ? entitledTier || 'paired' : tier;
  let capacityOk;
  if (effectiveTier === 'solo') {
    capacityOk = album ? used.releases === 0 : used.tracks + own.tracks <= caps.tracks && used.albums === 0;
  } else {
    capacityOk =
      used.tracks + own.tracks <= caps.tracks &&
      used.albums + (album ? 1 : 0) <= caps.albums;
  }
  if (!capacityOk) {
    return {
      ok: false,
      held: false,
      reasons: [
        `CAPACITY — this tier holds ${caps.label}. This release would take you past it; free capacity or rise a tier and it publishes. The cap printed before you began is the cap that applies.`,
      ],
    };
  }
  if (used.storageBytes + own.storageBytes > caps.storageBytes) {
    return {
      ok: false,
      held: false,
      reasons: [
        `STORAGE — this tier holds ${caps.storageBytes / GIB} GB of masters. This release would take you past it.`,
      ],
    };
  }
  return { ok: true, held: false, reasons: [] };
}
