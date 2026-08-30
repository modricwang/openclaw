// Before-terminal-delivery tests cover the async gate that can suppress or
// release deferred assistant events and block replies at run completion.
import { describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./embedded-agent-runner/run.overflow-compaction.fixture.js";
import {
  resolveIncompleteTurnPayloadText,
  resolveSettledToolTerminalContinuationInstruction,
} from "./embedded-agent-runner/run/incomplete-turn.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import {
  emitAssistantTextDeltaAndEnd,
  createSubscribedSessionHarness,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";

function hasAssistantEvent(calls: Array<unknown[]>): boolean {
  // The gate buffers assistant stream events; tests use this helper to assert
  // nothing leaks before the terminal decision resolves.
  return calls.some((call) => {
    const event = call[0] as { stream?: string } | undefined;
    return event?.stream === "assistant";
  });
}

function hasLifecycleEndEvent(calls: Array<unknown[]>): boolean {
  return calls.some((call) => {
    const event = call[0] as { stream?: string; data?: { phase?: string } } | undefined;
    return event?.stream === "lifecycle" && event.data?.phase === "end";
  });
}

describe("subscribeEmbeddedAgentSession before terminal delivery", () => {
  it("suppresses deferred block replies when the terminal gate requests a revision", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => ({
      suppressTerminalDelivery: true,
    }));
    const { emit } = createSubscribedSessionHarness({
      runId: "run-before-terminal-revise",
      onBlockReply,
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "First answer.",
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "First answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1));
    expect(onBeforeTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        hasAssistantVisibleText: true,
        isError: false,
        incompleteTerminalAssistant: false,
        willRetry: false,
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(false);
  });

  it("waits for async terminal gate decisions before draining", async () => {
    // waitForPendingEvents must include the gate promise or callers can observe
    // a drained subscription before terminal delivery has been decided.
    const onBlockReply = vi.fn();
    let resolveGate: ((value: { suppressTerminalDelivery: true }) => void) | undefined;
    const onBeforeTerminalDelivery = vi.fn(
      () =>
        new Promise<{ suppressTerminalDelivery: true }>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-wait",
      onBlockReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Slow revise answer.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Slow revise answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1));
    let drained = false;
    const waitPromise = subscription.waitForPendingEvents().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveGate?.({ suppressTerminalDelivery: true });
    await waitPromise;
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("carries a trusted terminal receipt through the serialized tool result to settlement", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-terminal-response-synchronous-capture",
    });
    const terminalResponseText =
      "已记录这次小便：时间为 2026-08-30T07:12:41.605+08:00，尿液颜色为淡黄色。";
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "deepseek",
      model: "deepseek-v4-flash-vision-exp",
      content: [
        {
          type: "toolCall",
          id: "call-terminal-response",
          name: "model_front_door__manage_body_care",
          arguments: {
            action: "elimination",
            elimination: { request_type: "add_details", event_ref: 5168 },
          },
        },
      ],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;

    emit({
      type: "tool_execution_start",
      toolName: "model_front_door__manage_body_care",
      toolCallId: "call-terminal-response",
      args: {},
    });
    emit({
      type: "tool_execution_end",
      toolName: "model_front_door__manage_body_care",
      toolCallId: "call-terminal-response",
      isError: false,
      executionStarted: true,
      result: {
        content: [],
        details: {
          mcpServer: "model_front_door",
          bundleMcpTrustedTerminalResponse: {
            contractId: "openclaw_terminal_response_v1",
            terminate: true,
            text: terminalResponseText,
          },
        },
      },
    });

    expect(subscription.getTerminalResponseText()).toBe(terminalResponseText);
    await subscription.waitForPendingEvents();
    expect(subscription.getTerminalResponseText()).toBe(terminalResponseText);

    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [{ toolName: "model_front_door__manage_body_care" }],
      lastAssistant: toolUseAssistant,
      currentAssistant: toolUseAssistant,
      sessionKey: "agent:main:terminal-response-r20",
      inlineToolResultsAllowed: false,
      terminalResponseText: subscription.getTerminalResponseText(),
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ text: terminalResponseText });
    expect(payloads[0]?.isError).not.toBe(true);

    const attempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "model_front_door__manage_body_care" }],
      lastAssistant: toolUseAssistant,
      currentAttemptAssistant: toolUseAssistant,
      terminalResponseText: subscription.getTerminalResponseText(),
    });
    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: payloads.length,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
    expect(
      resolveSettledToolTerminalContinuationInstruction({
        payloadCount: payloads.length,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("defers assistant stream and partial replies until the terminal gate continues", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-assistant-stream",
      onAgentEvent,
      onPartialReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitAssistantTextDeltaAndEnd({
      emit,
      text: "Visible stream.",
    });
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);
    expect(onPartialReply).not.toHaveBeenCalled();

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Visible stream." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(true);
    expect(onPartialReply).toHaveBeenCalled();
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
  });

  it("does not send final-only assistant events through partial replies", async () => {
    const onPartialReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-final-only",
      onPartialReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Final only.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Final only." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("finalizes normally when the terminal gate rejects", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => {
      throw new Error("hook failed");
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-reject",
      onBlockReply,
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Fallback answer.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Fallback answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Fallback answer." }),
      { assistantMessageIndex: 1 },
    );
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
  });

  it("flushes deferred block replies when the terminal gate continues", async () => {
    const onBlockReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit } = createSubscribedSessionHarness({
      runId: "run-before-terminal-continue",
      onBlockReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Accepted answer.",
    });
    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Accepted answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledTimes(1));
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Accepted answer." }),
      { assistantMessageIndex: 1 },
    );
  });
});
