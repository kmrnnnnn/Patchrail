import type { Metadata } from "next";
import { ArrowLeft, Check, GitBranch, Github, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { Brand } from "@/components/brand";
import { getConfigurationStatus } from "@/lib/env";
import { getConfiguredAppOrigin } from "@/security/request";
import { getSession } from "@/server/session";

import { GitHubLoginButton } from "./login-button";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Patchrail with GitHub.",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  await connection();
  if (await getSession()) redirect("/app");

  const authenticationAvailable =
    getConfiguredAppOrigin() !== null && getConfigurationStatus().auth;

  return (
    <main className="login-page">
      <div className="login-page__art" aria-hidden="true">
        <div className="login-page__art-grid" />
        <div className="login-page__art-content">
          <span className="login-page__mini-mark">
            <GitBranch size={22} />
          </span>
          <p>One repository in.</p>
          <div className="login-page__trace">
            <span>
              <Check size={13} /> APIs understood
            </span>
            <span>
              <Check size={13} /> Official sources checked
            </span>
            <span>
              <Check size={13} /> Code verified
            </span>
          </div>
          <strong>One reviewable pull request out.</strong>
        </div>
      </div>
      <div className="login-page__panel">
        <div className="login-page__topbar">
          <Brand />
          <Link href="/">
            <ArrowLeft aria-hidden="true" size={15} /> Back to home
          </Link>
        </div>
        <div className="login-card">
          <div className="login-card__icon">
            <Github aria-hidden="true" size={24} />
          </div>
          <h1>Welcome to Patchrail</h1>
          <p>Sign in with your GitHub identity to open your workspaces and run history.</p>
          <GitHubLoginButton disabled={!authenticationAvailable} />
          <div className="login-card__divider">
            <span>Repository access is separate</span>
          </div>
          <div className="login-card__explanation">
            <LockKeyhole aria-hidden="true" size={17} />
            <p>
              <strong>This sign-in does not grant repository access.</strong>
              After signing in, you choose which repositories to connect through the Patchrail
              GitHub App.
            </p>
          </div>
          <p className="login-card__terms">
            By continuing, you agree to use Patchrail only with repositories you are authorized to
            access.
          </p>
        </div>
      </div>
    </main>
  );
}
