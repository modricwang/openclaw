// Stream payload utilities normalize provider stream payload fields for wrappers.
import type { StreamFn } from "@openclaw/llm-core";

function patchPayloadObject(
  payload: unknown,
  patchPayload: (payload: Record<string, unknown>) => void,
): void {
  if (payload && typeof payload === "object") {
    patchPayload(payload as Record<string, unknown>);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function patchPayloadHookResult(
  originalPayload: unknown,
  nextPayload: unknown,
  patchPayload: (payload: Record<string, unknown>) => void,
): unknown {
  const finalPayload = nextPayload === undefined ? originalPayload : nextPayload;
  patchPayloadObject(finalPayload, patchPayload);
  return nextPayload === undefined ? undefined : finalPayload;
}

/** Wraps a stream function and lets callers mutate outgoing provider payload objects. */
export function streamWithPayloadPatch(
  underlying: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  patchPayload: (payload: Record<string, unknown>) => void,
  patchOptions?: { reapplyToReplacement?: boolean },
): ReturnType<StreamFn> {
  const originalOnPayload = options?.onPayload;
  return underlying(model, context, {
    ...options,
    onPayload: (payload) => {
      // Payload hooks receive mutable provider request objects before the underlying sender uses them.
      patchPayloadObject(payload, patchPayload);
      const nextPayload = originalOnPayload?.(payload, model);
      if (patchOptions?.reapplyToReplacement !== true) {
        return nextPayload;
      }
      if (isPromiseLike(nextPayload)) {
        return Promise.resolve(nextPayload).then((resolvedPayload) =>
          patchPayloadHookResult(payload, resolvedPayload, patchPayload),
        );
      }
      return patchPayloadHookResult(payload, nextPayload, patchPayload);
    },
  });
}
