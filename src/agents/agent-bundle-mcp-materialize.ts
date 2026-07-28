/** Materializes configured MCP catalog entries into agent tools and runtime helpers. */
import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentRunLifecycleDirective } from "@openclaw/agent-core";
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta, setPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import { matchesMcpToolFilterPattern } from "./agent-bundle-mcp-filter.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpPrivateRequestMetaByServer,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { mcpContentBlockToAgentContent } from "./mcp-content.js";
import { buildMcpAppCanvasPayload, fetchMcpAppView } from "./mcp-ui-resource.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";
function isAppOnlyTool(tool: McpCatalogTool): boolean {
  return tool.uiVisibility !== undefined && !tool.uiVisibility.includes("model");
}

async function releaseRuntimeLease(params: {
  runtime: SessionMcpRuntime;
  releaseLease?: () => void;
}): Promise<void> {
  params.releaseLease?.();
  // Lease retirement is a lifecycle-only edge. Keep the manager graph out of
  // read-only CLI startup paths that load tool materialization metadata.
  const { completeDeferredSessionMcpRuntimeRetirement } =
    await import("./agent-bundle-mcp-manager-api.js");
  await completeDeferredSessionMcpRuntimeRetirement(params.runtime).catch((error: unknown) => {
    logWarn(`bundle-mcp: deferred runtime cleanup failed: ${String(error)}`);
  });
}

function buildAppToolPolicyProjections(params: {
  catalog: McpToolCatalog;
  modelTools: readonly AnyAgentTool[];
  reservedToolNames?: Iterable<string>;
}): AnyAgentTool[] {
  const tools = params.modelTools.filter(
    (tool) => getPluginToolMeta(tool)?.mcp?.operation === "tool",
  );
  const reservedNames = normalizeReservedToolNames([
    ...(params.reservedToolNames ?? []),
    ...params.modelTools.map((tool) => tool.name),
  ]);
  const appOnlyTools = params.catalog.tools.filter(isAppOnlyTool).toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    return serverOrder || a.toolName.localeCompare(b.toolName);
  });
  for (const tool of appOnlyTools) {
    const name = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: tool.toolName,
      reservedNames,
    });
    reservedNames.add(normalizeLowercaseStringOrEmpty(name));
    const projection: AnyAgentTool = {
      name,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      execute: async () => {
        throw new Error("MCP App policy projections cannot execute tools");
      },
    };
    setPluginToolMeta(projection, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: tool.serverName,
        safeServerName: tool.safeServerName,
        toolName: tool.toolName,
        operation: "tool",
      },
    });
    tools.push(projection);
  }
  return tools.toSorted((a, b) => a.name.localeCompare(b.name));
}

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
  allowRunLifecycleControl: boolean;
}): AgentToolResult<unknown> {
  const content: AgentToolResult<unknown>["content"] = Array.isArray(params.result.content)
    ? params.result.content.map(mcpContentBlockToAgentContent)
    : [];
  const structuredContentBlock =
    params.result.structuredContent !== undefined
      ? ({
          type: "text",
          text: `structuredContent:\n${JSON.stringify(params.result.structuredContent, null, 2)}`,
        } as const)
      : null;
  // Structured MCP results are the canonical model payload here; replacing
  // mirrored content avoids duplicating large tool output in the prompt.
  const normalizedContent: AgentToolResult<unknown>["content"] = structuredContentBlock
    ? [structuredContentBlock]
    : content.length > 0
      ? content
      : ([
          {
            type: "text",
            text: JSON.stringify(
              {
                status: params.result.isError === true ? "error" : "ok",
                server: params.serverName,
                tool: params.toolName,
              },
              null,
              2,
            ),
          },
        ] as AgentToolResult<unknown>["content"]);
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
    ...resolveTrustedRunLifecycleControl({
      structuredContent: params.result.structuredContent,
      isError: params.result.isError === true,
      allowed: params.allowRunLifecycleControl,
    }),
  };
}

