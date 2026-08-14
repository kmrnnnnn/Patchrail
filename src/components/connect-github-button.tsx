"use client";

import { Github } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui";

export function ConnectGitHubButton({
  children,
  ...buttonProps
}: Omit<ButtonProps, "children" | "loading" | "onClick" | "type"> & {
  children?: ReactNode;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/github/install", { method: "POST" });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? "Could not start GitHub setup");
      window.location.assign(body.url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start GitHub setup");
      setLoading(false);
    }
  }

  return (
    <div className="connect-github-action">
      <Button {...buttonProps} loading={loading} onClick={connect} type="button">
        {children ?? (
          <>
            <Github size={16} /> Connect GitHub
          </>
        )}
      </Button>
      {error ? (
        <span className="form-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
