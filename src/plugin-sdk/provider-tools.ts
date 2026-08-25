import {
  cleanSchemaForGemini,
  findOpenAIStrictSchemaViolations,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
  normalizeOpenAIStrictCompatSchema,
  stripUnsupportedSchemaKeywords,
} from "@openclaw/ai/internal/openai";
// Provider tool helpers expose shared tool-call payload contracts for provider plugins.
import type { TSchema } from "typebox";
import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderToolSchemaDiagnostic,
} from "./plugin-entry.js";

export {
  cleanSchemaForGemini,
  findOpenAIStrictSchemaViolations,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
  stripUnsupportedSchemaKeywords,
};

/**
 * Finds unsupported JSON-schema keywords and reports their nested schema paths.
 */
export function findUnsupportedSchemaKeywords(
  /** JSON schema node to inspect recursively. */
  schema: unknown,
  /** Dot/bracket path prefix used in returned diagnostics. */
  path: string,
  /** Schema keywords unsupported by the target provider family. */
  unsupportedKeywords: ReadonlySet<string>,
): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findUnsupportedSchemaKeywords(item, `${path}[${index}]`, unsupportedKeywords),
    );
  }
  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(
        ...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`, unsupportedKeywords),
      );
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") {
      continue;
    }
    if (unsupportedKeywords.has(key)) {
      violations.push(`${path}.${key}`);
    }
    if (value && typeof value === "object") {
      violations.push(
        ...findUnsupportedSchemaKeywords(value, `${path}.${key}`, unsupportedKeywords),
      );
    }
  }
  return violations;
}

/**
 * Rewrites tool schemas into Gemini-compatible JSON schema before provider dispatch.
 */
export function normalizeGeminiToolSchemas(
  /** Provider tool-schema normalization context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: cleanSchemaForGemini(tool.parameters),
    };
  });
}

/**
 * Reports Gemini-incompatible schema keywords without mutating tool definitions.
 */
export function inspectGeminiToolSchemas(
  /** Provider tool-schema inspection context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findUnsupportedSchemaKeywords(
      tool.parameters,
      `${tool.name}.parameters`,
      GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
    );
    if (violations.length === 0) {
      return [];
    }
    return [{ toolName: tool.name, toolIndex, violations }];
  });
}

/**
 * Rewrites OpenAI-native tool schemas to satisfy strict object-schema requirements.
 */
export function normalizeOpenAIToolSchemas(
  /** Provider tool-schema normalization context used to detect native OpenAI strict routes. */
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  if (!shouldApplyOpenAIToolCompat(ctx)) {
    return ctx.tools;
  }
  return ctx.tools.map((tool) => {
    if (tool.parameters == null) {
      return {
        ...tool,
        parameters: normalizeOpenAIStrictCompatSchema({}),
      };
    }
    if (typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: normalizeOpenAIStrictCompatSchema(tool.parameters),
    };
  });
}

function shouldApplyOpenAIToolCompat(ctx: ProviderNormalizeToolSchemasContext): boolean {
  const provider = (ctx.model?.provider ?? ctx.provider ?? "").trim().toLowerCase();
  const api = (ctx.model?.api ?? ctx.modelApi ?? "").trim().toLowerCase();
  const baseUrl = (ctx.model?.baseUrl ?? "").trim().toLowerCase();

  if (provider === "openai") {
    if (api === "openai-responses") {
      // Strict-schema normalization is only safe for the native OpenAI endpoint;
      // OpenAI-compatible proxies may accept broader schemas or define their own rules.
      return !baseUrl || isOpenAIResponsesBaseUrl(baseUrl);
    }
    return (
      api === "openai-chatgpt-responses" &&
      // Codex/ChatGPT Responses uses the same strict object-schema contract as native
      // OpenAI Responses, but only on the known first-party backend URLs.
      (!baseUrl || isOpenAIResponsesBaseUrl(baseUrl) || isOpenAICodexBaseUrl(baseUrl))
    );
  }
  return false;
}

function isOpenAIResponsesBaseUrl(baseUrl: string): boolean {
  return /^https:\/\/api\.openai\.com(?:\/v1)?(?:\/|$)/i.test(baseUrl);
}

function isOpenAICodexBaseUrl(baseUrl: string): boolean {
  return /^https:\/\/chatgpt\.com\/backend-api(?:\/|$)/i.test(baseUrl);
}

/**
 * Reports OpenAI strict-schema diagnostics for transports that enforce them before dispatch.
 */
export function inspectOpenAIToolSchemas(
  /** Provider tool-schema inspection context used to detect native OpenAI strict routes. */
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  if (!shouldApplyOpenAIToolCompat(ctx)) {
    return [];
  }
  // Native OpenAI transports fall back to `strict: false` when any tool schema is not
  // strict-compatible, so these findings are expected for optional-heavy tool schemas.
  return [];
}

/**
 * DeepSeek rejects union keywords in tool schemas.
 */
export const DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["anyOf", "oneOf"]);

function isNullSchemaVariant(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const record = schema as Record<string, unknown>;
  if (record.type === "null") {
    return true;
  }
  if (Array.isArray(record.type) && record.type.length === 1 && record.type[0] === "null") {
    return true;
  }
  if ("const" in record && record.const === null) {
    return true;
  }
  return Array.isArray(record.enum) && record.enum.length === 1 && record.enum[0] === null;
}

function normalizeDeepSeekSchema(
  schema: unknown,
  rootSchema: unknown = schema,
  resolvingRefs: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeDeepSeekSchema(entry, rootSchema, resolvingRefs);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  const unionKey = Array.isArray(record.anyOf)
    ? "anyOf"
    : Array.isArray(record.oneOf)
      ? "oneOf"
      : undefined;

  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "anyOf" || key === "oneOf") {
      if (key === unionKey) {
        changed = true;
        continue;
      }
    }
    const next = normalizeDeepSeekSchema(value, rootSchema, resolvingRefs);
    normalized[key] = next;
    changed ||= next !== value;
  }

  if (!unionKey) {
    return changed ? normalized : schema;
  }

  const variants = record[unionKey] as unknown[];
  const normalizedVariants = variants.map((entry) =>
    normalizeDeepSeekSchema(entry, rootSchema, resolvingRefs),
  );
  const nonNullVariants = normalizedVariants.filter((entry) => !isNullSchemaVariant(entry));
  const hasNullVariant = nonNullVariants.length < normalizedVariants.length;

  // Preserve string-const unions as a flat string enum so DeepSeek tool
  // callers still see every allowed literal. Without this, a Typebox
  // `Type.Union([Type.Literal("a"), Type.Literal("b"), ...])` collapses to
  // only the first const and the model can never pick any other value.
  if (nonNullVariants.length > 1 && nonNullVariants.every((entry) => isStringConstVariant(entry))) {
    const enumValues = nonNullVariants.map((entry) => (entry as { const: string }).const);
    const merged: Record<string, unknown> = {
      ...normalized,
      type: "string",
      enum: enumValues,
    };
    if (hasNullVariant) {
      merged.nullable = true;
    }
    return merged;
  }

  const objectVariants = nonNullVariants.map((entry) =>
    resolveDeepSeekObjectVariant(entry, rootSchema, resolvingRefs),
  );
  if (objectVariants.length > 1 && objectVariants.every((entry) => entry !== undefined)) {
    const mergedObject = mergeDeepSeekDiscriminatedObjectUnion(
      objectVariants as Array<Record<string, unknown>>,
      normalized,
    );
    if (mergedObject) {
      if (hasNullVariant) {
        mergedObject.nullable = true;
      }
      return mergedObject;
    }
  }

  const selected = nonNullVariants[0] ?? normalizedVariants[0];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    return normalized;
  }

  const merged = {
    ...(selected as Record<string, unknown>),
    ...normalized,
  };
  if (hasNullVariant) {
    merged.nullable = true;
  }
  return merged;
}

function resolveDeepSeekObjectVariant(
  schema: unknown,
  rootSchema: unknown,
  resolvingRefs: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (typeof record.$ref !== "string") {
    return record;
  }
  const ref = record.$ref;
  if (resolvingRefs.has(ref)) {
    throw new Error(`DeepSeek schema projection encountered a cyclic local ref: ${ref}`);
  }
  const target = resolveLocalSchemaRef(rootSchema, ref);
  if (target === undefined) {
    throw new Error(`DeepSeek schema projection could not resolve local ref: ${ref}`);
  }
  const nextRefs = new Set(resolvingRefs);
  nextRefs.add(ref);
  const resolved = normalizeDeepSeekSchema(target, rootSchema, nextRefs);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new Error(`DeepSeek schema projection resolved a non-object branch: ${ref}`);
  }
  const siblings = { ...record };
  delete siblings.$ref;
  return { ...(resolved as Record<string, unknown>), ...siblings };
}

function resolveLocalSchemaRef(rootSchema: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = rootSchema;
  for (const encodedPart of ref.slice(2).split("/")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    const part = encodedPart.replace(/~1/g, "/").replace(/~0/g, "~");
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function mergeDeepSeekDiscriminatedObjectUnion(
  variants: Array<Record<string, unknown>>,
  outer: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const propertySets = variants.map((variant) =>
    variant.properties && typeof variant.properties === "object" && !Array.isArray(variant.properties)
      ? (variant.properties as Record<string, unknown>)
      : undefined,
  );
  if (propertySets.some((properties) => properties === undefined)) {
    return undefined;
  }
  const properties = propertySets as Array<Record<string, unknown>>;
  const discriminator = Object.keys(properties[0] ?? {}).find((name) => {
    const values = properties.map((entry) => stringConstValue(entry[name]));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
  if (!discriminator) {
    return undefined;
  }

  const mergedProperties: Record<string, unknown> = {};
  for (const branchProperties of properties) {
    for (const [name, propertySchema] of Object.entries(branchProperties)) {
      if (!(name in mergedProperties)) {
        mergedProperties[name] = propertySchema;
        continue;
      }
      if (name === discriminator) {
        continue;
      }
      const mergedProperty = mergeDeepSeekCompatiblePropertySchemas(
        mergedProperties[name],
        propertySchema,
      );
      if (mergedProperty === undefined) {
        throw new Error(
          `DeepSeek schema projection found incompatible property schemas: ${discriminator}.${name}`,
        );
      }
      mergedProperties[name] = mergedProperty;
    }
  }

  const discriminatorValues = properties.map((entry) => stringConstValue(entry[discriminator]));
  const firstDiscriminator = properties[0]?.[discriminator];
  const discriminatorRecord =
    firstDiscriminator && typeof firstDiscriminator === "object" && !Array.isArray(firstDiscriminator)
      ? { ...(firstDiscriminator as Record<string, unknown>) }
      : {};
  delete discriminatorRecord.const;
  mergedProperties[discriminator] = {
    ...discriminatorRecord,
    type: "string",
    enum: discriminatorValues,
  };

  const requiredSets = variants.map(
    (variant) => new Set(Array.isArray(variant.required) ? variant.required.map(String) : []),
  );
  const required = [...(requiredSets[0] ?? new Set<string>())].filter((name) =>
    requiredSets.every((entry) => entry.has(name)),
  );
  const outerRequired = Array.isArray(outer.required) ? outer.required.map(String) : [];
  const mergedRequired = [...new Set([...outerRequired, ...required])];
  const merged: Record<string, unknown> = {
    ...outer,
    type: "object",
    properties: mergedProperties,
  };
  if (mergedRequired.length > 0) {
    merged.required = mergedRequired;
  }
  if (
    merged.additionalProperties === undefined &&
    variants.every((variant) => variant.additionalProperties === false)
  ) {
    merged.additionalProperties = false;
  }
  return merged;
}

function stringConstValue(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (typeof record.const === "string") {
    return record.const;
  }
  if (Array.isArray(record.enum) && record.enum.length === 1 && typeof record.enum[0] === "string") {
    return record.enum[0];
  }
  return undefined;
}

function mergeDeepSeekCompatiblePropertySchemas(
  left: unknown,
  right: unknown,
): unknown | undefined {
  if (deepSeekSchemasStructurallyEqual(left, right)) {
    return left;
  }
  const leftValues = deepSeekStringSchemaValues(left);
  const rightValues = deepSeekStringSchemaValues(right);
  if (leftValues === undefined || rightValues === undefined) {
    return undefined;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...leftRecord, type: "string" };
  delete merged.const;
  delete merged.enum;
  delete merged.default;
  if (leftValues !== null && rightValues !== null) {
    merged.enum = [...new Set([...leftValues, ...rightValues])];
  }
  if (leftRecord.nullable === true || rightRecord.nullable === true) {
    merged.nullable = true;
  }
  return merged;
}

function deepSeekStringSchemaValues(schema: unknown): string[] | null | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (record.type !== "string") {
    return undefined;
  }
  if (typeof record.const === "string") {
    return [record.const];
  }
  if (Array.isArray(record.enum)) {
    return record.enum.every((entry) => typeof entry === "string")
      ? (record.enum as string[])
      : undefined;
  }
  return null;
}

const DEEPSEEK_SCHEMA_ANNOTATION_KEYS = new Set(["title", "description", "default", "examples"]);

function deepSeekSchemaShape(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => deepSeekSchemaShape(entry));
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => !DEEPSEEK_SCHEMA_ANNOTATION_KEYS.has(key))
      .map(([key, value]) => [key, deepSeekSchemaShape(value)]),
  );
}

function deepSeekSchemasStructurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(deepSeekSchemaShape(left)) === JSON.stringify(deepSeekSchemaShape(right));
}

function isStringConstVariant(entry: unknown): entry is { const: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return typeof record.const === "string";
}

/**
 * Rewrites DeepSeek-incompatible union schemas into the closest accepted shape.
 */
export function normalizeDeepSeekToolSchemas(
  /** Provider tool-schema normalization context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    const parameters = normalizeDeepSeekSchema(tool.parameters);
    return parameters === tool.parameters
      ? tool
      : {
          ...tool,
          parameters: parameters as TSchema,
        };
  });
}

/**
 * Reports DeepSeek-incompatible union schema paths without mutating tool definitions.
 */
export function inspectDeepSeekToolSchemas(
  /** Provider tool-schema inspection context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findUnsupportedSchemaKeywords(
      tool.parameters,
      `${tool.name}.parameters`,
      DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS,
    );
    if (violations.length === 0) {
      return [];
    }
    return [{ toolName: tool.name, toolIndex, violations }];
  });
}

/**
 * Supported provider tool-schema compatibility families.
 */
export type ProviderToolCompatFamily = "deepseek" | "gemini" | "openai";

/**
 * Returns the normalizer and inspector pair for a provider tool-schema compatibility family.
 */
export function buildProviderToolCompatFamilyHooks(
  /** Provider tool-schema compatibility family to route to normalizer/inspector hooks. */
  family: ProviderToolCompatFamily,
): {
  /** Mutating-compatible hook that returns tool definitions accepted by the provider family. */
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[];
  /** Non-mutating hook that reports provider-family schema incompatibilities. */
  inspectToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => ProviderToolSchemaDiagnostic[];
} {
  switch (family) {
    case "deepseek":
      return {
        normalizeToolSchemas: normalizeDeepSeekToolSchemas,
        inspectToolSchemas: inspectDeepSeekToolSchemas,
      };
    case "gemini":
      return {
        normalizeToolSchemas: normalizeGeminiToolSchemas,
        inspectToolSchemas: inspectGeminiToolSchemas,
      };
    case "openai":
      return {
        normalizeToolSchemas: normalizeOpenAIToolSchemas,
        inspectToolSchemas: inspectOpenAIToolSchemas,
      };
  }
  throw new Error("Unsupported provider tool compatibility family");
}
