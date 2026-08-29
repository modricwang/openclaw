import type { AgentMessage } from "./types.js";

export const TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE = "openclaw_transcript_not_continuable";
export const REQUIRED_TOOL_LIFECYCLE_INCIDENT_CODE =
  "openclaw_required_tool_lifecycle_incident_v1";

export type RequiredToolLifecycleIncident = {
  contract_id: typeof REQUIRED_TOOL_LIFECYCLE_INCIDENT_CODE;
  stage: "required_tool";
  tool: string;
  reason:
    | "provider_initial_call_invalid"
    | "required_tool_failed"
    | "required_tool_unavailable";
  execution_started: boolean | null;
  retry_allowed: false;
};

export class RequiredToolLifecycleError extends Error {
  public readonly code = REQUIRED_TOOL_LIFECYCLE_INCIDENT_CODE;
  public readonly publicText =
    "这次必要步骤没有成功完成；我没有复用旧结果，也没有把它算作静默或已送达。";
  public readonly runLifecycleIncident: RequiredToolLifecycleIncident;

  constructor(params: {
    toolName: string;
    reason: RequiredToolLifecycleIncident["reason"];
    executionStarted: boolean | null;
  }) {
    super(`Required lifecycle tool "${params.toolName}" failed: ${params.reason}.`);
    this.name = "RequiredToolLifecycleError";
    this.runLifecycleIncident = {
      contract_id: REQUIRED_TOOL_LIFECYCLE_INCIDENT_CODE,
      stage: "required_tool",
      tool: params.toolName,
      reason: params.reason,
      execution_started: params.executionStarted,
      retry_allowed: false,
    };
  }
}

export class TranscriptNotContinuableError extends Error {
  public readonly code = TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE;
  public readonly role: AgentMessage["role"];

  constructor(role: AgentMessage["role"]) {
    super(`Cannot continue from message role: ${role}`);
    this.name = "TranscriptNotContinuableError";
    this.role = role;
  }
}
