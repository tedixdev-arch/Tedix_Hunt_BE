import nodemailer, { type Transporter } from 'nodemailer';
import { pool } from './postgres.js';

/**
 * Transactional email outbox. Business code writes `email_outbox` rows inside its own transaction
 * (enqueueMail), then calls flushMail() after COMMIT; the server also retries pending rows on a timer.
 *
 * Delivery: set SMTP_URL (for example smtps://user:pass@smtp.example.com:465) and MAIL_FROM.
 * Without SMTP_URL the message is written to the server log and marked `logged` (local development).
 */
export interface MailMessage { kind: string; to: string; subject: string; text: string }
interface Queryable { query: (text: string, values?: unknown[]) => Promise<unknown> }

const MAX_ATTEMPTS = 5;
let transporter: Transporter | null | undefined;
let flushing: Promise<void> | null = null;

function transport(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const url = process.env.SMTP_URL?.trim();
  transporter = url ? nodemailer.createTransport(url) : null;
  return transporter;
}

export async function enqueueMail(db: Queryable, message: MailMessage): Promise<void> {
  await db.query(`INSERT INTO email_outbox(kind,to_address,subject,body) VALUES ($1,$2,$3,$4)`,
    [message.kind, message.to.trim(), message.subject.slice(0, 300), message.text.slice(0, 20000)]);
}

async function deliverPending(limit: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT id,kind,to_address,subject,body,attempts FROM email_outbox
      WHERE status='pending' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    const sender = transport();
    for (const row of rows) {
      try {
        if (sender) {
          await sender.sendMail({ from: process.env.MAIL_FROM?.trim() || 'TedixHunt <no-reply@tedixhunt.local>',
            to: row.to_address, subject: row.subject, text: row.body });
          await client.query(`UPDATE email_outbox SET status='sent',attempts=attempts+1,sent_at=now(),last_error=NULL WHERE id=$1`, [row.id]);
        } else {
          console.info(`[mail:not-configured] ${row.kind} to=${row.to_address} subject="${row.subject}"\n${row.body}`);
          await client.query(`UPDATE email_outbox SET status='logged',attempts=attempts+1,sent_at=now() WHERE id=$1`, [row.id]);
        }
      } catch (error) {
        const attempts = row.attempts + 1;
        await client.query(`UPDATE email_outbox SET attempts=$2,last_error=$3,status=CASE WHEN $2>=$4 THEN 'failed' ELSE 'pending' END WHERE id=$1`,
          [row.id, attempts, error instanceof Error ? error.message.slice(0, 500) : 'send failed', MAX_ATTEMPTS]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Best effort: never throws, and concurrent calls share one run. */
export function flushMail(limit = 20): Promise<void> {
  flushing ??= deliverPending(limit)
    .catch(error => console.error('Email outbox delivery failed', error instanceof Error ? error.message : error))
    .finally(() => { flushing = null; });
  return flushing;
}

/** Test hook. */
export function resetMailTransport() { transporter = undefined; }
