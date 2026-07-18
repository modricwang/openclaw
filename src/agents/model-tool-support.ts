/**
 * Model capability helper for tool-use support.
 *
 * Provider catalogs can opt a model out via `compat.supportsTools === false`;
 * absent metadata remains permissive for older catalog entries.
 */
/** Returns whether a catalog model should be offered tool calls. */
export function supportsModelTools(model: { compat?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsTools?: boolean })
      : undefined;
  return compat?.supportsTools !== false;
}

export type ParallelToolCallsControlCapability = "supported" | "unsupported" | "unknown";

/**
 * Resolves whether the concrete provider route natively honors disabling
 * parallel tool calls. Unknown must never be promoted to supported.
 */
export function resolveParallelToolCallsControlCapability(model: {
  compat?: unknown;
}): ParallelToolCallsControlCapability {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsParallelToolCallsControl?: boolean })
      : undefined;
  const support = compat?.supportsParallelToolCallsControl;
  return support === true ? "supported" : support === false ? "unsupported" : "unknown";
}
