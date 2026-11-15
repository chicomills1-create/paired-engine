// Support — the Ask Paired question record (mailto-class cure, desk
// order 2026-11-15).
//
// Before this module, the Ask Paired form on pairedart.com kept the
// question in the visitor's own localStorage and handed off through a
// mailto: link — nothing reached PAIRED unless the visitor's mail app
// opened and they pressed send, yet the ack claimed the question was
// "on its way to a human." Now the form POSTs here: the question is a
// server record with a reference (ASK-XXXXXX, the house PAIRED-XXXXXX
// style) the ack quotes and ops reads back through the admin leg.
//
// POST /v1/support/ask is PUBLIC by design — Ask Paired is a public
// surface and most askers are signed out. Validation is strict and
// boring: presence, sane lengths, email shape. The admin read rides
// the same guard as every other admin surface (requireAuth +
// requireRole('admin')).
import { randomInt } from 'node:crypto';
import { requireAuth, requireRole } from '../auth.js';

// Unambiguous alphabet: no 0/O, 1/I/L — a reference read aloud or typed
// from a screenshot can never be mis-copied into a look-alike.
const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REFERENCE_ATTEMPTS = 8;

export function generateReference() {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `ASK-${suffix}`;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMITS = { name: 120, email: 254, question: 4000 };

function badRequest(reply, code, message) {
  return reply.code(400).send({ error: { code, message } });
}

function questionView(row) {
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    email: row.email,
    question: row.question,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function registerSupportRoutes(app, pool) {
  // POST /v1/support/ask — public. Stores the question, returns the
  // reference. 201 { reference } on success; 400 on any validation
  // failure (nothing is stored for a rejected question).
  app.post('/v1/support/ask', async (req, reply) => {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const question = typeof body.question === 'string' ? body.question.trim() : '';

    if (!name) return badRequest(reply, 'name_required', 'Your name is required');
    if (name.length > LIMITS.name) {
      return badRequest(reply, 'name_too_long', `Name must be ${LIMITS.name} characters or fewer`);
    }
    if (!email) return badRequest(reply, 'email_required', 'Your email is required');
    if (email.length > LIMITS.email || !EMAIL_SHAPE.test(email)) {
      return badRequest(reply, 'email_invalid', 'That email address does not look complete');
    }
    if (!question) return badRequest(reply, 'question_required', 'Your question is required');
    if (question.length > LIMITS.question) {
      return badRequest(reply, 'question_too_long', `Question must be ${LIMITS.question} characters or fewer`);
    }

    // Reference uniqueness: the column is UNIQUE; generate-and-insert
    // with a bounded retry on the (astronomically unlikely) collision.
    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
      const reference = generateReference();
      try {
        const { rows } = await pool.query(
          `INSERT INTO support_questions (reference, name, email, question)
           VALUES ($1, $2, $3, $4)
           RETURNING id, reference, created_at`,
          [reference, name, email, question],
        );
        return reply.code(201).send({
          reference: rows[0].reference,
          id: rows[0].id,
          createdAt: rows[0].created_at,
        });
      } catch (err) {
        if (err && err.code === '23505' && attempt < REFERENCE_ATTEMPTS - 1) continue;
        throw err;
      }
    }
    // Unreachable in practice (the loop returns or throws); fail closed.
    return reply.code(500).send({
      error: { code: 'reference_unavailable', message: 'Could not issue a reference — please try again' },
    });
  });

  // GET /v1/admin/support/questions — admin role only, newest first.
  // ?status= reads one status exactly; default is every question.
  const gate = [requireAuth(pool), requireRole('admin')];
  app.get('/v1/admin/support/questions', { preHandler: gate }, async (req) => {
    const status = typeof req.query?.status === 'string' ? req.query.status : null;
    const { rows } = status
      ? await pool.query(
          `SELECT id, reference, name, email, question, status, created_at
             FROM support_questions
            WHERE status = $1
            ORDER BY created_at DESC LIMIT 200`,
          [status],
        )
      : await pool.query(
          `SELECT id, reference, name, email, question, status, created_at
             FROM support_questions
            ORDER BY created_at DESC LIMIT 200`,
        );
    return { questions: rows.map(questionView) };
  });
}
