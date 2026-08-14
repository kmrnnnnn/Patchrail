import { ArrowUpRight, Menu, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Brand, BrandMark } from "@/components/brand";
import { ButtonLink } from "@/components/ui";

const navigation = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Pricing" },
];

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="marketing-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="marketing-header">
        <div className="marketing-container marketing-header__inner">
          <Brand />
          <nav aria-label="Main navigation" className="marketing-nav">
            {navigation.map((item) => (
              <Link href={item.href} key={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="marketing-header__actions">
            <Link className="marketing-header__login" href="/login">
              Sign in
            </Link>
            <ButtonLink href="/login" size="sm">
              Connect GitHub
            </ButtonLink>
          </div>
          <details className="marketing-mobile-menu">
            <summary aria-label="Open navigation">
              <Menu aria-hidden="true" className="marketing-mobile-menu__open" size={20} />
              <X aria-hidden="true" className="marketing-mobile-menu__close" size={20} />
            </summary>
            <nav aria-label="Mobile navigation" className="marketing-mobile-menu__panel">
              {navigation.map((item) => (
                <Link href={item.href} key={item.href}>
                  {item.label}
                </Link>
              ))}
              <Link href="/login">Sign in</Link>
              <ButtonLink href="/login">Connect GitHub</ButtonLink>
            </nav>
          </details>
        </div>
      </header>
      <main id="main-content">{children}</main>
      <footer className="marketing-footer">
        <div className="marketing-container marketing-footer__grid">
          <div className="marketing-footer__brand">
            <Brand inverse />
            <p>API integrations that maintain themselves.</p>
          </div>
          <div className="marketing-footer__links">
            <div>
              <p className="marketing-footer__label">Product</p>
              <Link href="/#how-it-works">How it works</Link>
              <Link href="/pricing">Pricing</Link>
              <Link href="/login">Sign in</Link>
            </div>
            <div>
              <p className="marketing-footer__label">Trust</p>
              <Link href="/security">Security</Link>
              <a href="https://github.com" rel="noreferrer" target="_blank">
                GitHub <ArrowUpRight aria-hidden="true" size={13} />
              </a>
            </div>
          </div>
        </div>
        <div className="marketing-container marketing-footer__bottom">
          <span>© {new Date().getFullYear()} Patchrail</span>
          <span className="marketing-footer__human">
            <BrandMark inverse /> Human review stays in the loop.
          </span>
        </div>
      </footer>
    </div>
  );
}
