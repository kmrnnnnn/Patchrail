import { zodTextFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";

const supportedStringFormats = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

const postResponseValidationKeywords = new Set([
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "default",
]);

const unsupportedCompositionKeywords = [
  "allOf",
  "oneOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeSchemaProviderCompatible(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`OpenAI Structured Outputs schema is invalid at ${path}`);
  }

  for (const keyword of postResponseValidationKeywords) delete value[keyword];
  if (typeof value.format === "string" && !supportedStringFormats.has(value.format)) {
    delete value.format;
  }

  for (const keyword of unsupportedCompositionKeywords) {
    if (keyword in value) {
      throw new Error(`OpenAI Structured Outputs does not support ${keyword} at ${path}`);
    }
  }

  if (value.type === "object") {
    if (!isRecord(value.properties)) {
      throw new Error(`OpenAI Structured Outputs object is missing properties at ${path}`);
    }
    if (value.additionalProperties !== false) {
      throw new Error(`OpenAI Structured Outputs requires additionalProperties=false at ${path}`);
    }
    if (!Array.isArray(value.required)) {
      throw new Error(`OpenAI Structured Outputs object is missing required fields at ${path}`);
    }
    const propertyNames = Object.keys(value.properties).sort();
    const requiredNames = value.required
      .filter((item): item is string => typeof item === "string")
      .sort();
    if (
      requiredNames.length !== value.required.length ||
      propertyNames.length !== requiredNames.length ||
      propertyNames.some((name, index) => name !== requiredNames[index])
    ) {
      throw new Error(`OpenAI Structured Outputs requires every property at ${path}`);
    }
  }

  if (isRecord(value.properties)) {
    for (const [name, propertySchema] of Object.entries(value.properties)) {
      makeSchemaProviderCompatible(propertySchema, `${path}.properties.${name}`);
    }
  }
  if (isRecord(value.items)) {
    makeSchemaProviderCompatible(value.items, `${path}.items`);
  }
  if (Array.isArray(value.anyOf)) {
    value.anyOf.forEach((schema, index) =>
      makeSchemaProviderCompatible(schema, `${path}.anyOf[${index}]`),
    );
  }
  for (const definitionsKey of ["$defs", "definitions"] as const) {
    const definitions = value[definitionsKey];
    if (!isRecord(definitions)) continue;
    for (const [name, definitionSchema] of Object.entries(definitions)) {
      makeSchemaProviderCompatible(definitionSchema, `${path}.${definitionsKey}.${name}`);
    }
  }
}

/**
 * Keeps the SDK's original Zod parser for application validation while limiting
 * the JSON Schema sent to OpenAI to its supported Structured Outputs subset.
 */
export function openAiTextFormat<Output>(schema: ZodType<Output>, name: string) {
  const format = zodTextFormat(schema, name);
  openAiStrictJsonSchema(format.schema);

  return format;
}

export function openAiStrictJsonSchema<Schema extends Record<string, unknown>>(
  schema: Schema,
): Schema {
  makeSchemaProviderCompatible(schema, "$schema");

  if (schema.type !== "object" || "anyOf" in schema) {
    throw new Error("OpenAI Structured Outputs requires an object root without anyOf");
  }

  return schema;
}
