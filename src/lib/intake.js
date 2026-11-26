// Intake layer (v91) — the unified submission record.
//
// ChatGPT verdict of record: REVIEW-VERDICT-V91-2026-11-26. The rules
// this module enforces:
//  - Write-through + atomic (A1): canonical record + intake record +
//    reference + initial event commit in ONE transaction. Every helper
//    here takes a transaction client; there is no pool-level write path.
//  - Canonical ownership (A2): intake owns reference / category /
//    receipt / review state / customer history. Business tables own
//    content, publication, acceptance and execution.
//  - References (A3): CSPRNG, 'PAIRED-' + 10 unambiguous chars.
//  - Idempotency (A4): explicit scope + key for accounts AND guests.
//    Same key + same payload → the original. Same key + different
//    payload → 409 idempotency_conflict.
//  - Status machines (verdict §C amendment): applications, briefs and
//    proposals each have their OWN machine, enforced here; an illegal
//    transition is a 409, never a silent write. A proposal being
//    RECEIVED never advances its brief — briefs move to
//    PROPOSALS_RECEIVED only on the explicit share event.
//  - Privacy (§D4): payloads are validated against per-type field
//    allowlists with caps; unknown fields are stripped, never stored.
import { createHash, randomInt } from 'node:crypto';

export const INTAKE_TYPES = ['artist', 'collector', 'collaboration', 'brief', 'proposal', 'founding'];

// Customer-facing labels — verdict §C dictionary, verbatim. Internal
// codes use underscores; the dictionary is the only place labels live.
export const STATUS_LABELS = {
  RECEIVED: 'Received by PAIRED',
  UNDER_REVIEW: 'Under review',
  ACTION_REQUIRED: 'Your response is needed',
  APPROVED: 'Approved',
  DECLINED: 'Not approved',
  CLOSED: 'Closed',
  VISIBLE: 'Published on the Commission Board',
  PROPOSALS_RECEIVED: 'Artist proposals received',
  IN_DISCUSSION: 'In discussion',
  ACCEPTED: 'Proposal accepted',
  IN_PROGRESS: 'Work in progress',
  DELIVERED: 'Marked delivered',
  SHARED_WITH_BUYER: 'Shared with buyer',
  WITHDRAWN: 'Withdrawn',
};
// Proposal labels differ where the verdict's proposal table says so.
export const PROPOSAL_STATUS_LABELS = {
  RECEIVED: 'Received',
  SHARED_WITH_BUYER: 'Shared with buyer',
  ACCEPTED: 'Accepted',
  DECLINED: 'Not selected',
  WITHDRAWN: 'Withdrawn',
};

export const APPLICATION_TRANSITIONS = {
  RECEIVED: ['UNDER_REVIEW', 'ACTION_REQUIRED', 'DECLINED', 'CLOSED'],
  UNDER_REVIEW: ['ACTION_REQUIRED', 'APPROVED', 'DECLINED', 'CLOSED'],
  ACTION_REQUIRED: ['UNDER_REVIEW', 'APPROVED', 'DECLINED', 'CLOSED'],
  APPROVED: ['CLOSED'],
  DECLINED: ['CLOSED'],
  CLOSED: [],
};
export const BRIEF_TRANSITIONS = {
  RECEIVED: ['VISIBLE', 'ACCEPTED', 'CLOSED'],
  VISIBLE: ['PROPOSALS_RECEIVED', 'IN_DISCUSSION', 'ACCEPTED', 'CLOSED'],
  PROPOSALS_RECEIVED: ['IN_DISCUSSION', 'ACCEPTED', 'CLOSED'],
  IN_DISCUSSION: ['ACCEPTED', 'PROPOSALS_RECEIVED', 'CLOSED'],
  ACCEPTED: ['IN_PROGRESS', 'CLOSED'],
  IN_PROGRESS: ['DELIVERED', 'CLOSED'],
  DELIVERED: ['CLOSED'],
  CLOSED: [],
};
export const PROPOSAL_TRANSITIONS = {
  RECEIVED: ['SHARED_WITH_BUYER', 'WITHDRAWN', 'DECLINED'],
  SHARED_WITH_BUYER: ['ACCEPTED', 'DECLINED', 'WITHDRAWN'],
  ACCEPTED: [],
  DECLINED: [],
  WITHDRAWN: [],
};
export function transitionsFor(type) {
  if (type === 'brief') return BRIEF_TRANSITIONS;
  if (type === 'proposal') return PROPOSAL_TRANSITIONS;
  return APPLICATION_TRANSITIONS;
}

