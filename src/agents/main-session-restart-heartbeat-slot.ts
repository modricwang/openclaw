/**
 * ISSUE-0111: Heartbeat pending slot typed branch for restart recovery.
 *
 * Reads the owner-state substrate written by the Python MCP heartbeat pipeline
 * and returns a structured decision. No regex, no keyword matching, no
 * transcript parsing. Pure structural check on typed state.
 *
 * The heartbeat-owned interrupted session MUST NOT receive the generic resume
 * message. The model is never asked to decide whether an older transcript was
 * already complete.
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("restart-heartbeat-slot");

const CATCH_UP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RECOVERY_ATTEMPTS = 1;

export type HeartbeatSlotRecoveryDecision =
  | { action: "none"; reason: string }
  | { action: "catch_up"; slotId: string; phaseAtInterrupt: string; elapsedMs: number; attempt: number }
  | { action: "terminal"; outcome: "expired" | "interrupted_by_restart"; slotId: string }
  | { action: "delivery_owned"; slotId: string; prepareReceipt: Record<string, unknown> };

type PendingHeartbeatSlot = {
  slot_id?: string;
  state?: string;
  phase_at_interrupt?: string;
  started_at_ms?: number;
  slot_end_ms?: number;
  prepare_receipt?: Record<string, unknown> | null;
  recovery_attempts?: number;
  delivery_context?: Record<string, unknown> | null;
  lifecycle_revision?: number;
  created_at?: string;
  updated_at?: string;
};

type OwnerStateFile = {
  schema_version?: number;
  pending_heartbeat_slot?: PendingHeartbeatSlot | null;
  last_heartbeat_recovery_receipt?: Record<string, unknown> | null;
  [key: string]: unknown;
};

function resolveOwnerStatePath(): string {
  const configured = (process.env.HEARTBEAT_OWNER_STATE_PATH ?? "").trim();
  if (configured) {
    return configured.replace(/^~/, process.env.HOME ?? "~");
  }
  const home = process.env.HOME ?? "/home/ubuntu";
  return path.join(home, "env-assistant", "data", "heartbeat_owner_state.json");
}

function loadOwnerState(): OwnerStateFile | undefined {
  const ownerStatePath = resolveOwnerStatePath();
  try {
    const raw = fs.readFileSync(ownerStatePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as OwnerStateFile;
  } catch {
    return undefined;
  }
}

function saveOwnerState(state: OwnerStateFile): void {
  const ownerStatePath = resolveOwnerStatePath();
  try {
    const dir = path.dirname(ownerStatePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = ownerStatePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 0), "utf-8");
    fs.renameSync(tmpPath, ownerStatePath);
  } catch (err) {
    log.warn(`failed to save owner state: ${String(err)}`);
  }
}

/**
 * Evaluate the pending heartbeat slot on gateway restart.
 *
 * Decision matrix:
 * - No record → { action: "none" }
 * - Record exists, within catch-up window, attempts < max → { action: "catch_up" }
 * - Record exists but expired / attempts exhausted → { action: "terminal" }
 * - Record exists with frozen prepare_receipt → { action: "delivery_owned" }
 */
export function checkHeartbeatPendingSlot(nowMs?: number): HeartbeatSlotRecoveryDecision {
  const now = nowMs ?? Date.now();
  const state = loadOwnerState();
  if (!state) {
    return { action: "none", reason: "owner_state_unavailable" };
  }

  const record = state.pending_heartbeat_slot;
  if (!record || typeof record !== "object") {
    return { action: "none", reason: "no_pending_slot" };
  }

  const slotState = String(record.state ?? "");
  if (slotState !== "pending" && slotState !== "recovery_queued") {
    return { action: "none", reason: `slot_state_${slotState || "empty"}` };
  }

  const startedAtMs = Number(record.started_at_ms ?? 0);
  const slotEndMs = Number(record.slot_end_ms ?? 0);
  const recoveryAttempts = Number(record.recovery_attempts ?? 0);
  const elapsedMs = now - startedAtMs;
  const slotId = String(record.slot_id ?? "");

  // Expired: past slot end or beyond catch-up window
  if (now > slotEndMs || elapsedMs > CATCH_UP_WINDOW_MS) {
    writeTerminalReceipt(state, record, "expired", recoveryAttempts);
    return { action: "terminal", outcome: "expired", slotId };
  }

  // Recovery attempts exhausted
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    writeTerminalReceipt(state, record, "interrupted_by_restart", recoveryAttempts);
    return { action: "terminal", outcome: "interrupted_by_restart", slotId };
  }

  // Frozen prepare_receipt or durable delivery intent → delivery reconciliation
  const prepareReceipt = record.prepare_receipt;
  if (prepareReceipt && typeof prepareReceipt === "object" && prepareReceipt.lock_id) {
    record.state = "interrupted_by_restart";
    record.updated_at = new Date().toISOString();
    record.lifecycle_revision = Number(record.lifecycle_revision ?? 0) + 1;
    saveOwnerState(state);
    return { action: "delivery_owned", slotId, prepareReceipt };
  }

  // Safe recovery: mark as recovery_queued
  record.state = "recovery_queued";
  record.recovery_attempts = recoveryAttempts + 1;
  record.lifecycle_revision = Number(record.lifecycle_revision ?? 0) + 1;
  record.updated_at = new Date().toISOString();
  saveOwnerState(state);

  log.info(
    `heartbeat slot recovery queued: ${slotId} phase=${record.phase_at_interrupt} elapsed=${elapsedMs}ms attempt=${recoveryAttempts + 1}`,
  );

  return {
    action: "catch_up",
    slotId,
    phaseAtInterrupt: String(record.phase_at_interrupt ?? ""),
    elapsedMs,
    attempt: recoveryAttempts + 1,
  };
}

function writeTerminalReceipt(
  state: OwnerStateFile,
  record: PendingHeartbeatSlot,
  outcome: string,
  attemptCount: number,
): void {
  const now = new Date().toISOString();
  state.last_heartbeat_recovery_receipt = {
    slot_id: String(record.slot_id ?? ""),
    phase_at_interrupt: String(record.phase_at_interrupt ?? ""),
    outcome,
    attempt_count: attemptCount,
    started_at: String(record.created_at ?? ""),
    terminated_at: now,
    delivery_evidence: { queue_id: null, receipt_ref: null },
  };
  state.pending_heartbeat_slot = null;
  saveOwnerState(state);
}
