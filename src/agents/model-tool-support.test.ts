// Documents model tool-support compatibility defaults.
import { describe, expect, it } from "vitest";
import {
  resolveParallelToolCallsControlCapability,
  supportsModelTools,
} from "./model-tool-support.js";

describe("supportsModelTools", () => {
  it("defaults to true when the model has no compat override", () => {
    expect(supportsModelTools({} as never)).toBe(true);
  });

  it("returns true when compat.supportsTools is true", () => {
    expect(supportsModelTools({ compat: { supportsTools: true } } as never)).toBe(true);
  });

  it("returns false when compat.supportsTools is false", () => {
    expect(supportsModelTools({ compat: { supportsTools: false } } as never)).toBe(false);
  });
});

describe("resolveParallelToolCallsControlCapability", () => {
  it("keeps absent compatibility metadata unknown", () => {
    expect(resolveParallelToolCallsControlCapability({})).toBe("unknown");
  });

  it("resolves an explicitly supported route", () => {
    expect(
      resolveParallelToolCallsControlCapability({
        compat: { supportsParallelToolCallsControl: true },
      }),
    ).toBe("supported");
  });

  it("resolves an explicitly unsupported route", () => {
    expect(
      resolveParallelToolCallsControlCapability({
        compat: { supportsParallelToolCallsControl: false },
      }),
    ).toBe("unsupported");
  });
});
