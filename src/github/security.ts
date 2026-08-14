import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SHA_256_HEX_LENGTH = 64;
const MAX_GIT_PATH_BYTES = 4_096;
const MAX_BRANCH_LENGTH = 240;

export function createInstallationState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, stateHash: hashInstallationState(state) };
}

export function hashInstallationState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function verifyGitHubWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  secret: string,
): boolean {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader ?? "");
  if (!match?.[1]) return false;

  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function assertSha256(value: string, fieldName = "digest"): void {
  if (!new RegExp(`^[a-f0-9]{${SHA_256_HEX_LENGTH}}$`, "i").test(value)) {
    throw new Error(`${fieldName} must be a SHA-256 digest`);
  }
}

export function decodeBase64Strict(value: string): Buffer {
  if (value === "") return Buffer.alloc(0);
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("File content is not valid base64");
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("File content is not canonical base64");
  }
  return decoded;
}

export function normalizeGitPath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    Buffer.byteLength(path, "utf8") > MAX_GIT_PATH_BYTES
  ) {
    throw new Error(`Unsafe repository path: ${path}`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error(`Git internals cannot be changed: ${path}`);
  }

  return segments.join("/");
}

export function assertWorkflowPathAllowed(path: string): void {
  const normalized = normalizeGitPath(path).toLowerCase();
  if (normalized === ".github/workflows" || normalized.startsWith(".github/workflows/")) {
    throw new Error(
      "Patchrail cannot change .github/workflows because the GitHub App does not request workflow permission",
    );
  }
}

export function assertPatchrailBranchName(branch: string): void {
  const invalid =
    branch.length === 0 ||
    branch.length > MAX_BRANCH_LENGTH ||
    !branch.startsWith("patchrail/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    /[\x00-\x20~^:?*[\\\x7f]/.test(branch) ||
    branch
      .split("/")
      .some(
        (segment) => segment.length === 0 || segment.startsWith(".") || segment.endsWith(".lock"),
      );

  if (invalid) throw new Error("Invalid Patchrail branch name");
}

export function assertGitObjectSha(sha: string, fieldName = "Git object SHA"): void {
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`${fieldName} is invalid`);
}
