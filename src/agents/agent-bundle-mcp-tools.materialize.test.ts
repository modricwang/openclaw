/** Tests materializing MCP catalog tools into agent tool definitions and results. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  buildBundleMcpToolsFromCatalog,
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";
import type { McpToolCatalogDiagnostic } from "./agent-bundle-mcp-types.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

function expectTextContentBlock(block: unknown, text: string) {
  const content = block as { type?: string; text?: string } | undefined;
  expect(content?.type).toBe("text");
  expect(content?.text).toBe(text);
}

function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    result?: CallToolResult;
    resultText?: string;
    diagnostics?: readonly McpToolCatalogDiagnostic[];
    supportsParallelToolCalls?: boolean;
    trustedTerminalResponse?: boolean;
    runLifecycleControl?: boolean;
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "bundleProbe";
  const tools = params.tools ?? [
    {
      serverName,
      safeServerName: serverName,
      toolName: "bundle_probe",
      description: "Bundle probe",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Bundle probe",
    },
  ];
  return {
    sessionId: "session-collision",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
          supportsParallelToolCalls: params.supportsParallelToolCalls ?? false,
          trustedTerminalResponse: params.trustedTerminalResponse ?? false,
          runLifecycleControl: params.runLifecycleControl ?? false,
        },
      },
      tools,
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    }),
    peekCatalog: () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
          supportsParallelToolCalls: params.supportsParallelToolCalls ?? false,
          trustedTerminalResponse: params.trustedTerminalResponse ?? false,
          runLifecycleControl: params.runLifecycleControl ?? false,
        },
      },
      tools,
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    }),
    callTool: async () =>
      params.result ?? {
        content: [{ type: "text", text: params.resultText ?? "FROM-BUNDLE" }],
        isError: false,
      },
    dispose: async () => {},
  };
}

describe("createBundleMcpToolRuntime", () => {
  afterEach(() => {
    mcpUiResourceTesting.clearViewStore();
  });

  it("keeps app-only MCP tools out of the model tool catalog", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "model_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "model",
            uiVisibility: ["model"],
          },
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "app_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "app",
            uiVisibility: ["app"],
          },
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "hidden_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "hidden",
            uiVisibility: [],
          },
        ],
      }),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["demo__model_tool"]);
    expect(runtime.appTools?.map((tool) => tool.name)).toEqual([
      "demo__app_tool",
      "demo__hidden_tool",
      "demo__model_tool",
    ]);
    expect(
      applyEmbeddedAttemptToolsAllow(runtime.appTools ?? [], ["demo__model_tool"], {
        toolMeta: (tool) => getPluginToolMeta(tool),
      }).map((tool) => tool.name),
    ).toEqual(["demo__model_tool"]);
  });

  it("sends private request metadata only to its exact configured MCP server", async () => {
    const calls: Array<{
      serverName: string;
      toolName: string;
      input: unknown;
      options: unknown;
    }> = [];
    const tools: McpCatalogTool[] = [
      {
        serverName: "model_front_door",
        safeServerName: "model_front_door",
        toolName: "manage_laundry",
        inputSchema: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
          additionalProperties: false,
        },
        fallbackDescription: "laundry",
      },
      {
        serverName: "third_party",
        safeServerName: "third_party",
        toolName: "observe",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        fallbackDescription: "observe",
      },
    ];
    const runtime = makeToolRuntime({ tools, serverName: "model_front_door" });
    const catalog = {
      version: 1 as const,
      generatedAt: 0,
      servers: {
        model_front_door: {
          serverName: "model_front_door",
          launchSummary: "model_front_door",
          toolCount: 1,
        },
        third_party: {
          serverName: "third_party",
          launchSummary: "third_party",
          toolCount: 1,
        },
      },
      tools,
    };
    runtime.getCatalog = async () => catalog;
    runtime.peekCatalog = () => catalog;
    runtime.callTool = async (serverName, toolName, input, options) => {
      calls.push({ serverName, toolName, input, options });
      return { content: [{ type: "text", text: "ok" }], isError: false };
    };
    const receipt = Object.freeze({
      schemaVersion: 1,
      actor: "user",
      sourceTurnId: "turn-2",
      runId: "run-2",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      channel: Object.freeze({
        provider: "telegram",
        conversationId: "chat-1",
      }),
      observedAtMs: 2,
    });
    const materialized = await materializeBundleMcpToolsForRun({
      runtime,
      privateRequestMetaByServer: {
        model_front_door: {
          "openclaw/trusted-user-turn": receipt,
        },
      },
    });

    await materialized.tools
      .find((tool) => tool.name === "model_front_door__manage_laundry")
      ?.execute("call-1", { action: "start" }, undefined, undefined);
    await materialized.tools
      .find((tool) => tool.name === "third_party__observe")
      ?.execute("call-2", {}, undefined, undefined);

    expect(calls).toEqual([
      {
        serverName: "model_front_door",
        toolName: "manage_laundry",
        input: { action: "start" },
        options: {
          requestMeta: {
            "openclaw/trusted-user-turn": receipt,
          },
        },
      },
      {
        serverName: "third_party",
        toolName: "observe",
        input: {},
        options: {},
      },
    ]);
    expect(
      materialized.tools.find((tool) => tool.name === "model_front_door__manage_laundry")
        ?.parameters,
    ).not.toHaveProperty("properties.openclaw/trusted-user-turn");
  });

  it("attaches app previews without converting typed image results to text", async () => {
    const tool: McpCatalogTool = {
      serverName: "demo",
      safeServerName: "demo",
      toolName: "show",
      inputSchema: { type: "object" },
      fallbackDescription: "show",
      uiResourceUri: "ui://demo/app",
    };
    const sessionRuntime = makeToolRuntime({
      tools: [tool],
      serverName: "demo",
      result: {
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        _meta: { "ui/state": { selected: true } },
      },
    });
    sessionRuntime.sessionKey = "agent:main:main";
    sessionRuntime.mcpAppsEnabled = true;
    sessionRuntime.readResource = async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>demo</html>",
        },
      ],
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime: sessionRuntime });
    materialized.restrictAppTools?.(materialized.tools);

    const result = await expectDefined(
      materialized.tools[0],
      "materialized.tools[0] test invariant",
    ).execute("call-1", {}, undefined, undefined);
    expect(result.content).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    expect(result.details).toMatchObject({
      mcpAppPreview: {
        mcpApp: {
          viewId: expect.stringMatching(/^mcp-app-/u),
          serverName: "demo",
          toolName: "show",
          uiResourceUri: "ui://demo/app",
          toolCallId: "call-1",
          originSessionKey: "agent:main:main",
          resultMetaState: "unavailable",
        },
      },
    });
    const viewId = (result.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    expect(
      getMcpAppViewLease(
        expectDefined(viewId, "MCP App preview view id test invariant"),
        sessionRuntime,
      )?.allowedAppToolNames,
    ).toEqual(new Set(["show"]));
  });

  it("never mints app views for tools from requester-scoped servers", async () => {
    const tool: McpCatalogTool = {
      serverName: "user-mail",
      safeServerName: "user-mail",
      toolName: "show",
      inputSchema: { type: "object" },
      fallbackDescription: "show",
      uiResourceUri: "ui://user-mail/app",
    };
    const sessionRuntime = makeToolRuntime({ tools: [tool], serverName: "user-mail" });
    sessionRuntime.mcpAppsEnabled = true;
    // View recovery (peek + transcript reconstruction) has no requester
    // identity, so scoped servers stay fail-closed at view creation.
    sessionRuntime.isRequesterScopedServer = (serverName) => serverName === "user-mail";
    const materialized = await materializeBundleMcpToolsForRun({ runtime: sessionRuntime });

    const result = await expectDefined(
      materialized.tools[0],
      "materialized.tools[0] test invariant",
    ).execute("call-1", {}, undefined, undefined);
    expect(result.details ?? {}).not.toHaveProperty("mcpAppPreview");
  });

  it("materializes bundle MCP tools and executes them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").executionMode).toBe(
      "sequential",
    );
    expect(
      getPluginToolMeta(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant")),
    ).toMatchObject({
      pluginId: "bundle-mcp",
      mcp: {
        serverName: "bundleProbe",
        safeServerName: "bundleProbe",
        toolName: "bundle_probe",
        operation: "tool",
      },
    });
    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );
    expectTextContentBlock(result.content[0], "FROM-BUNDLE");
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
    });
  });

  it("marks MCP tools parallel only when the server advertises parallel support", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        supportsParallelToolCalls: true,
      }),
    });

    expect(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").executionMode).toBe(
      "parallel",
    );
  });

  it("keeps structuredContent visible when MCP tools also return text content", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [{ type: "text", text: "pong" }],
          structuredContent: {
            threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
            content: "pong",
          },
          isError: false,
        },
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

    expectTextContentBlock(
      result.content[0],
      `structuredContent:\n${JSON.stringify(
        {
          threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
          content: "pong",
        },
        null,
        2,
      )}`,
    );
    expect(result.content).toHaveLength(1);
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      structuredContent: {
        threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
        content: "pong",
      },
    });
  });

  it("consumes exact lifecycle envelopes only from an authorized sequential server", async () => {
    const requiredEnvelope = {
      run_lifecycle: {
        contract_id: "openclaw_run_lifecycle_v1",
        effect: "require_tool",
        tool: "bundleProbe__bundle_probe",
        required_arguments: {
          action: "finalize_full_chain",
          lock_id: "lock-1",
        },
      },
    };
    const untrusted = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [],
          structuredContent: { result: JSON.stringify(requiredEnvelope) },
          isError: false,
        },
      }),
    });
    const untrustedResult = await expectDefined(
      untrusted.tools[0],
      "untrusted lifecycle test tool",
    ).execute("call-untrusted", {}, undefined, undefined);
    expect(untrustedResult.runLifecycle).toBeUndefined();

    const trusted = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        runLifecycleControl: true,
        supportsParallelToolCalls: true,
        result: {
          content: [],
          structuredContent: { result: JSON.stringify(requiredEnvelope) },
          isError: false,
        },
      }),
    });
    const trustedTool = expectDefined(trusted.tools[0], "trusted lifecycle test tool");
    const trustedResult = await trustedTool.execute("call-trusted", {}, undefined, undefined);
    expect(trustedTool.executionMode).toBe("sequential");
    expect(trustedResult.runLifecycle).toEqual({
      kind: "require_tool",
      toolName: "bundleProbe__bundle_probe",
      requiredArguments: {
        action: "finalize_full_chain",
        lock_id: "lock-1",
      },
    });
  });

  it("delivers exact terminal text only from a trusted sequential server", async () => {
    const envelope = {
      terminal_response: {
        contract_id: "openclaw_terminal_response_v1",
        text: "已记录这次小便，时间为 2026-08-27T20:30:00.000+08:00。",
      },
    };
    const untrusted = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [],
          structuredContent: { result: JSON.stringify(envelope) },
          isError: false,
        },
      }),
    });
    const untrustedResult = await expectDefined(
      untrusted.tools[0],
      "untrusted terminal-response test tool",
    ).execute("call-untrusted-terminal-response", {}, undefined, undefined);
    expect(untrustedResult.terminalResponse).toBeUndefined();
    expect(untrustedResult.terminate).toBeUndefined();
    expect(untrustedResult.details).not.toHaveProperty("bundleMcpTrustedTerminalResponse");

    const trusted = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        trustedTerminalResponse: true,
        supportsParallelToolCalls: true,
        result: {
          content: [],
          structuredContent: { result: JSON.stringify(envelope) },
          isError: false,
        },
      }),
    });
    const trustedTool = expectDefined(trusted.tools[0], "trusted terminal-response test tool");
    const trustedResult = await trustedTool.execute(
      "call-trusted-terminal-response",
      {},
      undefined,
      undefined,
    );
    expect(trustedTool.executionMode).toBe("sequential");
    expect(trustedResult.terminate).toBe(true);
    expect(trustedResult.terminalResponse).toEqual({
      text: envelope.terminal_response.text,
    });
    expect(trustedResult.details).toMatchObject({
      bundleMcpTrustedTerminalResponse: {
        contractId: "openclaw_terminal_response_v1",
        terminate: true,
        text: envelope.terminal_response.text,
      },
    });
  });

  it("maps receipt-bound delivery and final-response lifecycle effects exactly", async () => {
    const binding = {
      owner_state: "delivered",
      lock_id: "lock-1",
      receipt_id: "receipt-1",
      native_id: "native-1",
      message_sha256: "message-sha",
      route_hash: "route-sha",
    };
    const terminal = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        runLifecycleControl: true,
        result: {
          content: [],
          structuredContent: {
            result: JSON.stringify({
              owner_state: binding.owner_state,
              delivery_acknowledged: true,
              terminal_boundary_armed: true,
              terminal_boundary: {
                profile: "heartbeat_outgoing_effect_boundary_v1",
                armed: true,
                lock_id: binding.lock_id,
                heartbeat_delivery_receipt: {
                  receipt_id: binding.receipt_id,
                  native_id: binding.native_id,
                  message_sha256: binding.message_sha256,
                  route_hash: binding.route_hash,
                },
              },
              run_lifecycle: {
                contract_id: "openclaw_run_lifecycle_v1",
                effect: "terminal_external_delivery",
                binding,
              },
            }),
          },
          isError: false,
        },
      }),
    });
    const terminalResult = await expectDefined(
      terminal.tools[0],
      "terminal lifecycle test tool",
    ).execute("call-terminal", {}, undefined, undefined);
    expect(terminalResult.terminate).toBe(true);
    expect(terminalResult.runLifecycle).toBeUndefined();

    const mismatchedTerminal = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        runLifecycleControl: true,
        result: {
          content: [],
          structuredContent: {
            result: JSON.stringify({
              owner_state: binding.owner_state,
              delivery_acknowledged: true,
              terminal_boundary_armed: true,
              terminal_boundary: {
                profile: "heartbeat_outgoing_effect_boundary_v1",
                armed: true,
                lock_id: binding.lock_id,
                heartbeat_delivery_receipt: {
                  receipt_id: binding.receipt_id,
                  native_id: binding.native_id,
                  message_sha256: "different-message",
                  route_hash: binding.route_hash,
                },
              },
              run_lifecycle: {
                contract_id: "openclaw_run_lifecycle_v1",
                effect: "terminal_external_delivery",
                binding,
              },
            }),
          },
          isError: false,
        },
      }),
    });
    const mismatchedTerminalResult = await expectDefined(
      mismatchedTerminal.tools[0],
      "mismatched terminal lifecycle test tool",
    ).execute("call-terminal-mismatch", {}, undefined, undefined);
    expect(mismatchedTerminalResult.terminate).toBeUndefined();

    const finalResponse = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        runLifecycleControl: true,
        result: {
          content: [],
          structuredContent: {
            result: JSON.stringify({
              run_lifecycle: {
                contract_id: "openclaw_run_lifecycle_v1",
                effect: "final_response_only",
              },
            }),
          },
          isError: false,
        },
      }),
    });
    const finalResult = await expectDefined(
      finalResponse.tools[0],
      "final-response lifecycle test tool",
    ).execute("call-final", {}, undefined, undefined);
    expect(finalResult.runLifecycle).toEqual({ kind: "final_response_only" });
    expect(finalResult.terminate).toBeUndefined();
  });

  it("coerces non-text/image MCP tool-result blocks to text (resource_link/resource/audio)", async () => {
    // resource_link/resource/audio blocks have no base64 image source; if they
    // leaked into the provider image branch Anthropic would 400 on an image with
    // undefined data/media_type and poison the whole session history (#90710).
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [
            { type: "text", text: "intro" },
            {
              type: "resource_link",
              uri: "https://example.com/a.docx",
              name: "a.docx",
              title: "Quarterly report",
            },
            {
              type: "resource_link",
              uri: "https://example.com/bare",
              name: "",
            },
            {
              type: "resource",
              resource: { uri: "memo://one", text: "memo body" },
            },
            {
              type: "resource",
              resource: { uri: "blob://two", blob: "AAAA", mimeType: "application/pdf" },
            },
            { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
            { type: "image", data: "iVBOR", mimeType: "image/png" },
          ],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

    expect(result.content).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "[Quarterly report] https://example.com/a.docx" },
      { type: "text", text: "https://example.com/bare" },
      { type: "text", text: "memo body" },
      { type: "text", text: "blob://two" },
      { type: "text", text: "[audio audio/mpeg]" },
      { type: "image", data: "iVBOR", mimeType: "image/png" },
    ]);
  });

  it("coerces a malformed image block (missing base64 source) to text", async () => {
    // A real-world poison case: image block with undefined data/media_type.
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [{ type: "image" } as unknown as CallToolResult["content"][number]],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify({ type: "image" }) });
  });

  it("disambiguates bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
  });

  it("reuses one-shot reserved names for App-only policy projections", async () => {
    function* reservedToolNames() {
      yield "demo__app_tool";
    }
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        serverName: "demo",
        tools: [
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "app_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "app",
            uiVisibility: ["app"],
          },
        ],
      }),
      reservedToolNames: reservedToolNames(),
    });

    expect(runtime.tools).toEqual([]);
    expect(runtime.appTools?.map((tool) => tool.name)).toEqual(["demo__app_tool-2"]);
  });

  it("preserves catalog diagnostics when MCP servers fail tool listing", async () => {
    const diagnostics = [
      {
        serverName: "fuzzplugin",
        safeServerName: "fuzzplugin",
        launchSummary: "node fuzzplugin-mcp.mjs",
        message: 'tools[0].inputSchema.type expected "object"',
      },
    ];

    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({ tools: [], diagnostics }),
    });

    expect(runtime.tools).toEqual([]);
    expect(runtime.diagnostics).toEqual(diagnostics);
  });

  it("exposes MCP resource and prompt utility tools when advertised", async () => {
    const base = makeToolRuntime({ tools: [], serverName: "knowledge" });
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            knowledge: {
              serverName: "knowledge",
              safeServerName: "knowledge",
              launchSummary: "knowledge",
              toolCount: 0,
              resources: { listChanged: true },
              prompts: { listChanged: true },
            },
          },
          tools: [],
        }),
        listResources: async () => [{ uri: "memo://one", name: "memo" }],
        readResource: async (_serverName, uri) => ({
          contents: [{ uri, text: "memo text" }],
        }),
        listPrompts: async () => [{ name: "brief" }],
        getPrompt: async (_serverName, name, args) => ({ name, args }),
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);

    const read = await runtime.tools
      .find((tool) => tool.name === "knowledge__resources_read")!
      .execute("call-read", { uri: "memo://one" }, undefined, undefined);

    expectTextContentBlock(
      read.content[0],
      JSON.stringify({ contents: [{ uri: "memo://one", text: "memo text" }] }, null, 2),
    );
    expect(read.details).toMatchObject({
      mcpServer: "knowledge",
      mcpOperation: "resources_read",
      untrustedMcpOutput: true,
    });

    await expect(
      runtime.tools
        .find((tool) => tool.name === "knowledge__prompts_get")!
        .execute("call-prompt", { name: "brief", arguments: { count: 1 } }, undefined, undefined),
    ).rejects.toThrow("arguments.count must be a string");
  });

  it("applies per-server MCP tool filters to resource and prompt utility tools", async () => {
    const base = makeToolRuntime({ tools: [], serverName: "knowledge" });
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            knowledge: {
              serverName: "knowledge",
              safeServerName: "knowledge",
              launchSummary: "knowledge",
              toolCount: 0,
              resources: { listChanged: false },
              prompts: { listChanged: false },
              toolFilter: { include: ["resources_*"], exclude: ["resources_read"] },
            },
          },
          tools: [],
        }),
        listResources: async () => [],
        readResource: async () => ({ contents: [] }),
        listPrompts: async () => [],
        getPrompt: async () => ({ messages: [] }),
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["knowledge__resources_list"]);
  });

  it("projects resource and prompt utility tools for inventory-only catalogs", async () => {
    const tools = buildBundleMcpToolsFromCatalog({
      catalog: {
        version: 1,
        generatedAt: 0,
        servers: {
          knowledge: {
            serverName: "knowledge",
            safeServerName: "knowledge",
            launchSummary: "knowledge",
            toolCount: 0,
            resources: { listChanged: false },
            prompts: { listChanged: false },
          },
        },
        tools: [],
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);
    await expect(
      expectDefined(tools[0], "tools[0] test invariant").execute(
        "inventory-only",
        {},
        undefined,
        undefined,
      ),
    ).rejects.toThrow("bundle-mcp catalog projection cannot execute tools");
  });

  it("materializes configured MCP tools through the session runtime boundary", async () => {
    const created: Parameters<
      NonNullable<Parameters<typeof createBundleMcpToolRuntime>[0]["createRuntime"]>
    >[0][] = [];
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: ["configured-probe.mjs"],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
      createRuntime: (params) => {
        created.push(params);
        return makeToolRuntime({
          serverName: "configuredProbe",
          resultText: "FROM-CONFIG",
        });
      },
    });

    expect(created).toHaveLength(1);
    expect(expectDefined(created[0], "created[0] test invariant").sessionId).toMatch(
      /^bundle-mcp:/,
    );
    expect(expectDefined(created[0], "created[0] test invariant").workspaceDir).toBe("/workspace");
    expect(
      expectDefined(created[0], "created[0] test invariant").cfg?.mcp?.servers?.configuredProbe
        ?.command,
    ).toBe("node");
    expect(
      expectDefined(created[0], "created[0] test invariant").cfg?.mcp?.servers?.configuredProbe
        ?.args,
    ).toEqual(["configured-probe.mjs"]);

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe__bundle_probe"]);
    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-configured-probe",
      {},
      undefined,
      undefined,
    );
    expectTextContentBlock(result.content[0], "FROM-CONFIG");
    expect(result.details).toEqual({
      mcpServer: "configuredProbe",
      mcpTool: "bundle_probe",
    });
  });

  it("returns tools sorted alphabetically for stable prompt-cache keys", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
          {
            serverName: "multi",
            safeServerName: "multi",
            toolName: "zeta",
            description: "z",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "z",
          },
          {
            serverName: "multi",
            safeServerName: "multi",
            toolName: "alpha",
            description: "a",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "a",
          },
          {
            serverName: "multi",
            safeServerName: "multi",
            toolName: "mu",
            description: "m",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "m",
          },
        ],
      }),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "multi__alpha",
      "multi__mu",
      "multi__zeta",
    ]);
  });

  it("normalizes local $ref schemas from MCP tools before exposing them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
          {
            serverName: "notion",
            safeServerName: "notion",
            toolName: "API-post-page",
            description: "Create a page",
            inputSchema: {
              type: "object",
              required: ["parent"],
              properties: {
                parent: { $ref: "#/$defs/parentRequest" },
              },
              $defs: {
                parentRequest: {
                  oneOf: [
                    {
                      type: "object",
                      required: ["page_id"],
                      properties: { page_id: { type: "string" } },
                    },
                    {
                      type: "object",
                      required: ["database_id"],
                      properties: { database_id: { type: "string" } },
                    },
                  ],
                },
              },
            },
            fallbackDescription: "Create a page",
          },
        ],
      }),
    });

    expect(runtime.tools[0]?.parameters).toEqual({
      type: "object",
      required: ["parent"],
      properties: {
        parent: {
          oneOf: [
            {
              type: "object",
              required: ["page_id"],
              properties: { page_id: { type: "string" } },
            },
            {
              type: "object",
              required: ["database_id"],
              properties: { database_id: { type: "string" } },
            },
          ],
        },
      },
    });
    expect(
      validateToolArguments(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant"), {
        type: "toolCall",
        id: "call-page",
        name: "notion__API-post-page",
        arguments: { parent: { page_id: "page-id" } },
      }),
    ).toEqual({ parent: { page_id: "page-id" } });
  });
});
