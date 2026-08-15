import type { Metadata } from "next";
import { ArrowRight, Check, Github, Gauge, GitPullRequestDraft } from "lucide-react";

import { ButtonLink } from "@/components/ui";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Start with one repository, then move to Pro for more repository capacity and a monthly Patchrail update allowance.",
};

function configuredLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function repositoryLabel(limit: number): string {
  return `${limit} enabled ${limit === 1 ? "repository" : "repositories"}`;
}

function PlanCard({
  name,
  summary,
  price,
  features,
  featured = false,
}: {
  name: string;
  summary: string;
  price: string;
  features: string[];
  featured?: boolean;
}) {
  return (
    <article className={featured ? "pricing-card pricing-card--featured" : "pricing-card"}>
      {featured ? <span className="pricing-card__flag">For ongoing maintenance</span> : null}
      <div className="pricing-card__header">
        <p className="pricing-card__name">{name}</p>
        <p className="pricing-card__summary">{summary}</p>
        <div className="pricing-card__price">
          <strong>{price}</strong>
          {name === "Pro" ? (
            <span>Monthly price shown before checkout</span>
          ) : (
            <span>No card required</span>
          )}
        </div>
      </div>
      <ButtonLink href="/login" size="lg" variant={featured ? "primary" : "outline"}>
        {name === "Free" ? "Start free" : "Get started"} <ArrowRight aria-hidden="true" size={17} />
      </ButtonLink>
      <ul className="pricing-card__features">
        {features.map((feature) => (
          <li key={feature}>
            <Check aria-hidden="true" size={15} /> {feature}
          </li>
        ))}
      </ul>
    </article>
  );
}

export default function PricingPage() {
  const freeRepositoryLimit = configuredLimit(process.env.FREE_REPOSITORY_LIMIT, 1);
  const proRepositoryLimit = configuredLimit(process.env.PRO_REPOSITORY_LIMIT, 20);
  const freeFeatures = [
    repositoryLabel(freeRepositoryLimit),
    "Trial Patchrail update allowance",
    "Current official API research",
    "Isolated repository verification",
    "Verified GitHub Draft PRs",
  ];
  const proFeatures = [
    `Up to ${repositoryLabel(proRepositoryLimit)}`,
    "Monthly Patchrail update allowance",
    "Paid analysis and update runs",
    "Per-run outcomes and verification detail",
    "Everything included in Free",
  ];

  return (
    <>
      <section className="subpage-hero pricing-hero">
        <div className="marketing-container subpage-hero__inner">
          <p className="eyebrow">
            <Gauge aria-hidden="true" size={14} /> Predictable guardrails
          </p>
          <h1>Start small. Pay for the maintenance you actually use.</h1>
          <p>
            Each plan defines its repository capacity and Patchrail update allowance. Run outcomes
            and verification evidence remain visible after every update.
          </p>
        </div>
      </section>

      <section className="pricing-section">
        <div className="marketing-container">
          <div className="pricing-grid">
            <PlanCard
              features={freeFeatures}
              name="Free"
              price="$0"
              summary="For evaluating Patchrail on a real repository."
            />
            <PlanCard
              featured
              features={proFeatures}
              name="Pro"
              price="Usage ready"
              summary="For developers maintaining integrations across active repositories."
            />
          </div>
          <div className="pricing-note">
            <div>
              <GitPullRequestDraft aria-hidden="true" size={20} />
              <p>
                <strong>Every plan keeps review in the loop.</strong>
                Patchrail opens Draft PRs and never auto-merges changes.
              </p>
            </div>
            <div>
              <Gauge aria-hidden="true" size={20} />
              <p>
                <strong>Limits are explicit.</strong>
                Repository and update allowances are shown in your workspace before an update.
              </p>
            </div>
          </div>
          <p className="pricing-disclaimer">
            Plan limits and Pro pricing are deployment-configured and confirmed in the Patchrail
            billing screen before purchase. Update allowances are part of the Patchrail plan and are
            not prepaid credit.
          </p>
        </div>
      </section>

      <section className="closing-cta closing-cta--compact">
        <div className="marketing-container closing-cta__inner">
          <div>
            <p className="eyebrow">Try the full workflow</p>
            <h2>Connect one repository and see what Patchrail finds.</h2>
          </div>
          <ButtonLink href="/login" size="lg">
            <Github aria-hidden="true" size={18} /> Start free
          </ButtonLink>
        </div>
      </section>
    </>
  );
}
