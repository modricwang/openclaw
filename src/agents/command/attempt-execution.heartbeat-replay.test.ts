import { describe, expect, it } from "vitest";
import { resolveHeartbeatPrepareReplayInitialLifecycle } from "./attempt-execution.js";

describe("Heartbeat restart prepare replay", () => {
  const referenceTimeIso = "2026-08-26T11:00:00.000Z";

  it("locks a failed restart prepare to the admitted reference instant", () => {
    expect(
      resolveHeartbeatPrepareReplayInitialLifecycle({
        resumeExistingHeartbeatTurn: true,
        runProfile: {
          kind: "heartbeat",
          referenceTimeIso,
          prepareReplayRequired: true,
        },
      }),
    ).toEqual({
      kind: "require_tool",
      toolName: "model_front_door__prepare_heartbeat",
      requiredArguments: {
        action: "prepare",
        reference_time_iso: referenceTimeIso,
      },
      violationMode: "fail_run",
    });
  });

  it("does not force prepare after the original prepare already succeeded", () => {
    expect(
      resolveHeartbeatPrepareReplayInitialLifecycle({
        resumeExistingHeartbeatTurn: true,
        runProfile: { kind: "heartbeat", referenceTimeIso },
      }),
    ).toBeUndefined();
  });
});
