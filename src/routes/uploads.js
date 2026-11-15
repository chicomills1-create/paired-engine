// Uploads: presigned direct-to-storage PUTs.
//
// The API issues a short-lived presigned URL; the client uploads the file
// bytes straight to storage and then confirms the object by attaching its
// key to a listing (POST /v1/listings/:id/media). Fails closed with 503
// not_configured when storage env is absent — the same posture as Stripe.
import { requireAuth } from '../auth.js';
import { presignUpload, UPLOAD_CONTENT_TYPES } from '../lib/storage.js';

export function registerUploadsRoutes(app, pool) {
  const auth = requireAuth(pool);

  // POST /v1/uploads/presign — body { contentType } → { key, url, expiresIn }.
  app.post('/v1/uploads/presign', { preHandler: auth }, async (req, reply) => {
    const contentType = typeof req.body?.contentType === 'string' ? req.body.contentType : '';
    if (!UPLOAD_CONTENT_TYPES[contentType]) {
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: `contentType must be one of: ${Object.keys(UPLOAD_CONTENT_TYPES).join(', ')}`,
        },
      });
    }
    const issued = await presignUpload({ accountId: req.account.id, contentType });
    if (!issued) {
      return reply.code(503).send({
        error: { code: 'not_configured', message: 'Media storage is not configured yet' },
      });
    }
    return issued;
  });
}
