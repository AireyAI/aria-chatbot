// outbound_scheduler.js
//
// Lightweight cron-like scheduler for outbound messages Aria fires
// proactively — lead follow-ups, booking reminders, stale-conversation
// recovery. Pure in-memory queue backed by an append-only JSONL ledger
// so server restarts replay pending tasks.
//
// Why home-grown vs node-cron / bull / etc:
//   - No new dependency, no Redis, no extra container
//   - Tasks are owner-scoped + low volume (tens per owner per day max)
//   - 60s tick is fine — none of our use cases need sub-minute precision
//   - Per Engineering Rule 13 the ledger is append-only; consumers derive
//     current state from rolling-forward the log

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const LEDGER = resolve('data/outbound_tasks.jsonl');
const taskHandlers = new Map(); // type → async (task) => boolean

// In-memory pending queue rebuilt at startup from the ledger.
// Map<taskId, task> for O(1) cancel by id.
const pending = new Map();

export function registerTaskHandler(type, handler) {
  taskHandlers.set(type, handler);
}

// Schedule a future task. dueAt is ms-since-epoch.
export function scheduleTask({ type, dueAt, ownerEmail, payload }) {
  if (!taskHandlers.has(type)) throw new Error(`No handler registered for task type: ${type}`);
  const task = {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type, dueAt, ownerEmail, payload,
    status: 'pending',
    scheduledAt: Date.now(),
  };
  pending.set(task.id, task);
  appendToLedger({ op: 'schedule', task });
  return task.id;
}

export function cancelTask(taskId, reason) {
  const t = pending.get(taskId);
  if (!t) return false;
  pending.delete(taskId);
  appendToLedger({ op: 'cancel', taskId, reason, at: Date.now() });
  return true;
}

export function listPending({ ownerEmail, type } = {}) {
  return Array.from(pending.values()).filter(t =>
    (!ownerEmail || t.ownerEmail === ownerEmail) &&
    (!type || t.type === type)
  );
}

function appendToLedger(entry) {
  try {
    mkdirSync(resolve('data'), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify(entry) + '\n');
  } catch (e) { console.warn('[scheduler] ledger append failed:', e.message); }
}

// Rebuild pending queue from ledger at startup. Replays schedule ops minus
// any matching cancel/completed ops. Ignores tasks whose dueAt is in the
// past AND were scheduled > 24h ago (assume stale, don't fire late).
export function bootstrapFromLedger() {
  pending.clear();
  if (!existsSync(LEDGER)) return 0;
  const lines = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  const cancelled = new Set();
  const completed = new Set();
  // First pass — collect terminal states
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (e.op === 'cancel')   cancelled.add(e.taskId);
      if (e.op === 'complete') completed.add(e.taskId);
    } catch {}
  }
  // Second pass — replay schedules that didn't terminate
  const now = Date.now();
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (e.op !== 'schedule' || !e.task) continue;
      const t = e.task;
      if (cancelled.has(t.id) || completed.has(t.id)) continue;
      // Drop tasks scheduled > 24h ago whose due time is past — assume missed
      const scheduledLongAgo = now - (t.scheduledAt || 0) > 24 * 60 * 60 * 1000;
      if (scheduledLongAgo && t.dueAt < now) continue;
      pending.set(t.id, t);
    } catch {}
  }
  return pending.size;
}

// Tick — fire due tasks. Call every 60s.
export async function tick() {
  const now = Date.now();
  const due = Array.from(pending.values()).filter(t => t.dueAt <= now);
  for (const task of due) {
    const handler = taskHandlers.get(task.type);
    if (!handler) {
      console.warn(`[scheduler] No handler for ${task.type} — dropping task ${task.id}`);
      pending.delete(task.id);
      appendToLedger({ op: 'complete', taskId: task.id, status: 'no-handler', at: now });
      continue;
    }
    try {
      const ok = await handler(task);
      pending.delete(task.id);
      appendToLedger({ op: 'complete', taskId: task.id, status: ok ? 'sent' : 'failed', at: Date.now() });
    } catch (e) {
      console.error(`[scheduler] Task ${task.id} threw:`, e.message);
      pending.delete(task.id);
      appendToLedger({ op: 'complete', taskId: task.id, status: 'error', error: e.message, at: Date.now() });
    }
  }
  return due.length;
}

// Convenience: start a 60s tick loop. Returns the interval handle so caller
// can stop on shutdown.
export function startTickLoop(intervalMs = 60_000) {
  return setInterval(() => tick().catch(e => console.error('[scheduler] tick failed:', e.message)), intervalMs);
}