// Brief states in which the brief is public on the Board (publication
// approved). A brief with NO intake record is grandfathered to its
// canonical status instead (migration 0009 legacy policy).
export const BRIEF_PUBLIC_STATES = [
  'VISIBLE',
  'PROPOSALS_RECEIVED',
  'IN_DISCUSSION',
  'ACCEPTED',
  'IN_PROGRESS',
  'DELIVERED',
];

// Per-type payload allowlists (§D4: JSONB is not a dumping ground).
// kind: 'string' | 'integer' | 'boolean'; max = string length / value cap.
const S = (max, required = false) => ({ kind: 'string', max, required });
const I = (max, required = false) => ({ kind: 'integer', max, required });
export const PAYLOAD_SCHEMAS = {
  artist: {
    name: S(120, true),
    category: S(120),
    work: S(2000),
    commissions: S(120),
    why: S(2000),
    note: S(2000),
  },
  collector: {
    name: S(120, true),
    interest: S(2000),
  },
  collaboration: {
    name: S(120, true),
    craft: S(500),
    pairWith: S(500),
    interest: S(2000),
  },
  brief: {
    title: S(200, true),
    description: S(5000),
    budgetCents: I(100000000, true),
    category: S(120),
    deliverableType: S(20),
    size: S(120),
    timeline: S(120),
    deadline: S(40),
    briefType: S(20),
  },
  proposal: {
    priceCents: I(100000000, true),
    message: S(4000),
    items: { kind: 'json', max: 8000 },
    days: I(3650),
    revisions: I(100),
  },
  founding: {
    note: S(2000),
  },
};
export const PAYLOAD_MAX_BYTES = 16384;

export function intakeError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validEmail(email) {
  return email.length <= 254 && EMAIL_SHAPE.test(email);
}