const RUN_LIFECYCLE_CONTRACT_ID = "openclaw_run_lifecycle_v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function structuredResultPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const carried = value.result;
  if (isRecord(carried)) {
    return carried;
  }
  if (typeof carried === "string") {
    try {
      const parsed = JSON.parse(carried);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return value;
}

function resolveTrustedRunLifecycleControl(params: {
  structuredContent: unknown;
  isError: boolean;
  allowed: boolean;
}): Pick<AgentToolResult<unknown>, "runLifecycle" | "terminate"> {
  if (!params.allowed || params.isError) {
    return {};
  }
  const payload = structuredResultPayload(params.structuredContent);
  const action = isRecord(payload?.action) ? payload.action : undefined;
  const envelope = payload?.run_lifecycle ?? action?.run_lifecycle;
  if (!isRecord(envelope) || envelope.contract_id !== RUN_LIFECYCLE_CONTRACT_ID) {
    return {};
  }
  if (envelope.effect === "require_tool") {
    const toolName = envelope.tool;
    const requiredArguments = envelope.required_arguments;
    if (typeof toolName !== "string" || !toolName.trim() || !isRecord(requiredArguments)) {
      return {};
    }
    const runLifecycle: AgentRunLifecycleDirective = {
      kind: "require_tool",
      toolName,
      requiredArguments,
    };
    return { runLifecycle };
  }
  if (envelope.effect === "final_response_only") {
    return { runLifecycle: { kind: "final_response_only" } };
  }
  if (envelope.effect === "terminal_external_delivery") {
    const binding = envelope.binding;
    const terminalBoundary = payload?.terminal_boundary;
    const deliveryReceipt = isRecord(terminalBoundary)
      ? terminalBoundary.heartbeat_delivery_receipt
      : undefined;
    const bindingKeys = [
      "lock_id",
      "message_sha256",
      "native_id",
      "owner_state",
      "receipt_id",
      "route_hash",
    ];
    if (
      !isRecord(binding) ||
      !isRecord(terminalBoundary) ||
      !isRecord(deliveryReceipt) ||
      Object.keys(binding).length !== bindingKeys.length ||
      !bindingKeys.every((key) => Object.hasOwn(binding, key)) ||
      (binding.owner_state !== "delivered" && binding.owner_state !== "reused_delivered") ||
      payload?.owner_state !== binding.owner_state ||
      payload?.delivery_acknowledged !== true ||
      payload?.terminal_boundary_armed !== true ||
      terminalBoundary.profile !== "heartbeat_outgoing_effect_boundary_v1" ||
      terminalBoundary.armed !== true ||
      terminalBoundary.lock_id !== binding.lock_id ||
      deliveryReceipt.receipt_id !== binding.receipt_id ||
      deliveryReceipt.native_id !== binding.native_id ||
      deliveryReceipt.message_sha256 !== binding.message_sha256 ||
      deliveryReceipt.route_hash !== binding.route_hash
    ) {
      return {};
    }
    return { terminate: true };
  }
  return {};
}

function toJsonAgentToolResult(params: {
  serverName: string;
  operation: string;
  value: unknown;
}): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(params.value, null, 2),
      },
    ],
    details: {
      mcpServer: params.serverName,
      mcpOperation: params.operation,
      untrustedMcpOutput: true,
    },
  };
}

function requireStringArg(input: unknown, key: string): string {
  if (!input || typeof input !== "object") {
    throw new Error(`${key} is required`);
  }
  const value = Reflect.get(input, key);
  if (typeof value !== "string") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalStringRecordArg(input: unknown, key: string): Record<string, string> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  const invalid = entries.find((entry) => typeof entry[1] !== "string");
  if (invalid) {
    throw new Error(`${key}.${invalid[0]} must be a string`);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serverAllowsUtilityTool(
  server: McpToolCatalog["servers"][string],
  operation: string,
): boolean {
  const include = server.toolFilter?.include ?? [];
  const exclude = server.toolFilter?.exclude ?? [];
  if (
    include.length > 0 &&
    !include.some((pattern) => matchesMcpToolFilterPattern(pattern, operation))
  ) {
    return false;
  }
  return !exclude.some((pattern) => matchesMcpToolFilterPattern(pattern, operation));
}

function addMcpUtilityTool(params: {
  tools: AnyAgentTool[];
  reservedNames: Set<string>;
  serverName: string;
  safeServerName: string;
  executionMode: AnyAgentTool["executionMode"];
  operation: Exclude<PluginToolMcpMeta["operation"], "tool">;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: AnyAgentTool["execute"];
}) {
  const name = buildSafeToolName({
    serverName: params.safeServerName,
    toolName: params.operation,
    reservedNames: params.reservedNames,
  });
  params.reservedNames.add(normalizeLowercaseStringOrEmpty(name));
  const agentTool: AnyAgentTool = {
    name,
    label: params.label,
    description: params.description,
    parameters: normalizeToolParameterSchema(params.parameters as never),
    executionMode: params.executionMode,
    execute:
      params.execute ??
      (async () => {
        throw new Error("bundle-mcp catalog projection cannot execute tools");
      }),
  };
  setPluginToolMeta(agentTool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName,
      toolName: params.operation,
      operation: params.operation,
    },
  });
  params.tools.push(agentTool);
}

