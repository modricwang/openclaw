import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("createReplyRestartRecoveryClaimController", () => {
  it("retargets durable user-turn admission to the prepared reply session", async () => {
    const root = tempDirs.make("openclaw-reply-admission-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "plugin-binding:codex:target";
    const sessionId = "bound-session-id";
    const entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);

    let persistedTarget: UserTurnTranscriptTarget | undefined;
    const persistApproved = vi.fn<UserTurnTranscriptRecorder["persistApproved"]>(async (params) => {
      persistedTarget =
        typeof params?.target === "function" ? await params.target() : params?.target;
      return {
        appended: true,
        message: { role: "user", content: "hello", timestamp: Date.now() },
        messageId: "user-turn-1",
        sessionEntry: entry,
        sessionFile: "sqlite:bound-session-id",
      };
    });
    const recorder = {
      message: undefined,
      resolveMessage: async () => undefined,
      markRuntimePersistencePending: () => {},
      markRuntimePersisted: () => {},
      markBlocked: () => {},
      hasPersisted: () => false,
      isBlocked: () => false,
      hasRuntimePersistencePending: () => false,
      waitForRuntimePersistence: async () => {},
      persistApproved,
      persistBlocked: async () => undefined,
      persistFallback: async () => undefined,
    } satisfies UserTurnTranscriptRecorder;
    const controller = createReplyRestartRecoveryClaimController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      resolveUserTurnTarget: (target) => ({
        ...target,
        sessionEntry: target.entry,
        agentId: "main",
      }),
      sessionKey,
      setEntry: () => {},
      storePath,
    });

    await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    expect(persistApproved).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSessionId: sessionId }),
    );
    expect(persistedTarget).toMatchObject({
      sessionId,
      sessionKey,
      storePath,
      agentId: "main",
    });
  });

  it("persists a source-less Heartbeat profile as an internal restart claim", async () => {
    const root = tempDirs.make("openclaw-heartbeat-admission-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "heartbeat-session";
    let entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);

    const controller = createReplyRestartRecoveryClaimController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      runProfile: { kind: "heartbeat", bootstrapContextMode: "lightweight" },
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      storePath,
    });

    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    const persisted = loadSessionEntry({ storePath, sessionKey });
    expect(persisted).toMatchObject({
      sessionId,
      status: "running",
      abortedLastRun: false,
      restartRecoverySourceIngress: "internal",
      restartRecoveryRunProfile: {
        kind: "heartbeat",
        bootstrapContextMode: "lightweight",
      },
    });
    expect(persisted?.restartRecoveryDeliveryRunId).toEqual(expect.any(String));
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
  });
});
