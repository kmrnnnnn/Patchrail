"use client";

import { ExternalLink, RefreshCw, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui";

export function IntegrationActions({
  installationId,
  githubInstallationId,
}: {
  installationId: string;
  githubInstallationId: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: "refresh" | "disconnect") {
    if (
      action === "disconnect" &&
      !window.confirm(
        "Disconnect this GitHub installation from Patchrail? Run history remains available.",
      )
    )
      return;
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(
        action === "refresh"
          ? `/api/github/installations/${installationId}/refresh`
          : `/api/github/installations/${installationId}`,
        { method: action === "refresh" ? "POST" : "DELETE" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        setError(body.error ?? "GitHub action failed");
        if (response.status === 410 || body.code === "INSTALLATION_REVOKED") router.refresh();
      } else {
        router.refresh();
      }
    } catch {
      setError("Patchrail could not reach GitHub. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="integration-actions">
      <Button
        loading={busy === "refresh"}
        onClick={() => call("refresh")}
        size="sm"
        variant="outline"
      >
        <RefreshCw size={15} /> Refresh repositories
      </Button>
      <ButtonLink
        href={`https://github.com/settings/installations/${githubInstallationId}`}
        rel="noopener noreferrer"
        size="sm"
        target="_blank"
        variant="ghost"
      >
        Manage access <ExternalLink size={14} />
      </ButtonLink>
      <Button
        className="integration-actions__disconnect"
        loading={busy === "disconnect"}
        onClick={() => call("disconnect")}
        size="sm"
        variant="ghost"
      >
        <Unplug size={15} /> Disconnect
      </Button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
