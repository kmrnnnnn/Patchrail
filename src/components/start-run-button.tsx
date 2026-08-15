"use client";

import { ArrowRight, BrainCircuit, Globe2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Dialog, DialogClose } from "@/components/ui";

type StartRunResponse = { runId?: string; error?: string; code?: string };

export async function readStartRunResponse(response: Response): Promise<StartRunResponse | null> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) return null;

  const text = await response.text();
  if (!text.trim()) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      ...(typeof value.code === "string" ? { code: value.code } : {}),
    };
  } catch {
    return null;
  }
}

function unexpectedResponseMessage(response: Response): string {
  return `Patchrail returned an unexpected response (HTTP ${response.status}). Refresh this repository before trying again.`;
}

export function StartRunButton({
  repositoryId,
  disabled,
}: {
  repositoryId: string;
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
      const body = await readStartRunResponse(response);
      if (!body) throw new Error(unexpectedResponseMessage(response));
      if (!response.ok || !body.runId) {
        throw new Error(body.error ?? unexpectedResponseMessage(response));
      }
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
          <span>
            Relevant repository content is sent to Patchrail’s configured analysis provider to
            understand integrations and prepare focused code changes.
          </span>
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
            Changes run in an isolated environment; GitHub, billing, and infrastructure secrets are
            never included in analysis context.
          </span>
        </div>
        <div className="run-consent__cost">
          <span>Plan allowance</span>
          <strong>Included with your Patchrail plan</strong>
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
