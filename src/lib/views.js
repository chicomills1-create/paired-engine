// Listing view events (M4) — the single writer behind every views count
// in the Studio. A view is a row in listing_views; counts always derive
// from the rows, never from a display or a cached counter.
//
// Rules: only published listings accrue views; the artist's own reads of
// their piece never count; a signed-in viewer's repeat views inside the
// dedupe window count once (the number should mean "people looked", not
// "a tab refreshed"); anonymous views always record (no identity to
// dedupe on).
export const VIEW_DEDUPE_MINUTES = 30;

export async function recordListingView(pool, listing, viewerId) {
  if (!listing || listing.status !== 'published') return { recorded: false, reason: 'not_published' };
  if (viewerId && viewerId === listing.account_id) {
    return { recorded: false, reason: 'own_listing' };
  }
  if (viewerId) {
    const { rows: recent } = await pool.query(
      `SELECT 1 FROM listing_views
        WHERE listing_id = $1 AND viewer_account_id = $2
          AND created_at > now() - ($3 || ' minutes')::interval
        LIMIT 1`,
      [listing.id, viewerId, String(VIEW_DEDUPE_MINUTES)],
    );
    if (recent.length) return { recorded: false, reason: 'recent_view' };
  }
  await pool.query(
    'INSERT INTO listing_views (listing_id, viewer_account_id) VALUES ($1, $2)',
    [listing.id, viewerId || null],
  );
  return { recorded: true };
}
