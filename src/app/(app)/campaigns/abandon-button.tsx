"use client";

import { abandonCampaign } from "@/lib/session-zero/actions";
import { useState, useTransition } from "react";

/**
 * Confirm-then-soft-delete control for an in-flight SZ campaign.
 * Two-stage click prevents accidental abandons. Disabled-while-
 * pending; the page revalidates on success and the row disappears.
 */
export default function AbandonButton({ campaignId }: { campaignId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const onClick = () => {
    setError(null);
    if (!confirming) {
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      const result = await abandonCampaign(campaignId);
      if (!result.ok) {
        setError(result.message);
        setConfirming(false);
      }
    });
  };

  return (
    <div className="flex items-center border-l">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className={
          confirming
            ? "px-4 text-destructive text-xs hover:bg-destructive/10 disabled:opacity-60"
            : "px-4 text-muted-foreground text-xs hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
        }
        aria-label={confirming ? "Confirm abandon" : "Abandon Session Zero"}
        title={error ?? undefined}
      >
        {isPending ? "abandoning…" : confirming ? "confirm?" : "abandon"}
      </button>
    </div>
  );
}