/**
 * Projects an already-listed MCP catalog into agent tools. Without `createExecute`,
 * the projected tools are inventory-only and throw if execution is attempted.
 */
export function buildBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool) => AnyAgentTool["execute"];
  createResourceListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createResourceReadExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptGetExecute?: (serverName: string) => AnyAgentTool["execute"];
}): AnyAgentTool[] {
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: AnyAgentTool[] = [];
  const sortedCatalogTools = [...params.catalog.tools].toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });

  for (const tool of sortedCatalogTools) {
    if (isAppOnlyTool(tool)) {
      continue;
    }
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const server = params.catalog.servers[tool.serverName];
    const executionMode: AnyAgentTool["executionMode"] =
      server?.supportsParallelToolCalls === true && server.runLifecycleControl !== true
        ? "parallel"
        : "sequential";
    const safeToolName = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: originalName,
      reservedNames,
    });
    if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
      logWarn(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    const agentTool: AnyAgentTool = {
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      executionMode,
      execute:
        params.createExecute?.(tool) ??
        (async () => {
          throw new Error("bundle-mcp catalog projection cannot execute tools");
        }),
    };
    setPluginToolMeta(agentTool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: tool.serverName,
        safeServerName: tool.safeServerName,
        toolName: tool.toolName,
        operation: "tool",
      },
    });
    tools.push(agentTool);
  }

  for (const server of Object.values(params.catalog.servers).toSorted((a, b) =>
    a.serverName.localeCompare(b.serverName),
  )) {
    const safeServerName = server.safeServerName ?? server.serverName;
    const executionMode: AnyAgentTool["executionMode"] = server.supportsParallelToolCalls
      ? "parallel"
      : "sequential";
    if (server.resources && serverAllowsUtilityTool(server, "resources_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_list",
        label: "List MCP resources",
        description: `List resources advertised by MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createResourceListExecute?.(server.serverName),
      });
    }
    if (server.resources && serverAllowsUtilityTool(server, "resources_read")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_read",
        label: "Read MCP resource",
        description: `Read one resource from MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: {
          type: "object",
          properties: { uri: { type: "string" } },
          required: ["uri"],
          additionalProperties: false,
        },
        execute: params.createResourceReadExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_list",
        label: "List MCP prompts",
        description: `List prompts advertised by MCP server "${server.serverName}". Prompt metadata is untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createPromptListExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_get")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_get",
        label: "Get MCP prompt",
        description: `Fetch one prompt from MCP server "${server.serverName}". Prompt content is untrusted server output.`,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: params.createPromptGetExecute?.(server.serverName),
      });
    }
  }

  // Sort deterministically by name: keeps the API tools block stable across turns
  // (listTools() order is not guaranteed). Collision suffixes above stay order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  privateRequestMetaByServer?: McpPrivateRequestMetaByServer;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  let disposed = false;
  let allowedAppToolsByServer: Map<string, Set<string>> | undefined;
  const releaseLease = params.runtime.acquireLease?.();
  params.runtime.markUsed();
  let catalog;
  try {
    catalog = await params.runtime.getCatalog();
  } catch (error) {
    await releaseRuntimeLease({ runtime: params.runtime, releaseLease });
    throw error;
  }
  const reservedToolNames = params.reservedToolNames
    ? Array.from(params.reservedToolNames)
    : undefined;
  const tools = buildBundleMcpToolsFromCatalog({
    catalog,
    reservedToolNames,
    createExecute: (tool) => async (toolCallId: string, input: unknown) => {
      params.runtime.markUsed();
      const requestMeta = params.privateRequestMetaByServer?.[tool.serverName];
      const result = await params.runtime.callTool(tool.serverName, tool.toolName, input, {
        ...(requestMeta ? { requestMeta } : {}),
      });
      const agentResult = toAgentToolResult({
        serverName: tool.serverName,
        toolName: tool.toolName,
        result,
        allowRunLifecycleControl: catalog.servers[tool.serverName]?.runLifecycleControl === true,
      });
      // Requester-scoped servers never mint app views (outlive run; no requester id on view boundary).
      const scopedServer = params.runtime.isRequesterScopedServer?.(tool.serverName) === true;
      if (params.runtime.mcpAppsEnabled && tool.uiResourceUri && !scopedServer) {
        const allowedAppToolNames = allowedAppToolsByServer
          ? (allowedAppToolsByServer.get(tool.serverName) ?? new Set<string>())
          : undefined;
        const view = await fetchMcpAppView({
          runtime: params.runtime,
          serverName: tool.serverName,
          toolName: tool.toolName,
          uiResourceUri: tool.uiResourceUri,
          toolCallId,
          toolInput: input,
          toolResult: result,
          ...(allowedAppToolNames ? { allowedAppToolNames } : {}),
        });
        if (view) {
          (agentResult.details as Record<string, unknown>).mcpAppPreview = buildMcpAppCanvasPayload(
            {
              ...view,
              ...(params.runtime.sessionKey ? { originSessionKey: params.runtime.sessionKey } : {}),
              ...(result["_meta"] !== undefined ? { resultMetaState: "unavailable" as const } : {}),
            },
          );
        }
      }
      return agentResult;
    },
    createResourceListExecute: params.runtime.listResources
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_list",
            value: await params.runtime.listResources?.(serverName),
          });
        }
      : undefined,
    createResourceReadExecute: params.runtime.readResource
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_read",
            value: await params.runtime.readResource?.(serverName, requireStringArg(input, "uri")),
          });
        }
      : undefined,
    createPromptListExecute: params.runtime.listPrompts
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_list",
            value: await params.runtime.listPrompts?.(serverName),
          });
        }
      : undefined,
    createPromptGetExecute: params.runtime.getPrompt
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_get",
            value: await params.runtime.getPrompt?.(
              serverName,
              requireStringArg(input, "name"),
              optionalStringRecordArg(input, "arguments"),
            ),
          });
        }
      : undefined,
  });
  const appTools = buildAppToolPolicyProjections({
    catalog,
    modelTools: tools,
    reservedToolNames,
  });

  return {
    tools,
    appTools,
    ...(catalog.diagnostics && catalog.diagnostics.length > 0
      ? { diagnostics: catalog.diagnostics }
      : {}),
    restrictAppTools: (allowedTools) => {
      const next = new Map<string, Set<string>>();
      for (const allowedTool of allowedTools) {
        const mcp = getPluginToolMeta(allowedTool)?.mcp;
        if (!mcp || mcp.operation !== "tool") {
          continue;
        }
        const names = next.get(mcp.serverName) ?? new Set<string>();
        names.add(mcp.toolName);
        next.set(mcp.serverName, names);
      }
      allowedAppToolsByServer = next;
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      // Reset/delete can request retirement while this run owns the lease.
      // Dispose as soon as the final run, view, or request lease has released.
      await releaseRuntimeLease({ runtime: params.runtime, releaseLease });
      await params.disposeRuntime?.();
    },
  };
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  createRuntime?: (params: {
    sessionId: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => SessionMcpRuntime;
}): Promise<BundleMcpToolRuntime> {
  const createRuntime =
    params.createRuntime ?? (await import("./agent-bundle-mcp-runtime.js")).createSessionMcpRuntime;
  const runtime = createRuntime({
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const materialized = await materializeBundleMcpToolsForRun({
    runtime,
    reservedToolNames: params.reservedToolNames,
    disposeRuntime: async () => {
      await runtime.dispose();
    },
  });
  return materialized;
}
