"use client";

import { Github } from "lucide-react";
import { useState } from "react";

import { authClient } from "@/auth/client";
import { Button } from "@/components/ui";

export function GitHubLoginButton({ disabled = false }: { disabled?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL: "/app",
      });
      if (result.error) {
        setError(result.error.message ?? "GitHub sign-in could not be started. Please try again.");
        setLoading(false);
      }
    } catch {
      setError("GitHub sign-in could not be started. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="login-action">
      <Button
        className="login-action__button"
        disabled={disabled}
        loading={loading}
        onClick={signIn}
        size="lg"
      >
        {!loading ? <Github aria-hidden="true" size={19} /> : null}
        {loading ? "Connecting to GitHub…" : "Continue with GitHub"}
      </Button>
      {disabled ? (
        <p className="login-action__error" role="status">
          GitHub sign-in is temporarily unavailable because authentication is not configured.
        </p>
      ) : null}
      {error ? (
        <p className="login-action__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