/** Validate + sanitize a payload against the type's allowlist. */
export function validatePayload(type, raw) {
  const schema = PAYLOAD_SCHEMAS[type];
  if (!schema) throw intakeError(400, 'bad_request', `Unknown intake type: ${type}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw intakeError(400, 'bad_request', 'A submission payload object is required');
  }
  const payload = {};
  for (const [field, rule] of Object.entries(schema)) {
    const value = raw[field];
    if (value === undefined || value === null || value === '') {
      if (rule.required) throw intakeError(400, 'bad_request', `${field} is required`);
      continue;
    }
    if (rule.kind === 'string') {
      if (typeof value !== 'string') throw intakeError(400, 'bad_request', `${field} must be text`);
      const trimmed = value.trim();
      if (trimmed.length > rule.max) {
        throw intakeError(400, 'bad_request', `${field} is too long (max ${rule.max} characters)`);
      }
      if (trimmed) payload[field] = trimmed;
      else if (rule.required) throw intakeError(400, 'bad_request', `${field} is required`);
    } else if (rule.kind === 'integer') {
      if (!Number.isInteger(value) || value <= 0 || value > rule.max) {
        throw intakeError(400, 'bad_request', `${field} must be a positive integer no greater than ${rule.max}`);
      }
      payload[field] = value;
    } else if (rule.kind === 'json') {
      const text = JSON.stringify(value);
      if (text.length > rule.max) throw intakeError(400, 'bad_request', `${field} is too large`);
      payload[field] = value;
    }
  }
  if (JSON.stringify(payload).length > PAYLOAD_MAX_BYTES) {
    throw intakeError(400, 'bad_request', 'Submission payload is too large');
  }
  return payload;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function payloadHash(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

// Unambiguous alphabet (no 0/O, 1/I/L) — same house style as support.js.
const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateReference() {
  let suffix = '';
  for (let i = 0; i < 10; i += 1) {
    suffix += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `PAIRED-${suffix}`;
}

/**
 * Idempotency gate + insert, INSIDE the caller's transaction.
 * Returns { submission, duplicate } — duplicate=true means the original
 * submission for this scope+key+payload already exists and the caller
 * must return it WITHOUT writing anything new. Throws 409 when the key
 * was used with a different payload.
 */
export async function createIntake(client, fields) {
  const {
    type,
    ownerAccountId = null,
    contactEmail = null,
    payload,
    consentAt = null,
    source = 'site',
    idempotencyScope,
    idempotencyKey,
    canonicalTable = null,
    canonicalId = null,
    linkedSubmissionId = null,
    isLegacy = false,
  } = fields;
  const hash = payloadHash(payload);

  const { rows: existing } = await client.query(
    'SELECT * FROM intake_submissions WHERE idempotency_scope = $1 AND idempotency_key = $2',
    [idempotencyScope, idempotencyKey],
  );
  if (existing.length) {
    if (existing[0].payload_hash !== hash) {
      throw intakeError(
        409,
        'idempotency_conflict',
        'This idempotency key was already used with a different submission',
      );
    }
    return { submission: existing[0], duplicate: true };
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const reference = generateReference();
    // A savepoint per attempt: a unique-violation inside an explicit
    // transaction aborts it, so the reference retry must be able to
    // roll back to here and try again on the same client.
    await client.query('SAVEPOINT intake_insert');
    try {
      const { rows } = await client.query(
        `INSERT INTO intake_submissions
           (reference, type, owner_account_id, contact_email, status, payload,
            payload_hash, consent_at, source, idempotency_scope, idempotency_key,
            canonical_table, canonical_id, linked_submission_id, is_legacy)
         VALUES ($1, $2, $3, $4, 'RECEIVED', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          reference,
          type,
          ownerAccountId,
          contactEmail,
          JSON.stringify(payload),
          hash,
          consentAt,
          source,
          idempotencyScope,
          idempotencyKey,
          canonicalTable,
          canonicalId,
          linkedSubmissionId,
          isLegacy,
        ],
      );
      const submission = rows[0];
      await client.query(
        `INSERT INTO intake_events (submission_id, actor_type, kind, from_status, to_status, note)
         VALUES ($1, $2, 'received', NULL, 'RECEIVED', $3)`,
        [
          submission.id,
          ownerAccountId ? 'customer' : 'system',
          isLegacy ? 'Historical record attached to the intake layer.' : 'Submission received by PAIRED.',
        ],
      );
      await client.query('RELEASE SAVEPOINT intake_insert');
      return { submission, duplicate: false };
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT intake_insert');
      await client.query('RELEASE SAVEPOINT intake_insert');
      if (err.code === '23505' && /reference/.test(err.constraint || '')) {
        lastErr = err; // reference collision — astronomically unlikely; retry
        continue;
      }
      if (err.code === '23505') {
        // Idempotency race: another writer committed the same key first.
        const { rows: raced } = await client.query(
          'SELECT * FROM intake_submissions WHERE idempotency_scope = $1 AND idempotency_key = $2',
          [idempotencyScope, idempotencyKey],
        );
        if (raced.length) {
          if (raced[0].payload_hash !== hash) {
            throw intakeError(
              409,
              'idempotency_conflict',
              'This idempotency key was already used with a different submission',
            );
          }
          return { submission: raced[0], duplicate: true };
        }
      }
      throw err;
    }
  }
  throw lastErr || new Error('reference generation failed');
}

/**
 * Find the intake record attached to a canonical record, or null.
 * Legacy canonical records (pre-0009) have none — by documented policy.
 */
export async function intakeForCanonical(client, canonicalTable, canonicalId) {
  const { rows } = await client.query(
    'SELECT * FROM intake_submissions WHERE canonical_table = $1 AND canonical_id = $2',
    [canonicalTable, canonicalId],
  );
  return rows[0] || null;
}

/**
 * Attach an intake record to a canonical record created in the SAME
 * transaction (the write-through path used by the canonical routes
 * themselves). If one already exists, it is returned unchanged.
 */
export async function attachIntake(client, fields) {
  const existing = await intakeForCanonical(client, fields.canonicalTable, fields.canonicalId);
  if (existing) return { submission: existing, duplicate: true };
  return createIntake(client, fields);
}

/**
 * The one legal way to move a submission's status. Locks the row,
 * checks the type's machine, updates, and writes the audit event — all
 * on the caller's transaction client. `force` is reserved for the
 * compensation mirror in commissions.js (a system restore after a
 * failed award) and still writes its event.
 */
