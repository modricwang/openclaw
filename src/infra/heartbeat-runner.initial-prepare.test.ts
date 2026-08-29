import { describe, expect, it } from "vitest";
import { resolveHeartbeatInitialRunLifecycleOptions } from "./heartbeat-runner-execution.js";

describe("interval heartbeat initial prepare lifecycle", () => {
  const referenceTimeIso = "2026-08-26T11:00:00.000Z";

  it("requires the exact prepare action before the first ordinary interval response", () => {
    expect(
      resolveHeartbeatInitialRunLifecycleOptions({
        wakeSource: "interval",
        hasDueCommitments: false,
        hasExecCompletion: false,
        hasCronEvents: false,
        usesHeartbeatResponseTool: false,
        referenceTimeIso,
      }),
    ).toEqual({
      toolsAllow: ["model_front_door__prepare_heartbeat"],
      initialRunLifecycle: {
        kind: "require_tool",
        toolName: "model_front_door__prepare_heartbeat",
        requiredArguments: {
          action: "prepare",
          reference_time_iso: referenceTimeIso,
        },
        violationMode: "fail_run",
      },
    });
  });

  it.each([
    {
      label: "commitment delivery",
      wakeSource: "interval" as const,
      hasDueCommitments: true,
      hasExecCompletion: false,
      hasCronEvents: false,
      usesHeartbeatResponseTool: false,
    },
    {
      label: "exec completion",
      wakeSource: "interval" as const,
      hasDueCommitments: false,
      hasExecCompletion: true,
      hasCronEvents: false,
      usesHeartbeatResponseTool: false,
    },
    {
      label: "cron event",
      wakeSource: "interval" as const,
      hasDueCommitments: false,
      hasExecCompletion: false,
      hasCronEvents: true,
      usesHeartbeatResponseTool: false,
    },
    {
      label: "native response tool",
      wakeSource: "interval" as const,
      hasDueCommitments: false,
      hasExecCompletion: false,
      hasCronEvents: false,
      usesHeartbeatResponseTool: true,
    },
    {
      label: "manual wake",
      wakeSource: "manual" as const,
      hasDueCommitments: false,
      hasExecCompletion: false,
      hasCronEvents: false,
      usesHeartbeatResponseTool: false,
    },
  ])("does not alter $label", ({ label: _label, ...input }) => {
    expect(resolveHeartbeatInitialRunLifecycleOptions({ ...input, referenceTimeIso })).toEqual({});
  });
});
