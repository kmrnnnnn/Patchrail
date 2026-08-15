"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui";

type ReconciliationResponse = { installationCount?: number; error?: string; code?: string };

class ReconciliationError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReconciliationError";
  }
}

async function reconcile(signal?: AbortSignal): Promise<ReconciliationResponse> {
  const response = await fetch("/api/github/installations/reconcile", {
    method: "POST",
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as ReconciliationResponse;
  if (!response.ok) {
    throw new ReconciliationError(
      body.error ?? "Could not refresh GitHub repositories",
      body.code,
      response.status,
    );
  }
  return body;
}

export function RefreshGitHubButton(
  props: Omit<ButtonProps, "children" | "loading" | "onClick" | "type">,
) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      await reconcile();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh GitHub repositories");
      if (
        caught instanceof ReconciliationError &&
        (caught.status === 410 || caught.code === "INSTALLATION_REVOKED")
      ) {
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="connect-github-action">
      <Button {...props} loading={loading} onClick={refresh} type="button">
        <RefreshCw aria-hidden="true" size={15} /> Refresh repositories
      </Button>
      {error ? (
        <span className="form-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Runs the idempotent, CSRF-protected reconciliation POST when an authenticated
 * page has no local installation. Connect controls appear only after GitHub has
 * confirmed that there is nothing to recover, or discovery reports an error. */
export function GitHubInstallationRecovery({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    reconcile(controller.signal)
      .then((result) => {
        if (cancelled) return;
        if ((result.installationCount ?? 0) > 0) router.refresh();
        else setChecking(false);
      })
      .catch((caught: unknown) => {
        if (cancelled || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setError(caught instanceof Error ? caught.message : "Could not check GitHub installations");
        setChecking(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [router]);

  if (checking) {
    return (
      <p className="muted" role="status">
        Checking existing GitHub installations…
      </p>
    );
  }

  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {children}
    </>
  );
}