export async function transitionIntake(client, {
  id,
  to,
  actorType,
  actorAccountId = null,
  note = null,
  kind = 'status',
  actionNote = undefined,
  closeReason = undefined,
  force = false,
}) {
  const { rows } = await client.query('SELECT * FROM intake_submissions WHERE id = $1 FOR UPDATE', [id]);
  if (!rows.length) throw intakeError(404, 'not_found', 'Submission not found');
  const sub = rows[0];
  if (sub.status === to) return { submission: sub, unchanged: true };
  const machine = transitionsFor(sub.type);
  const legal = (machine[sub.status] || []).includes(to);
  if (!legal && !force) {
    throw intakeError(
      409,
      'invalid_transition',
      `A ${sub.type} submission in state ${sub.status} cannot move to ${to}`,
    );
  }
  const { rows: updated } = await client.query(
    `UPDATE intake_submissions
        SET status = $2,
            action_note = CASE WHEN $3::boolean THEN $4 ELSE action_note END,
            close_reason = CASE WHEN $5::boolean THEN $6 ELSE close_reason END,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, to, actionNote !== undefined, actionNote, closeReason !== undefined, closeReason],
  );
  await client.query(
    `INSERT INTO intake_events (submission_id, actor_type, actor_account_id, kind, from_status, to_status, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, actorType, actorAccountId, kind, sub.status, to, note],
  );
  return { submission: updated[0], unchanged: false };
}

/** Append a non-status event (note / assignment) — still audited. */
export async function appendIntakeEvent(client, { id, actorType, actorAccountId = null, kind, note }) {
  const { rows } = await client.query('SELECT status FROM intake_submissions WHERE id = $1', [id]);
  if (!rows.length) throw intakeError(404, 'not_found', 'Submission not found');
  await client.query(
    `INSERT INTO intake_events (submission_id, actor_type, actor_account_id, kind, from_status, to_status, note)
     VALUES ($1, $2, $3, $4, $5, $5, $6)`,
    [id, actorType, actorAccountId, kind, rows[0].status, note],
  );
}

export function statusLabelFor(type, status) {
  if (type === 'proposal') return PROPOSAL_STATUS_LABELS[status] || STATUS_LABELS[status] || status;
  if (status === 'ACCEPTED' && type === 'brief') return 'Proposal accepted';
  return STATUS_LABELS[status] || status;
}

/** Customer view: their own record — reference, status, action ask. */
export function submissionView(row) {
  return {
    reference: row.reference,
    type: row.type,
    status: row.status,
    statusLabel: statusLabelFor(row.type, row.status),
    receivedAt: row.created_at,
    updatedAt: row.updated_at,
    actionNote: row.status === 'ACTION_REQUIRED' ? row.action_note : null,
    payload: row.payload,
    canonicalId: row.canonical_id,
    legacy: row.is_legacy === true,
  };
}

/** Desk view: everything ops needs, including owner + assignment. */
export function deskSubmissionView(row) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    status: row.status,
    statusLabel: statusLabelFor(row.type, row.status),
    ownerAccountId: row.owner_account_id,
    contactEmail: row.contact_email,
    payload: row.payload,
    consentAt: row.consent_at,
    source: row.source,
    canonicalTable: row.canonical_table,
    canonicalId: row.canonical_id,
    linkedSubmissionId: row.linked_submission_id,
    assignedTo: row.assigned_to,
    actionNote: row.action_note,
    closeReason: row.close_reason,
    legacy: row.is_legacy === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function intakeEventView(row) {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorAccountId: row.actor_account_id,
    kind: row.kind,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    createdAt: row.created_at,
  };
}

/**
 * Mark a proposal SHARED_WITH_BUYER — the explicit share event the
 * verdict requires before acceptance. In the canonical system the
 * buyer reads pitches on their brief page; that read IS the delivery
 * to the buyer, so the pitches-list read calls this for every
 * not-yet-shared proposal. The first share on a published brief also
 * advances the brief VISIBLE → PROPOSALS_RECEIVED (never further, and
 * never from a mere receipt).
 */
export async function shareProposalWithBuyer(client, proposalSubmissionId, buyerAccountId) {
  const { rows: cur } = await client.query('SELECT status FROM intake_submissions WHERE id = $1', [
    proposalSubmissionId,
  ]);
  if (!cur.length) throw intakeError(404, 'not_found', 'Submission not found');
  if (cur[0].status !== 'RECEIVED') {
    const { rows } = await client.query('SELECT * FROM intake_submissions WHERE id = $1', [
      proposalSubmissionId,
    ]);
    return rows[0];
  }
  const { submission } = await transitionIntake(client, {
    id: proposalSubmissionId,
    to: 'SHARED_WITH_BUYER',
    actorType: 'customer',
    actorAccountId: buyerAccountId,
    note: 'Shared with the buyer — the proposal is on the brief for their decision.',
  });
  if (submission.linked_submission_id) {
    const { rows } = await client.query('SELECT * FROM intake_submissions WHERE id = $1', [
      submission.linked_submission_id,
    ]);
    const briefSub = rows[0];
    if (briefSub && briefSub.status === 'VISIBLE') {
      await transitionIntake(client, {
        id: briefSub.id,
        to: 'PROPOSALS_RECEIVED',
        actorType: 'system',
        note: 'Artist proposals received — a proposal was shared with the buyer.',
      });
    }
  }
  return submission;
}

