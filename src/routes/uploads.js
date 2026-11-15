// Uploads: presigned direct-to-storage PUTs.
//
// The API issues a short-lived presigned URL; the client uploads the file
// bytes straight to storage and then confirms the object by attaching its
// key to a listing (POST /v1/listings/:id/media). Fails closed with 503
// not_configured when storage env is absent — the same posture as Stripe.
//
// Kinds: 'image' (the M2 door — artwork photos and release covers) and
// 'audio' (Sound masters), each with its own content-type allowlist in
// src/lib/storage.js. The kind defaults to 'image' so every existing
// caller keeps its exact behavior.
import { requireAuth } from '../auth.js';
import { presignUpload, UPLOAD_KINDS } from '../lib/storage.js';

export function registerUploadsRoutes(app, pool) {
  const auth = requireAuth(pool);

  // POST /v1/uploads/presign — body { contentType, kind? } → { key, url, expiresIn, kind }.
  app.post('/v1/uploads/presign', { preHandler: auth }, async (req, reply) => {
    const kind = typeof req.body?.kind === 'string' ? req.body.kind : 'image';
    const allowlist = UPLOAD_KINDS[kind];
    if (!allowlist) {
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: `kind must be one of: ${Object.keys(UPLOAD_KINDS).join(', ')}`,
        },
      });
    }
    const contentType = typeof req.body?.contentType === 'string' ? req.body.contentType : '';
    if (!allowlist[contentType]) {
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: `contentType must be one of: ${Object.keys(allowlist).join(', ')}`,
        },
      });
    }
    const issued = await presignUpload({ accountId: req.account.id, contentType, kind });
    if (!issued) {
      return reply.code(503).send({
        error: { code: 'not_configured', message: 'Media storage is not configured yet' },
      });
    }
    return { ...issued, kind };
  });
}
