import "server-only";

import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { getConfigurationStatus } from "@/lib/env";
import { getConfiguredAppOrigin } from "@/security/request";

const configuredOrigin = getConfiguredAppOrigin();
const baseURL = configuredOrigin ?? "http://localhost:3000";
const configuredSecret =
  typeof process.env.AUTH_SECRET === "string" && process.env.AUTH_SECRET.length >= 32
    ? process.env.AUTH_SECRET
    : null;
export const authenticationConfigured = configuredOrigin !== null && getConfigurationStatus().auth;

// Better Auth is instantiated while Next.js builds route bundles. In an
// unconfigured production runtime, use an unpredictable process-local value
// and expose no login provider so a known fallback can never sign sessions.
const fallbackSecret =
  process.env.NODE_ENV === "production"
    ? randomBytes(48).toString("base64url")
    : "patchrail-development-secret-not-valid-for-production";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  baseURL,
  secret: configuredSecret ?? fallbackSecret,
  trustedOrigins: [baseURL],
  account: {
    encryptOAuthTokens: true,
    updateAccountOnSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  socialProviders: authenticationConfigured
    ? {
        github: {
          clientId: process.env.GITHUB_OAUTH_CLIENT_ID!,
          clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
          scope: ["read:user", "user:email"],
        },
      }
    : {},
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});

export type AuthSession = typeof auth.$Infer.Session;
