import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";
import {
  clearInstallationSuspension,
  setInstallationAvailability,
  syncInstallationsByGitHubId,
} from "@/github/installations";

type WebhookPayload = Record<string, unknown>;

function installationIdFromPayload(payload: WebhookPayload): number | null {
  const installation = payload.installation;
  if (typeof installation !== "object" || installation === null || !("id" in installation)) {
    return null;
  }
  const id = (installation as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function actionFromPayload(payload: WebhookPayload): string | null {
  return typeof payload.action === "string" ? payload.action : null;
}

export async function claimGitHubWebhook(deliveryId: string, eventType: string): Promise<boolean> {
  const [claimed] = await db
    .insert(webhookDeliveries)
    .values({ id: deliveryId, provider: "github", eventType })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return claimed !== undefined;
}

export async function releaseGitHubWebhook(deliveryId: string): Promise<void> {
  await db
    .delete(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.provider, "github")));
}

export async function processGitHubWebhook(
  eventType: string,
  payload: WebhookPayload,
): Promise<void> {
  if (eventType === "ping") return;
  const installationId = installationIdFromPayload(payload);
  if (installationId === null) return;
  const action = actionFromPayload(payload);

  if (eventType === "installation") {
    if (action === "deleted") {
      await setInstallationAvailability({ githubInstallationId: installationId, state: "DELETED" });
      return;
    }
    if (action === "suspend") {
      await setInstallationAvailability({
        githubInstallationId: installationId,
        state: "SUSPENDED",
      });
      return;
    }
    if (action === "unsuspend") {
      await clearInstallationSuspension(installationId);
      await syncInstallationsByGitHubId(installationId);
      return;
    }
    if (action === "created" || action === "new_permissions_accepted") {
      // A newly-created installation is associated by the state-verified setup
      // callback. If that callback has already completed, this is an idempotent sync.
      await syncInstallationsByGitHubId(installationId);
    }
    return;
  }

  if (eventType === "installation_repositories" || eventType === "repository") {
    await syncInstallationsByGitHubId(installationId);
  }
}

export function parseWebhookPayload(rawBody: Uint8Array): WebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new Error("Webhook body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Webhook payload must be an object");
  }
  return parsed as WebhookPayload;
}
