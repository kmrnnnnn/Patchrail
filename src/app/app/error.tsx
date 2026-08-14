"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { Button, ButtonLink, Card } from "@/components/ui";

export default function ProductError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Patchrail page error", { digest: error.digest });
  }, [error]);

  return (
    <div className="product-page product-page--narrow">
      <Card className="product-error">
        <span className="product-error__icon">
          <AlertTriangle aria-hidden="true" size={22} />
        </span>
        <h1>This page could not be loaded</h1>
        <p>Your workspace data was not changed. Try loading the page again.</p>
        {error.digest ? (
          <code className="product-error__digest">Reference {error.digest}</code>
        ) : null}
        <div className="product-error__actions">
          <Button onClick={reset}>
            <RefreshCw aria-hidden="true" size={16} /> Try again
          </Button>
          <ButtonLink href="/app" variant="outline">
            Back to overview
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
