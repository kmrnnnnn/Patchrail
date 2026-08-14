import type { Metadata } from "next";
import {
  ArrowRight,
  BadgeDollarSign,
  BookOpenCheck,
  Box,
  Check,
  Code2,
  GitPullRequestDraft,
  Github,
  KeyRound,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  TestTube2,
} from "lucide-react";

import { BrandMark } from "@/components/brand";
import { ButtonLink } from "@/components/ui";

import { ProductPreview } from "./_components/product-preview";

export const metadata: Metadata = {
  title: "API changes delivered as tested pull requests",
  description:
    "Connect a GitHub repository. Patchrail researches the APIs it uses, updates outdated integrations, verifies the code, and opens a Draft PR.",
};

const steps = [
  {
    number: "01",
    title: "Connect",
    copy: "Choose repository access through the Patchrail GitHub App.",
    icon: Github,
  },
  {
    number: "02",
    title: "Understand",
    copy: "AI maps the codebase and finds the external APIs it actually uses.",
    icon: ScanSearch,
  },
  {
    number: "03",
    title: "Update",
    copy: "Current official sources guide focused, reviewable code changes.",
    icon: Code2,
  },
  {
    number: "04",
    title: "Verify",
    copy: "Your repository’s own checks run in an isolated environment.",
    icon: TestTube2,
  },
  {
    number: "05",
    title: "Review PR",
    copy: "A verified Draft PR arrives with evidence, changes, and cost.",
    icon: GitPullRequestDraft,
  },
];

const trustItems = [
  {
    icon: GitPullRequestDraft,
    title: "Draft PR only",
    copy: "Patchrail never merges for you. Your team reviews every proposed change.",
  },
  {
    icon: KeyRound,
    title: "Repository-scoped access",
    copy: "Grant the GitHub App access only to repositories you choose.",
  },
  {
    icon: BookOpenCheck,
    title: "Official-source research",
    copy: "Migration decisions prioritize current vendor documentation and changelogs.",
  },
  {
    icon: Box,
    title: "Isolated verification",
    copy: "Customer code is verified away from the application server with bounded resources.",
  },
  {
    icon: BadgeDollarSign,
    title: "Visible AI spend",
    copy: "See the maximum estimate before a run and actual usage when it completes.",
  },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero__grid" aria-hidden="true" />
        <div className="marketing-container hero__inner">
          <div className="hero__copy">
            <p className="eyebrow">
              <Sparkles aria-hidden="true" size={14} /> Repository maintenance, end to end
            </p>
            <h1>API changes delivered as tested pull requests.</h1>
            <p className="hero__lead">
              Patchrail reads your repositories, finds the external APIs your code depends on,
              researches what changed, updates outdated integrations, verifies the code, and opens a
              Draft PR.
            </p>
            <div className="hero__actions">
              <ButtonLink href="/login" size="lg">
                <Github aria-hidden="true" size={18} /> Connect GitHub
              </ButtonLink>
              <ButtonLink href="#how-it-works" size="lg" variant="outline">
                See how it works <ArrowRight aria-hidden="true" size={17} />
              </ButtonLink>
            </div>
            <p className="hero__note">
              <ShieldCheck aria-hidden="true" size={15} /> Draft PRs only. You review and merge.
            </p>
          </div>
          <ProductPreview />
        </div>
      </section>

      <section className="workflow-section" id="how-it-works">
        <div className="marketing-container">
          <div className="section-heading section-heading--split">
            <div>
              <p className="eyebrow">One deliberate workflow</p>
              <h2>From unfamiliar code to a reviewable change.</h2>
            </div>
            <p>
              Patchrail handles the research and repetition. Your repository remains the source of
              truth, and your team makes the final call.
            </p>
          </div>
          <ol className="workflow-steps">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <li key={step.number}>
                  <div className="workflow-step__top">
                    <span className="workflow-step__number">{step.number}</span>
                    <Icon aria-hidden="true" size={18} />
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.copy}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="trust-section">
        <div className="marketing-container trust-section__grid">
          <div className="trust-section__intro">
            <p className="eyebrow eyebrow--dark">Designed for review</p>
            <h2>The guardrails developers look for.</h2>
            <p>
              Repository access, source evidence, verification output, and AI cost stay visible
              throughout the run.
            </p>
            <div className="trust-section__artifact" aria-label="Example pull request outcome">
              <BrandMark inverse />
              <div>
                <span>patchrail/update-external-apis</span>
                <strong>
                  <Check aria-hidden="true" size={14} /> Verification passed
                </strong>
              </div>
              <span>Draft</span>
            </div>
          </div>
          <div className="trust-list">
            {trustItems.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title}>
                  <span className="trust-list__icon">
                    <Icon aria-hidden="true" size={18} />
                  </span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.copy}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="security-callout">
        <div className="marketing-container security-callout__inner">
          <div className="security-callout__mark">
            <ShieldCheck aria-hidden="true" size={26} />
          </div>
          <div>
            <p className="eyebrow">Security by boundary</p>
            <h2>
              Your credentials stay out of the model and your code stays away from the web server.
            </h2>
          </div>
          <ButtonLink href="/security" variant="outline">
            Read security overview <ArrowRight aria-hidden="true" size={16} />
          </ButtonLink>
        </div>
      </section>

      <section className="closing-cta">
        <div className="marketing-container closing-cta__inner">
          <div>
            <p className="eyebrow">Keep the integration. Lose the maintenance drag.</p>
            <h2>Let the next API change arrive as a pull request.</h2>
          </div>
          <div className="closing-cta__actions">
            <ButtonLink href="/login" size="lg">
              <Github aria-hidden="true" size={18} /> Connect GitHub
            </ButtonLink>
            <ButtonLink href="/pricing" size="lg" variant="ghost">
              View pricing <ArrowRight aria-hidden="true" size={17} />
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
