import { describe, expect, it, vi } from "vitest";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("finalizeEmbeddedAttempt media trajectory capture", () => {
  it("records canonical message snapshots without reprojecting them", () => {
    const recordEvent = vi.fn();
    const result = {
      terminal: { kind: "ok" },
      assistantTexts: ["done"],
      toolMetas: [],
      didSendViaMessagingTool: false,
      didSendDeterministicApprovalPrompt: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      acceptedSessionSpawns: [],
      clientToolCalls: [],
      messagesSnapshot: [
        {
          role: "user",
          content: "inspect",
          __openclaw: {
            media: [{ path: "/media/canonical.png", contentType: "image/png" }],
          },
        },
      ],
    } as unknown as EmbeddedRunAttemptResult;

    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent } as never,
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: true,
    });

    const modelCompleted = recordEvent.mock.calls.find(
      ([type]) => type === "model.completed",
    )?.[1] as { messagesSnapshot?: Array<Record<string, unknown>> } | undefined;
    const captured = modelCompleted?.messagesSnapshot?.[0];
    expect(captured).not.toHaveProperty("MediaPath");
    expect(captured).not.toHaveProperty("MediaType");
    expect(captured?.["__openclaw"]).toMatchObject({
      media: [{ path: "/media/canonical.png", contentType: "image/png" }],
    });
  });

  it("classifies a Host-trusted terminal receipt as delivered after toolUse", () => {
    const recordEvent = vi.fn();
    const result = {
      terminal: { kind: "ok" },
      assistantTexts: [],
      lastAssistant: { role: "assistant", stopReason: "toolUse", content: [] },
      terminalResponseText: "已记录本次排泄详情。",
      toolMetas: [],
      didSendViaMessagingTool: false,
      didSendDeterministicApprovalPrompt: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      acceptedSessionSpawns: [],
      clientToolCalls: [],
      messagesSnapshot: [],
    } as unknown as EmbeddedRunAttemptResult;

    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent } as never,
      synthesizedPayloadCount: 1,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: true,
    });

    const ended = recordEvent.mock.calls.find(([type]) => type === "session.ended")?.[1] as
      | { status?: string; terminalError?: string }
      | undefined;
    expect(ended).toMatchObject({ status: "success" });
    expect(ended?.terminalError).toBeUndefined();
  });
});
