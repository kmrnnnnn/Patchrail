import type { Metadata } from "next";
import {
  ArrowRight,
  BookOpenCheck,
  Box,
  Check,
  FileKey2,
  GitPullRequestDraft,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { ButtonLink } from "@/components/ui";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Patchrail bounds repository access, AI data disclosure, isolated verification, and GitHub delivery.",
};

const controls = [
  {
    icon: KeyRound,
    title: "Scoped GitHub access",
    copy: "GitHub login identifies you. A separate GitHub App grants repository access only to installations and repositories you select.",
  },
  {
    icon: Sparkles,
    title: "Bounded AI context",
    copy: "The model receives relevant repository data and safe run metadata—not GitHub tokens, app keys, billing secrets, or database credentials.",
  },
  {
    icon: Box,
    title: "Isolated verification",
    copy: "Repository commands run in a disposable environment with resource and time bounds, away from the Patchrail web process.",
  },
  {
    icon: GitPullRequestDraft,
    title: "Review before merge",
    copy: "A verified result is delivered as a GitHub Draft PR. Patchrail does not automatically merge into your repository.",
  },
];

const githubPermissions = [
  ["Metadata", "Read", "Identify repositories and their default branches."],
  [
    "Contents",
    "Read & write",
    "Read the pinned source commit and create a verified update branch.",
  ],
  ["Pull requests", "Read & write", "Open and update the resulting Draft PR."],
];

export default function SecurityPage() {
  return (
    <>
      <section className="subpage-hero security-hero">
        <div className="marketing-container subpage-hero__inner">
          <p className="eyebrow">
            <ShieldCheck aria-hidden="true" size={14} /> Security overview
          </p>
          <h1>Clear boundaries around code, credentials, and delivery.</h1>
          <p>
            Patchrail needs meaningful repository context to do useful work. Its architecture limits
            where that context goes, keeps credentials out of the model, and leaves merging to you.
          </p>
        </div>
      </section>

      <section className="security-controls">
        <div className="marketing-container">
          <div className="security-controls__grid">
            {controls.map((control) => {
              const Icon = control.icon;
              return (
                <article key={control.title}>
                  <span className="security-controls__icon">
                    <Icon aria-hidden="true" size={20} />
                  </span>
                  <h2>{control.title}</h2>
                  <p>{control.copy}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="data-path-section">
        <div className="marketing-container data-path-section__grid">
          <div className="section-heading">
            <p className="eyebrow">What moves where</p>
            <h2>A small, inspectable data path.</h2>
            <p>
              Before the first analysis, Patchrail explains exactly what the run does and shows its
              maximum estimated AI spend.
            </p>
          </div>
          <ol className="data-path">
            <li>
              <span className="data-path__icon">
                <FileKey2 aria-hidden="true" size={18} />
              </span>
              <div>
                <strong>Repository fetched</strong>
                <p>
                  A short-lived server-side GitHub App credential fetches the selected repository
                  and pins an exact commit SHA.
                </p>
              </div>
            </li>
            <li>
              <span className="data-path__icon">
                <Sparkles aria-hidden="true" size={18} />
              </span>
              <div>
                <strong>Relevant code analyzed</strong>
                <p>
                  Repository maps and relevant source content are sent to the configured AI
                  provider. Provider handling is governed by your deployment’s provider terms and
                  settings.
                </p>
              </div>
            </li>
            <li>
              <span className="data-path__icon">
                <BookOpenCheck aria-hidden="true" size={18} />
              </span>
              <div>
                <strong>Public sources researched</strong>
                <p>
                  Current vendor documentation, API references, changelogs, and migration guides are
                  prioritized for update decisions.
                </p>
              </div>
            </li>
            <li>
              <span className="data-path__icon">
                <Box aria-hidden="true" size={18} />
              </span>
              <div>
                <strong>Changes verified in isolation</strong>
                <p>
                  The repository’s confidently detected checks run inside a disposable, bounded
                  execution environment.
                </p>
              </div>
            </li>
            <li>
              <span className="data-path__icon">
                <GitPullRequestDraft aria-hidden="true" size={18} />
              </span>
              <div>
                <strong>Draft PR delivered</strong>
                <p>
                  Only after verification succeeds is a branch pushed and a Draft PR opened for
                  human review.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section className="permission-section">
        <div className="marketing-container permission-section__grid">
          <div>
            <p className="eyebrow eyebrow--dark">GitHub App permissions</p>
            <h2>Only what the workflow needs.</h2>
            <p>
              Authentication and repository access stay separate. Signing out does not remove a
              GitHub App installation or delete run history.
            </p>
          </div>
          <div
            className="permission-table"
            role="table"
            aria-label="GitHub App repository permissions"
          >
            <div className="permission-table__head" role="row">
              <span role="columnheader">Permission</span>
              <span role="columnheader">Access</span>
              <span role="columnheader">Purpose</span>
            </div>
            {githubPermissions.map(([permission, access, purpose]) => (
              <div className="permission-table__row" key={permission} role="row">
                <strong role="cell">{permission}</strong>
                <span role="cell">
                  <Check aria-hidden="true" size={14} /> {access}
                </span>
                <p role="cell">{purpose}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="security-summary">
        <div className="marketing-container security-summary__inner">
          <LockKeyhole aria-hidden="true" size={26} />
          <div>
            <h2>Sensitive values stay server-side.</h2>
            <p>
              GitHub installation tokens are short-lived and are neither exposed to the browser nor
              persisted as run artifacts. Logs record safe identifiers and outcomes, not source
              contents or secrets.
            </p>
          </div>
          <ButtonLink href="/login" variant="outline">
            Connect securely <ArrowRight aria-hidden="true" size={16} />
          </ButtonLink>
        </div>
      </section>
    </>
  );
}
