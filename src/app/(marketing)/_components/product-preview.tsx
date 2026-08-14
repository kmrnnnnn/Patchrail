import {
  Check,
  ChevronRight,
  CircleDot,
  GitPullRequestDraft,
  LockKeyhole,
  Search,
} from "lucide-react";

import { BrandMark } from "@/components/brand";
import { StatusBadge } from "@/components/ui";

const apiRows = [
  { name: "Payments API", detail: "SDK usage", label: "Update required", tone: "warning" as const },
  {
    name: "Messaging API",
    detail: "REST endpoints",
    label: "Up to date",
    tone: "positive" as const,
  },
  {
    name: "Storage API",
    detail: "Legacy method",
    label: "Deprecated usage",
    tone: "critical" as const,
  },
];

const checks = [
  "Repository analyzed",
  "Official docs researched",
  "Code updated",
  "Typecheck passed",
  "Tests passed",
];

export function ProductPreview() {
  return (
    <figure aria-label="Illustrative Patchrail analysis run" className="product-preview">
      <figcaption className="product-preview__caption">
        <span>Illustrative product view</span>
        <span>Example data</span>
      </figcaption>
      <div className="product-preview__window">
        <div className="product-preview__topbar">
          <div className="product-preview__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="product-preview__secure">
            <LockKeyhole aria-hidden="true" size={12} /> Isolated run
          </div>
        </div>
        <div className="product-preview__body">
          <aside className="product-preview__sidebar" aria-hidden="true">
            <BrandMark />
            <span className="product-preview__side-active" />
            <span />
            <span />
            <span />
          </aside>
          <div className="product-preview__workspace">
            <div className="product-preview__repo-row">
              <div>
                <span className="product-preview__overline">Repository</span>
                <strong>example/backend</strong>
              </div>
              <span className="product-preview__commit">main · e83c…19a</span>
            </div>
            <div className="product-preview__columns">
              <section className="product-preview__apis">
                <div className="product-preview__section-title">
                  <span>
                    <Search aria-hidden="true" size={14} /> External APIs found
                  </span>
                  <strong>3</strong>
                </div>
                <div className="product-preview__api-list">
                  {apiRows.map((api) => (
                    <div className="product-preview__api" key={api.name}>
                      <div>
                        <strong>{api.name}</strong>
                        <span>{api.detail}</span>
                      </div>
                      <StatusBadge tone={api.tone}>{api.label}</StatusBadge>
                    </div>
                  ))}
                </div>
                <div className="product-preview__source">
                  <CircleDot aria-hidden="true" size={14} />
                  <span>Compared with current official sources</span>
                  <ChevronRight aria-hidden="true" size={14} />
                </div>
              </section>
              <section className="product-preview__run">
                <div className="product-preview__section-title">
                  <span>Updating code</span>
                  <StatusBadge dot tone="info">
                    In progress
                  </StatusBadge>
                </div>
                <ul className="product-preview__checks">
                  {checks.map((check, index) => (
                    <li
                      className={
                        index === checks.length - 1 ? "product-preview__check--pending" : undefined
                      }
                      key={check}
                    >
                      <span>
                        {index === checks.length - 1 ? (
                          <span aria-hidden="true" className="product-preview__pending-dot" />
                        ) : (
                          <Check aria-hidden="true" size={13} />
                        )}
                      </span>
                      {check}
                    </li>
                  ))}
                </ul>
                <div className="product-preview__pr">
                  <span className="product-preview__pr-icon">
                    <GitPullRequestDraft aria-hidden="true" size={18} />
                  </span>
                  <div>
                    <span>Next</span>
                    <strong>Draft PR ready for review</strong>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