/**
 * Mirror of the canonical award (commissions.js, SAME transaction):
 * the accepted proposal moves to ACCEPTED (through SHARED_WITH_BUYER
 * if the buyer accepted without a recorded share — the acceptance is
 * itself the delivery proof, and both events stay on the trail), the
 * competing proposals the award declined move to DECLINED, and the
 * brief moves to ACCEPTED. Legacy records without intake rows are
 * skipped silently — they live on the canonical path alone.
 */
export async function mirrorPitchAward(client, { briefId, pitchId }) {
  const prop = await intakeForCanonical(client, 'pitches', pitchId);
  if (prop) {
    if (prop.status === 'RECEIVED') {
      await transitionIntake(client, {
        id: prop.id,
        to: 'SHARED_WITH_BUYER',
        actorType: 'customer',
        note: 'Shared with the buyer — proven by their acceptance.',
      });
    }
    await transitionIntake(client, {
      id: prop.id,
      to: 'ACCEPTED',
      actorType: 'customer',
      note: 'Proposal accepted by the brief owner — the commission order was created.',
    });
  }
  const { rows: others } = await client.query(
    `SELECT s.id FROM intake_submissions s
       JOIN pitches p ON p.id = s.canonical_id
      WHERE s.canonical_table = 'pitches' AND p.brief_id = $1 AND p.id <> $2
        AND s.status IN ('RECEIVED', 'SHARED_WITH_BUYER')`,
    [briefId, pitchId],
  );
  for (const other of others) {
    await transitionIntake(client, {
      id: other.id,
      to: 'DECLINED',
      actorType: 'system',
      note: 'Not selected — the brief was awarded to another artist.',
    });
  }
  const briefSub = await intakeForCanonical(client, 'briefs', briefId);
  if (briefSub && briefSub.status !== 'ACCEPTED') {
    await transitionIntake(client, {
      id: briefSub.id,
      to: 'ACCEPTED',
      actorType: 'customer',
      note: 'A proposal was accepted — the commission is on the record.',
    });
  }
}

/**
 * Mirror of cancelCommissionAward (SAME transaction): the canonical
 * award is undone, so the intake states restore to match — awarded
 * proposal back to RECEIVED, award-declined proposals back to
 * RECEIVED (exactly as canonical returns them to pending), the brief
 * back to PROPOSALS_RECEIVED if live proposals remain, else RECEIVED.
 * These restores are system facts, not operator choices, so they use
 * the force path — each still writes its event.
 */
export async function mirrorAwardCompensation(client, { briefId, pitchId }) {
  const note = 'Award compensated — the checkout did not complete; states restored to match the canonical record.';
  const prop = await intakeForCanonical(client, 'pitches', pitchId);
  if (prop && prop.status === 'ACCEPTED') {
    await transitionIntake(client, {
      id: prop.id, to: 'RECEIVED', actorType: 'system', kind: 'status', note, force: true,
    });
  }
  const { rows: others } = await client.query(
    `SELECT s.id FROM intake_submissions s
       JOIN pitches p ON p.id = s.canonical_id
      WHERE s.canonical_table = 'pitches' AND p.brief_id = $1 AND p.id <> $2
        AND s.status = 'DECLINED'`,
    [briefId, pitchId],
  );
  for (const other of others) {
    await transitionIntake(client, {
      id: other.id, to: 'RECEIVED', actorType: 'system', kind: 'status', note, force: true,
    });
  }
  const briefSub = await intakeForCanonical(client, 'briefs', briefId);
  if (briefSub && briefSub.status === 'ACCEPTED') {
    const { rows: live } = await client.query(
      `SELECT count(*)::int AS n FROM intake_submissions
        WHERE linked_submission_id = $1 AND status IN ('RECEIVED', 'SHARED_WITH_BUYER')`,
      [briefSub.id],
    );
    await transitionIntake(client, {
      id: briefSub.id,
      to: live[0].n > 0 ? 'PROPOSALS_RECEIVED' : 'RECEIVED',
      actorType: 'system',
      kind: 'status',
      note,
      force: true,
    });
  }
}

