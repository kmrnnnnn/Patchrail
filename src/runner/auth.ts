import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";

export class RunnerRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RunnerRequestError";
    this.status = status;
  }
}

export function authenticateRunnerRequest(request: Request): boolean {
  const expected = process.env.RUNNER_SHARED_SECRET;
  const authorization = request.headers.get("authorization");
  if (!expected || Buffer.byteLength(expected) < 32 || !authorization?.startsWith("Bearer ")) {
    return false;
  }
  const supplied = authorization.slice("Bearer ".length);
  if (!supplied || /\s/.test(supplied)) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export function runnerUnauthorized(): Response {
  return runnerJson({ error: "Runner authentication failed" }, { status: 401 });
}

export function runnerJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(body, { ...init, headers });
}

export function runnerRequestError(error: unknown): Response | null {
  if (!(error instanceof RunnerRequestError)) return null;
  return runnerJson({ error: error.message }, { status: error.status });
}

export async function parseRunnerJson<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
  maximumBytes: number,
): Promise<z.output<TSchema>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RunnerRequestError("Content-Type must be application/json", 415);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new RunnerRequestError("Invalid Content-Length header");
    }
    if (parsedLength > maximumBytes) {
      throw new RunnerRequestError("Runner request body is too large", 413);
    }
  }

  if (!request.body) throw new RunnerRequestError("A JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Runner request body exceeded its size limit");
        throw new RunnerRequestError("Runner request body is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total,
      ).toString("utf8"),
    );
  } catch {
    throw new RunnerRequestError("Runner request body is not valid JSON");
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new RunnerRequestError("Runner request body is invalid");
  return parsed.data;
}
