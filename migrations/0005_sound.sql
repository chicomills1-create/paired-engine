-- 0005_sound.sql — PAIRED engine SOUND build schema.
-- Music listings ride the existing listings / orders machinery (founder
-- scope order 2026-11-15: the FULL site at 100%, music included).
--
-- DESIGN: a RELEASE is a listing. `medium` discriminates the lane:
-- 'visual' (everything built in M2–M4) vs 'music'. A music listing is
-- always type='digital'; its TRACKS are listing_media rows of kind
-- 'audio' (title / duration_sec / size_bytes ride the media row), its
-- cover is a media row of kind 'cover' (or 'image'). An album or EP is
-- one listing (release_type 'album' | 'ep') carrying several audio
-- rows; a single is one listing carrying one. Orders, payments,
-- fulfillments, releases and the ledger therefore never fork: a music
-- order is a digital order whose fee snapshot is 0 (see fees.js) and
-- whose inventory never depletes (music is not one-of-one — checkout
-- skips the reservation for music and settlement never marks a music
-- listing sold; see checkout.js / stripeEvents.js).
--
-- Rights law (Sound plan §3): a release publishes only with BOTH legs
-- of the per-release rights declaration on file, and only originals
-- flow through at launch — covers / samples / remixes are HELD for
-- per-release rights review (rights_state), never published on a
-- declaration alone.
-- Money law (M0) holds: prices stay INTEGER CENTS on the listing row.

-- ---------------------------------------------------------------------------
-- Listings: the music discriminator + release metadata + rights record.
-- ---------------------------------------------------------------------------
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS medium text NOT NULL DEFAULT 'visual'
    CHECK (medium IN ('visual', 'music'));
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS release_type text
    CHECK (release_type IN ('single', 'ep', 'album'));
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS genre text;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS explicit boolean NOT NULL DEFAULT false;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS release_date date;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS artist_credit text;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS content_kind text NOT NULL DEFAULT 'original'
    CHECK (content_kind IN ('original', 'cover', 'sample', 'remix'));
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS rights_recording boolean NOT NULL DEFAULT false;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS rights_composition boolean NOT NULL DEFAULT false;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS rights_state text NOT NULL DEFAULT 'declared'
    CHECK (rights_state IN ('declared', 'held_for_review', 'cleared'));

CREATE INDEX IF NOT EXISTS listings_music_public_idx
  ON listings (created_at DESC)
  WHERE medium = 'music' AND status = 'published';
CREATE INDEX IF NOT EXISTS listings_medium_account_idx
  ON listings (account_id, medium, status);

-- ---------------------------------------------------------------------------
-- Listing media: tracks are media rows too. kind widens from image-only
-- to image | audio | cover; audio rows carry the track's title, its
-- duration and its declared master size (the storage-capacity ledger —
-- capacity is enforced server-side at publish, see src/lib/music.js).
-- ---------------------------------------------------------------------------
ALTER TABLE listing_media
  DROP CONSTRAINT IF EXISTS listing_media_kind_check;
ALTER TABLE listing_media
  ADD CONSTRAINT listing_media_kind_check
  CHECK (kind IN ('image', 'audio', 'cover'));
ALTER TABLE listing_media
  ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE listing_media
  ADD COLUMN IF NOT EXISTS duration_sec integer
    CHECK (duration_sec IS NULL OR duration_sec >= 0);
ALTER TABLE listing_media
  ADD COLUMN IF NOT EXISTS size_bytes bigint NOT NULL DEFAULT 0
    CHECK (size_bytes >= 0);
