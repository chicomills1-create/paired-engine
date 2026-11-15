// S3-compatible object storage for artist media.
//
// Artists upload directly to storage with a presigned PUT issued here; the
// API never proxies file bytes. Object keys are namespaced per account —
// accounts/<account_id>/<uuid>.<ext> — and the listing-media route enforces
// that an artist can only attach keys inside their own namespace.
//
// Configuration (env): S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY, optional S3_ENDPOINT (any S3-compatible provider).
// If the configuration is incomplete, getS3Config() returns null and every
// upload leg fails closed (503 not_configured) — the same posture as Stripe.
// Signing is offline cryptography, so presigning works (and is tested)
// without a reachable bucket.
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const UPLOAD_CONTENT_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

export const UPLOAD_EXPIRES_IN = 900; // 15 minutes to complete the PUT.
export const DOWNLOAD_EXPIRES_IN = 3600; // 1 hour read URLs.

export function getS3Config() {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.S3_ENDPOINT || null,
  };
}

export function getS3() {
  const config = getS3Config();
  if (!config) return null;
  return {
    config,
    client: new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
  };
}

/** The namespace prefix every object key for this account must live under. */
export function keyNamespace(accountId) {
  return `accounts/${accountId}/`;
}

export function keyInNamespace(key, accountId) {
  return typeof key === 'string' && key.startsWith(keyNamespace(accountId));
}

/**
 * Issue a presigned PUT for a new media object owned by the account.
 * Returns { key, url, expiresIn } or null when storage is not configured.
 * Throws on a content type outside the allowlist.
 */
export async function presignUpload({ accountId, contentType } = {}) {
  const ext = UPLOAD_CONTENT_TYPES[contentType];
  if (!ext) {
    throw new Error(
      `presignUpload: content type '${contentType}' is not allowed (allowed: ${Object.keys(UPLOAD_CONTENT_TYPES).join(', ')})`,
    );
  }
  const s3 = getS3();
  if (!s3) return null;
  const key = `${keyNamespace(accountId)}${randomUUID()}.${ext}`;
  const url = await getSignedUrl(
    s3.client,
    new PutObjectCommand({ Bucket: s3.config.bucket, Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_EXPIRES_IN },
  );
  return { key, url, expiresIn: UPLOAD_EXPIRES_IN };
}

/**
 * Issue a presigned GET for reads. Returns the URL, or null when storage is
 * not configured (callers then serve the media entry without a URL).
 */
export async function presignDownload(key) {
  const s3 = getS3();
  if (!s3) return null;
  return getSignedUrl(
    s3.client,
    new GetObjectCommand({ Bucket: s3.config.bucket, Key: key }),
    { expiresIn: DOWNLOAD_EXPIRES_IN },
  );
}
