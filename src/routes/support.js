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
//
// The ChatGPT ASK controls (2026-11-15) and how this module meets them:
// ASK-01 (abuse) — validation above, a link-stuffing rule (a question
//   is prose, not a link farm), and a per-source sliding-window cap on
//   STORED questions. The cap is in-process by design: the API runs as
//   a single instance, and validation + duplicate suppression bound
//   what any write can be.
// ASK-02 (privacy) — a row stores exactly what the form asks: the
//   visitor's stated name, email, and question, plus the reference and
//   a status. There is NO read path keyed by the reference — it is a
//   receipt the visitor quotes back to a human, never a lookup
//   capability; the only read is the admin-guarded list below.
//   Anonymous submissions are NOT accepted: name + email are required,
//   so every question carries a reply address ops can answer. That is
//   the policy, and validation enforces it.
// ASK-03 (durable ack) — the reference is generated server-side from a
//   CSPRNG, is UNIQUE in the table, and is returned only after the
//   INSERT commits, so the ack can never quote a reference that is not
//   a stored record. A client retry of the same question (same email +
//   identical text inside a short window) returns the ORIGINAL
//   reference instead of storing a second record — see the duplicate
//   suppression in the POST.
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

// ASK-01 spam shape: more than a few links in one question is a link
// farm, not a question. (match() with a /g pattern is stateless; the
// name check uses its own non-global literal for the same reason.)
const LINK_PATTERN = /(https?:\/\/|www\.)/gi;
const MAX_QUESTION_LINKS = 3;

// ASK-01 rate shape: a per-source sliding window over stored
// questions — generous for a human (nobody asks twenty support
// questions in ten minutes), a hard ceiling for a write flood.
const WRITE_WINDOW_MS = 10 * 60 * 1000;
const WRITE_MAX_PER_WINDOW = 20;
const writeLog = new Map();

function recentWrites(source, now) {
  const kept = (writeLog.get(source) || []).filter((t) => now - t < WRITE_WINDOW_MS);
  if (kept.length) writeLog.set(source, kept);
  else writeLog.delete(source);
  return kept;
}

// Seconds until this source may store another question (0 = may write).
function writeRetryAfterSeconds(source) {
  const now = Date.now();
  const kept = recentWrites(source, now);
  if (kept.length < WRITE_MAX_PER_WINDOW) return 0;
  return Math.max(1, Math.ceil((kept[0] + WRITE_WINDOW_MS - now) / 1000));
}

function recordWrite(source) {
  const now = Date.now();
  const kept = recentWrites(source, now);
  kept.push(now);
  writeLog.set(source, kept);
  // Bound memory on a long-lived process: sweep dead sources when the
  // map grows past a size no real traffic pattern justifies.
  if (writeLog.size > 5000) {
    for (const key of [...writeLog.keys()]) recentWrites(key, now);
  }
}

// ASK-03 duplicate shape: a client retry (double-click, a response
// lost in transit, a resubmit) re-sends the SAME email + question
// seconds later. Inside this window an identical pair is the same
// question, not a new one.
const DUPLICATE_WINDOW_SECONDS = 120;
const DUPLICATE_LOOKUP = `SELECT id, reference, created_at FROM support_questions
  WHERE lower(email) = lower($1) AND question = $2
    AND created_at > now() - ($3 || ' seconds')::interval
  ORDER BY created_at DESC LIMIT 1`;

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
  // reference. 201 { reference } on success; 200 with the ORIGINAL
  // reference when the submit is a retry of a just-stored question;
  // 400 on any validation failure (nothing is stored for a rejected
  // question); 429 when the source is storing questions too quickly.
  app.post('/v1/support/ask', async (req, reply) => {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const question = typeof body.question === 'string' ? body.question.trim() : '';

    if (!name) return badRequest(reply, 'name_required', 'Your name is required');
    if (name.length > LIMITS.name) {
      return badRequest(reply, 'name_too_long', `Name must be ${LIMITS.name} characters or fewer`);
    }
    if (/(https?:\/\/|www\.)/i.test(name)) {
      return badRequest(reply, 'name_invalid', 'That name does not look right');
    }
    if (!email) return badRequest(reply, 'email_required', 'Your email is required');
    if (email.length > LIMITS.email || !EMAIL_SHAPE.test(email)) {
      return badRequest(reply, 'email_invalid', 'That email address does not look complete');
    }
    if (!question) return badRequest(reply, 'question_required', 'Your question is required');
    if (question.length > LIMITS.question) {
      return badRequest(reply, 'question_too_long', `Question must be ${LIMITS.question} characters or fewer`);
    }
    if ((question.match(LINK_PATTERN) || []).length > MAX_QUESTION_LINKS) {
      return badRequest(
        reply,
        'too_many_links',
        'That reads as a list of links rather than a question — please describe it in your own words',
      );
    }

    const source = req.ip || 'unknown';

    // ASK-03 fast path: an identical retry gets the original receipt —
    // no second record, and no write-quota spent on it.
    const prior = await pool.query(DUPLICATE_LOOKUP, [
      email, question, String(DUPLICATE_WINDOW_SECONDS),
    ]);
    if (prior.rows[0]) {
      const row = prior.rows[0];
      return reply.code(200).send({
        reference: row.reference, id: row.id, createdAt: row.created_at, duplicate: true,
      });
    }

    // ASK-01: the write quota. Validation failures and deduped retries
    // never reach this line; only real writes count against it.
    const retryAfter = writeRetryAfterSeconds(source);
    if (retryAfter > 0) {
      return reply.code(429).header('Retry-After', String(retryAfter)).send({
        error: {
          code: 'rate_limited',
          message: 'You are sending questions too quickly — please wait a few minutes and try again',
        },
      });
    }

    // The insert runs in a transaction: an advisory lock keyed on the
    // asker serializes simultaneous identical submits, the duplicate
    // check repeats under the lock (closing the race the fast path
    // cannot), and the reference is returned only after COMMIT — the
    // ack can never quote a reference that is not a stored record
    // (ASK-03). Reference uniqueness: the column is UNIQUE;
    // generate-and-insert retries the whole transaction on the
    // (astronomically unlikely) collision.
    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `support-ask:${email.toLowerCase()}`,
        ]);
        const dup = await client.query(DUPLICATE_LOOKUP, [
          email, question, String(DUPLICATE_WINDOW_SECONDS),
        ]);
        if (dup.rows[0]) {
          await client.query('COMMIT');
          const row = dup.rows[0];
          return reply.code(200).send({
            reference: row.reference, id: row.id, createdAt: row.created_at, duplicate: true,
          });
        }
        const reference = generateReference();
        const { rows } = await client.query(
          `INSERT INTO support_questions (reference, name, email, question)
           VALUES ($1, $2, $3, $4)
           RETURNING id, reference, created_at`,
          [reference, name, email, question],
        );
        await client.query('COMMIT');
        recordWrite(source);
        return reply.code(201).send({
          reference: rows[0].reference,
          id: rows[0].id,
          createdAt: rows[0].created_at,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23505' && attempt < REFERENCE_ATTEMPTS - 1) continue;
        throw err;
      } finally {
        client.release();
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
