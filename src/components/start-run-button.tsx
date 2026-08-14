"use client";

import { ArrowRight, BrainCircuit, Globe2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Dialog, DialogClose } from "@/components/ui";
import { formatUsd } from "@/lib/format";

export function StartRunButton({
  repositoryId,
  maximumCostUsd,
  disabled,
}: {
  repositoryId: string;
  maximumCostUsd: number;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId }),
      });
      const body = (await response.json()) as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error ?? "Could not start the update");
      router.push(`/app/runs/${body.runId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the update");
      setLoading(false);
    }
  }

  return (
    <Dialog
      description="Patchrail creates a Draft PR only after the repository passes its real verification commands."
      footer={
        <div className="dialog-actions">
          <DialogClose>
            <Button type="submit" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button loading={loading} onClick={start}>
            Start AI update <ArrowRight size={16} />
          </Button>
        </div>
      }
      title="Analyze and update external APIs?"
      trigger={<Button disabled={disabled}>Analyze &amp; update APIs</Button>}
    >
      <div className="run-consent">
        <div className="run-consent__item">
          <BrainCircuit size={18} />
          <span>Relevant repository content is sent to OpenAI for analysis and code changes.</span>
        </div>
        <div className="run-consent__item">
          <Globe2 size={18} />
          <span>
            Research uses current public internet sources, prioritizing official documentation.
          </span>
        </div>
        <div className="run-consent__item">
          <ShieldCheck size={18} />
          <span>
            Changes run in an isolated environment; GitHub and infrastructure secrets are never sent
            to the model.
          </span>
        </div>
        <div className="run-consent__cost">
          <span>Maximum AI spend reserved</span>
          <strong>{formatUsd(maximumCostUsd)}</strong>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
