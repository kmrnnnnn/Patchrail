import { readGithubAppEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { verifyGitHubWebhookSignature } from "@/github/security";
import {
  claimGitHubWebhook,
  parseWebhookPayload,
  processGitHubWebhook,
  releaseGitHubWebhook,
} from "@/github/webhooks";

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;
const HEADER_VALUE_MAX_LENGTH = 200;

async function readWebhookBody(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    throw new RangeError("Webhook body is too large");
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BYTES) {
        await reader.cancel("Webhook body is too large");
        throw new RangeError("Webhook body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request): Promise<Response> {
  let deliveryId: string | undefined;
  let claimed = false;
  try {
    const rawBody = await readWebhookBody(request);
    const { GITHUB_WEBHOOK_SECRET } = readGithubAppEnv();
    if (
      !verifyGitHubWebhookSignature(
        rawBody,
        request.headers.get("x-hub-signature-256"),
        GITHUB_WEBHOOK_SECRET,
      )
    ) {
      return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    deliveryId = request.headers.get("x-github-delivery") ?? undefined;
    const eventType = request.headers.get("x-github-event") ?? "";
    if (
      !deliveryId ||
      deliveryId.length > HEADER_VALUE_MAX_LENGTH ||
      eventType.length === 0 ||
      eventType.length > HEADER_VALUE_MAX_LENGTH
    ) {
      return Response.json({ error: "Missing GitHub webhook headers" }, { status: 400 });
    }

    claimed = await claimGitHubWebhook(deliveryId, eventType);
    if (!claimed) return Response.json({ accepted: true, duplicate: true });
    const payload = parseWebhookPayload(rawBody);
    await processGitHubWebhook(eventType, payload);
    return Response.json({ accepted: true });
  } catch (error) {
    if (claimed && deliveryId) {
      // A failed delivery is released so GitHub's retry can process it. Successful
      // deliveries remain as the durable idempotency record.
      await releaseGitHubWebhook(deliveryId).catch(() => undefined);
    }
    if (error instanceof RangeError) {
      return Response.json({ error: "Webhook body is too large" }, { status: 413 });
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.message.includes("JSON") || error.message.includes("Webhook payload")))
    ) {
      return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
    }
    logger.error("github_webhook_failed", { errorCode: "GITHUB_WEBHOOK_FAILED" });
    return Response.json({ error: "Webhook processing failed" }, { status: 503 });
  }
}
