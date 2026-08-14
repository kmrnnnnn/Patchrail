import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import * as tar from "tar";
import type { ReadEntry } from "tar";
import { inspectTestIntegrity } from "@/security/integrity";
import { boundedLog } from "@/security/redaction";
import {
  MAX_VERIFICATION_COMMANDS,
  MAX_VERIFICATION_FILE_BYTES,
  MAX_VERIFICATION_FILES,
  MAX_VERIFICATION_PAYLOAD_BYTES,
  verificationTimeoutSeconds,
} from "@/runner/protocol";
import type { ChangedFilePayload, VerificationResult } from "@/runs/types";
import type { RepositoryChange } from "@/ai/repository";
import {
  requirePinnedCorepackPackageManager,
  type PinnedCorepackPackageManager,
} from "@/runner/package-manager";

const DEFAULT_MAX_ARCHIVE_ENTRIES = 50_000;
const DEFAULT_MAX_EXPANDED_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_CAPTURED_STREAM_BYTES = 64_000;
const DOCKER_CLEANUP_TIMEOUT_MS = 15_000;
const CONTAINER_CACHE_ROOT = "/patchrail-cache";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^pip\.conf$/i,
  /^settings\.xml$/i,
  /^nuget\.config$/i,
  /^auth\.json$/i,
  /^\.pnpmfile\.cjs$/i,
  /^\.pnpmfile\.mjs$/i,
  /^pnpmfile\.cjs$/i,
  /^pnpmfile\.mjs$/i,
  /^\.corepack\.env$/i,
  /^\.yarnrc(?:\.yml)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /credentials?\.json$/i,
  /service[-_]?account.*\.json$/i,
];
const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.aws\/(?:credentials|config)$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)\.config\/containers\/auth\.json$/i,
  /(?:^|\/)\.config\/gcloud\/(?:application_default_credentials\.json|credentials\.db|access_tokens\.db)$/i,
  /(?:^|\/)\.azure\/(?:accessTokens\.json|azureProfile\.json|msal_token_cache\.json)$/i,
  /(?:^|\/)\.kube\/config$/i,
  /(?:^|\/)\.cargo\/credentials(?:\.toml)?$/i,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/i,
  /(?:^|\/)\.yarn\/plugins(?:\/|$)/i,
  /(?:^|\/)\.gem\/credentials$/i,
  /(?:^|\/)\.bundle\/config$/i,
];
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type ArchiveExtractionLimits = {
  maximumEntries: number;
  maximumExpandedBytes: number;
  maximumEntryBytes: number;
};

function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    Buffer.byteLength(segment, "utf8") <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(segment) &&
    !/[<>:"|?*]/.test(segment) &&
    !/[ .]$/.test(segment) &&
    !WINDOWS_RESERVED_NAME.test(segment)
  );
}

export function normalizeVerificationPath(input: string): string {
  if (
    !input ||
    input.length > 4096 ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input)
  ) {
    throw new Error("Invalid changed file path");
  }
  const parts = input.split("/");
  if (parts.some((part) => !isSafePathSegment(part))) {
    throw new Error("Invalid changed file path");
  }
  return parts.join("/");
}

function assertPayloadPathPolicy(relative: string): void {
  const segments = relative.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()))) {
    throw new Error(`Excluded repository path cannot be changed: ${relative}`);
  }
  const name = segments.at(-1) ?? "";
  const isExampleEnvironment = name === ".env.example" || name.endsWith(".env.example");
  if (
    (!isExampleEnvironment && SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name))) ||
    SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(relative))
  ) {
    throw new Error(`Sensitive credential path cannot be changed: ${relative}`);
  }
  if (relative.toLowerCase().startsWith(".github/workflows/")) {
    throw new Error("GitHub workflow files cannot be changed by verification payloads");
  }
}

function isSensitiveRepositoryPath(relative: string): boolean {
  const name = path.posix.basename(relative);
  const isExampleEnvironment = name === ".env.example" || name.endsWith(".env.example");
  return (
    (!isExampleEnvironment && SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name))) ||
    SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(relative))
  );
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeArchiveMemberPath(input: string): { wrapper: string; relative: string | null } {
  if (
    !input ||
    input.length > 8192 ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input)
  ) {
    throw new Error("Repository archive contains an unsafe path");
  }
  const withoutTrailingSlash = input.endsWith("/") ? input.slice(0, -1) : input;
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => !isSafePathSegment(part))) {
    throw new Error("Repository archive contains an unsafe path");
  }
  const [wrapper, ...remaining] = parts;
  if (!wrapper) throw new Error("Repository archive is missing its root directory");
  return { wrapper, relative: remaining.length > 0 ? remaining.join("/") : null };
}

/**
 * Extracts a GitHub-generated archive into a new, empty directory. Links and
 * special files are rejected before extraction, and expanded size/count limits
 * protect the runner from compressed archive bombs.
 */
export async function extractGitHubArchive(
  archivePath: string,
  target: string,
  limits: ArchiveExtractionLimits = {
    maximumEntries: DEFAULT_MAX_ARCHIVE_ENTRIES,
    maximumExpandedBytes: DEFAULT_MAX_EXPANDED_ARCHIVE_BYTES,
    maximumEntryBytes: DEFAULT_MAX_ARCHIVE_ENTRY_BYTES,
  },
): Promise<void> {
  const resolvedTarget = path.resolve(target);
  await fs.mkdir(resolvedTarget, { recursive: true });
  if ((await fs.readdir(resolvedTarget)).length > 0) {
    throw new Error("Repository archive target must be empty");
  }

  const validatedEntryPaths = await validateArchiveEntries(archivePath, limits);
  await tar.x({
    file: archivePath,
    cwd: resolvedTarget,
    strip: 1,
    preservePaths: false,
    strict: true,
    noMtime: true,
    preserveOwner: false,
    maxDecompressionRatio: 200,
    filter: (entryPath) => validatedEntryPaths.has(entryPath),
  });

  await assertExtractedTreeIsSafe(resolvedTarget, limits);
}

async function validateArchiveEntries(
  archivePath: string,
  limits: ArchiveExtractionLimits,
): Promise<Set<string>> {
  let entryCount = 0;
  let expandedBytes = 0;
  let archiveWrapper: string | null = null;
  const paths = new Set<string>();
  const entryPaths = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(archivePath);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      if (error) reject(error);
      else resolve();
    };
    const parser = new tar.Parser({
      file: archivePath,
      strict: true,
      maxDecompressionRatio: 200,
      onReadEntry: (archiveEntry: ReadEntry) => {
        try {
          entryCount += 1;
          if (entryCount > limits.maximumEntries) {
            throw new Error("Repository archive contains too many entries");
          }
          const { wrapper, relative } = safeArchiveMemberPath(archiveEntry.path);
          archiveWrapper ??= wrapper;
          if (wrapper !== archiveWrapper) {
            throw new Error("Repository archive contains multiple root directories");
          }

          const isDirectory = archiveEntry.type === "Directory";
          const isFile =
            archiveEntry.type === "File" ||
            archiveEntry.type === "OldFile" ||
            archiveEntry.type === "ContiguousFile";
          if (!isDirectory && !isFile) {
            throw new Error("Repository archive links and special files are not allowed");
          }
          if (relative === null && !isDirectory) {
            throw new Error("Repository archive root must be a directory");
          }
          if (relative !== null) {
            if (isSensitiveRepositoryPath(relative)) {
              throw new Error(`Repository archive contains a credential-bearing path: ${relative}`);
            }
            const collisionKey = relative.normalize("NFC").toLocaleLowerCase("en-US");
            if (paths.has(collisionKey)) {
              throw new Error(`Repository archive contains a colliding path: ${relative}`);
            }
            paths.add(collisionKey);
          }

          const size = Number(archiveEntry.size);
          if (!Number.isSafeInteger(size) || size < 0 || size > limits.maximumEntryBytes) {
            throw new Error(`Repository archive entry is too large: ${relative ?? wrapper}`);
          }
          expandedBytes += size;
          if (expandedBytes > limits.maximumExpandedBytes) {
            throw new Error("Repository archive expands beyond the safe size limit");
          }
          entryPaths.add(archiveEntry.path);
          archiveEntry.resume();
        } catch (error) {
          parser.abort(error instanceof Error ? error : new Error("Invalid repository archive"));
        }
      },
    });
    source.once("error", (error) => finish(error));
    parser.once("error", (error: Error) => finish(error));
    parser.once("end", () => finish());
    source.pipe(parser);
  });

  if (!archiveWrapper || entryCount === 0) throw new Error("Repository archive is empty");
  return entryPaths;
}

async function assertExtractedTreeIsSafe(
  root: string,
  limits: ArchiveExtractionLimits,
): Promise<void> {
  let entries = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > limits.maximumEntries)
        throw new Error("Extracted repository has too many entries");
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("Extracted repository contains a link or special file");
      }
      if (stat.isDirectory()) await visit(absolute);
      else {
        bytes += stat.size;
        if (stat.size > limits.maximumEntryBytes || bytes > limits.maximumExpandedBytes) {
          throw new Error("Extracted repository exceeds the safe size limit");
        }
      }
    }
  };
  await visit(root);
}

async function assertNoSymlinkInPath(root: string, relative: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Verification repository root is invalid");
  }
  let current = root;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be changed: ${relative}`);
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error(`Changed file parent is not a directory: ${relative}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function makeRepositoryTreeOwnerWritable(root: string): Promise<void> {
  const visit = async (entryPath: string): Promise<void> => {
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error("Repository contains a link or special file");
    }
    await fs.chmod(entryPath, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(entryPath)) await visit(path.join(entryPath, entry));
  };
  await visit(root);
}

function decodePayloadContent(encoded: string, relative: string): Buffer {
  if (encoded.length > Math.ceil(MAX_VERIFICATION_FILE_BYTES / 3) * 4 + 4) {
    throw new Error(`Patch content is too large: ${relative}`);
  }
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error(`Patch content is not canonical base64: ${relative}`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength > MAX_VERIFICATION_FILE_BYTES || decoded.toString("base64") !== encoded) {
    throw new Error(`Patch content is invalid or too large: ${relative}`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new Error(`Patch content must be valid UTF-8 text: ${relative}`);
  }
  if (decoded.includes(0)) throw new Error(`Patch content cannot contain NUL bytes: ${relative}`);
  return decoded;
}

export async function applyVerificationPayload(
  root: string,
  payload: ChangedFilePayload[],
): Promise<RepositoryChange[]> {
  if (payload.length === 0 || payload.length > MAX_VERIFICATION_FILES) {
    throw new Error("Verification payload file count is invalid");
  }
  const resolvedRoot = path.resolve(root);
  const changes: RepositoryChange[] = [];
  const seenPaths = new Set<string>();
  let totalPayloadBytes = 0;

  for (const file of payload) {
    const relative = normalizeVerificationPath(file.path);
    assertPayloadPathPolicy(relative);
    const collisionKey = relative.normalize("NFC").toLocaleLowerCase("en-US");
    if (seenPaths.has(collisionKey)) throw new Error(`Duplicate changed file path: ${relative}`);
    seenPaths.add(collisionKey);

    const absolute = path.resolve(resolvedRoot, ...relative.split("/"));
    const relativeToRoot = path.relative(resolvedRoot, absolute);
    if (
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot) ||
      absolute === resolvedRoot
    ) {
      throw new Error("Path escaped repository");
    }
    await assertNoSymlinkInPath(resolvedRoot, relative);

    let before: Buffer | null = null;
    try {
      const existing = await fs.lstat(absolute);
      if (!existing.isFile() || existing.size > MAX_VERIFICATION_FILE_BYTES) {
        throw new Error(`Changed file target is not a bounded regular file: ${relative}`);
      }
      before = await fs.readFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (file.beforeSha256 !== (before ? sha256(before) : null)) {
      throw new Error(`Source digest mismatch for ${relative}`);
    }
    if (file.operation === "CREATE" && before !== null) {
      throw new Error(`Create target already exists: ${relative}`);
    }
    if (file.operation !== "CREATE" && before === null) {
      throw new Error(`Changed file target is missing: ${relative}`);
    }

    let after: Buffer | null = null;
    if (file.operation === "DELETE") {
      if (file.contentBase64 !== null || file.afterSha256 !== null) {
        throw new Error(`Delete payload must not contain replacement content: ${relative}`);
      }
      await fs.unlink(absolute);
    } else {
      if (file.contentBase64 === null || file.afterSha256 === null) {
        throw new Error(`Content missing: ${relative}`);
      }
      after = decodePayloadContent(file.contentBase64, relative);
      totalPayloadBytes += after.byteLength;
      if (totalPayloadBytes > MAX_VERIFICATION_PAYLOAD_BYTES) {
        throw new Error("Verification payload exceeds the total size limit");
      }
      if (sha256(after) !== file.afterSha256)
        throw new Error(`Patch digest mismatch for ${relative}`);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, after, { flag: file.operation === "CREATE" ? "wx" : "w" });
    }
    changes.push({ path: relative, operation: file.operation, before, after });
  }
  return changes;
}

function dockerImage(ecosystem: string): string {
  // Multi-architecture manifest digests are pinned for reproducible verifier images.
  switch (ecosystem) {
    case "node":
      return "node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a";
    case "python":
      return "python:3.13-bookworm@sha256:62eafe52c91cad83c2c74e630bfde917da8c253673e695665d454def84fc9a13";
    case "rust":
      return "rust:1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97";
    case "go":
      return "golang:1.25-bookworm@sha256:6359592445455f2dbe2412bed411336035bc019a50017720d77454ffdd6d0f82";
    default:
      throw new Error(`Unsupported verification ecosystem: ${ecosystem}`);
  }
}

function runtimeCommand(
  ecosystem: string,
  command: string,
  packageManager: PinnedCorepackPackageManager | null,
): string {
  if (ecosystem === "python") {
    return `export PATH="/workspace/.patchrail-venv/bin:$PATH"; ${command}`;
  }
  if (ecosystem === "rust") return `export CARGO_NET_OFFLINE=true; ${command}`;
  if (ecosystem !== "node") return command;
  if (command.startsWith("pnpm ") || command.startsWith("yarn ")) {
    if (!packageManager || !command.startsWith(`${packageManager.name} `)) {
      throw new Error("Verification package manager does not match its pinned descriptor");
    }
    return `export PATH="${CONTAINER_CACHE_ROOT}/bin:$PATH"; ${command}`;
  }
  return command;
}

export function hardenDependencyInstallCommand(ecosystem: string, command: string): string {
  if (ecosystem === "node") {
    switch (command) {
      case "npm ci":
      case "npm install":
        return `${command} --ignore-scripts --no-audit --no-fund`;
      case "pnpm install --frozen-lockfile":
        return "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile";
      case "yarn install --immutable":
        return "yarn install --immutable --mode=skip-build";
      case "yarn install --frozen-lockfile":
        return "yarn install --frozen-lockfile --ignore-scripts --non-interactive";
      default:
        throw new Error("Unsupported dependency installation command");
    }
  }
  if (ecosystem === "python" && command === "pip install -r requirements.txt") {
    // Binary-only installs avoid executing arbitrary package build backends while egress is enabled.
    return "python -m venv /workspace/.patchrail-venv && /workspace/.patchrail-venv/bin/pip install --only-binary=:all: --disable-pip-version-check --no-input -r requirements.txt";
  }
  if (ecosystem === "rust" && (command === "cargo fetch" || command === "cargo fetch --locked")) {
    return command;
  }
  if (ecosystem === "go" && command === "go mod download all") return command;
  throw new Error("Unsupported dependency installation command");
}

function managerUsedByCommand(command: string | null): "pnpm" | "yarn" | null {
  if (command?.startsWith("pnpm ")) return "pnpm";
  if (command?.startsWith("yarn ")) return "yarn";
  return null;
}

async function resolveJobPackageManager(input: {
  root: string;
  ecosystem: string;
  installCommand: string | null;
  commands: string[];
}): Promise<PinnedCorepackPackageManager | null> {
  if (input.ecosystem !== "node") return null;
  const managers = new Set(
    [input.installCommand, ...input.commands]
      .map(managerUsedByCommand)
      .filter((manager): manager is "pnpm" | "yarn" => manager !== null),
  );
  if (managers.size === 0) return null;
  if (managers.size !== 1 || !input.installCommand) {
    throw new Error("Verification uses an unsupported package-manager command set");
  }
  const expected = [...managers][0]!;
  let manifest: unknown;
  try {
    const bytes = await fs.readFile(path.join(input.root, "package.json"));
    if (bytes.byteLength > MAX_VERIFICATION_FILE_BYTES) throw new Error("manifest is too large");
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `Verification could not read the pinned package manager: ${error instanceof Error ? error.message : "invalid package.json"}`,
    );
  }
  const packageManager = requirePinnedCorepackPackageManager(
    (manifest as { packageManager?: unknown }).packageManager,
    expected,
  );
  const expectedInstall =
    packageManager.name === "pnpm"
      ? "pnpm install --frozen-lockfile"
      : packageManager.major === 1
        ? "yarn install --frozen-lockfile"
        : "yarn install --immutable";
  if (input.installCommand !== expectedInstall) {
    throw new Error(
      "Verification install command does not match the pinned package-manager version",
    );
  }
  return packageManager;
}

function assertSupportedDependencyPreparation(
  ecosystem: string,
  installCommand: string | null,
): void {
  if (
    ecosystem === "rust" &&
    !["cargo fetch", "cargo fetch --locked"].includes(installCommand ?? "")
  ) {
    throw new Error("Rust verification requires a bounded cargo fetch preparation step");
  }
  if (ecosystem === "go" && installCommand !== "go mod download all") {
    throw new Error("Go verification requires a bounded module download preparation step");
  }
  if (ecosystem === "python" && installCommand !== "pip install -r requirements.txt") {
    throw new Error("Python verification requires a supported requirements.txt preparation step");
  }
}

function installRuntimeCommand(
  ecosystem: string,
  command: string,
  packageManager: PinnedCorepackPackageManager | null,
): string {
  const hardened = hardenDependencyInstallCommand(ecosystem, command);
  if (!packageManager) return hardened;
  return [
    `mkdir -p "${CONTAINER_CACHE_ROOT}/bin" "${CONTAINER_CACHE_ROOT}/corepack"`,
    `export PATH="${CONTAINER_CACHE_ROOT}/bin:$PATH"`,
    `corepack ${packageManager.descriptor} --version >/dev/null`,
    `corepack enable --install-directory "${CONTAINER_CACHE_ROOT}/bin" ${packageManager.name}`,
    hardened,
  ].join(" && ");
}

function boundedDecimal(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Verification resource limit must be from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function verificationResourceLimits(): { cpuLimit: number; memoryMb: number } {
  const memoryMb = boundedDecimal(process.env.VERIFICATION_MEMORY_MB, 4096, 256, 16_384);
  if (!Number.isSafeInteger(memoryMb)) {
    throw new Error("Verification memory limit must be a whole number of MiB");
  }
  return {
    cpuLimit: boundedDecimal(process.env.VERIFICATION_CPU_LIMIT, 2, 0.25, 8),
    memoryMb,
  };
}

function dockerUser(): string {
  if (process.platform !== "win32" && process.getuid && process.getgid) {
    const uid = process.getuid();
    const gid = process.getgid();
    if (uid !== 0) return `${uid}:${gid}`;
  }
  return "1000:1000";
}

async function chownTreeForContainer(root: string): Promise<void> {
  if (process.platform === "win32" || !process.getuid || process.getuid() !== 0) return;
  const visit = async (entryPath: string): Promise<void> => {
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) throw new Error("Repository contains a symbolic link");
    await fs.chown(entryPath, 1000, 1000);
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(entryPath)) await visit(path.join(entryPath, entry));
  };
  await visit(root);
}

async function forceRemoveContainer(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const cleanup = spawn("docker", ["rm", "--force", "--volumes", name], {
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      cleanup.kill("SIGKILL");
      finish();
    }, DOCKER_CLEANUP_TIMEOUT_MS);
    cleanup.once("error", finish);
    cleanup.once("close", finish);
  });
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Verification was cancelled";
}

function containerTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000) - 5);
}

export function buildVerificationDockerArguments(input: {
  root: string;
  cacheRoot: string;
  ecosystem: string;
  command: string;
  network: "bridge" | "none";
  containerName: string;
  install: boolean;
  timeoutMs: number;
  packageManager?: PinnedCorepackPackageManager | null;
}): string[] {
  const resolvedRoot = path.resolve(input.root);
  const resolvedCacheRoot = path.resolve(input.cacheRoot);
  if (/[\u0000\r\n,]/.test(resolvedRoot) || /[\u0000\r\n,]/.test(resolvedCacheRoot)) {
    throw new Error("Verification workspace path cannot be represented safely as a Docker mount");
  }
  const { cpuLimit, memoryMb } = verificationResourceLimits();
  const inContainerTimeoutSeconds = containerTimeoutSeconds(input.timeoutMs);
  return [
    "run",
    "--name",
    input.containerName,
    "--rm",
    "--init",
    "--read-only",
    "--hostname",
    "patchrail-verifier",
    "--log-driver",
    "none",
    "--stop-timeout",
    "1",
    "--user",
    dockerUser(),
    "--cpus",
    String(cpuLimit),
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--pids-limit",
    "256",
    "--ulimit",
    "nofile=1024:1024",
    "--ulimit",
    "core=0:0",
    "--ulimit",
    "fsize=536870912:536870912",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    "seccomp=builtin",
    "--ipc",
    "none",
    "--network",
    input.network,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=536870912,mode=1777",
    "--mount",
    `type=bind,src=${resolvedRoot},dst=/workspace`,
    "--mount",
    `type=bind,src=${resolvedCacheRoot},dst=${CONTAINER_CACHE_ROOT}${input.install ? "" : ",readonly"}`,
    "--workdir",
    "/workspace",
    "--env",
    "CI=1",
    "--env",
    "HOME=/tmp/patchrail-home",
    "--env",
    `COREPACK_HOME=${CONTAINER_CACHE_ROOT}/corepack`,
    "--env",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "--env",
    "COREPACK_DEFAULT_TO_LATEST=0",
    "--env",
    "COREPACK_ENABLE_AUTO_PIN=0",
    "--env",
    "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0",
    "--env",
    "COREPACK_ENABLE_STRICT=1",
    "--env",
    "COREPACK_ENABLE_PROJECT_SPEC=1",
    "--env",
    "COREPACK_ENV_FILE=0",
    "--env",
    `COREPACK_ENABLE_NETWORK=${input.install ? "1" : "0"}`,
    "--env",
    "GIT_TERMINAL_PROMPT=0",
    "--env",
    `npm_config_cache=${CONTAINER_CACHE_ROOT}/npm-cache`,
    "--env",
    "npm_config_ignore_scripts=true",
    "--env",
    "npm_config_audit=false",
    "--env",
    "npm_config_fund=false",
    "--env",
    "npm_config_update_notifier=false",
    "--env",
    "YARN_ENABLE_SCRIPTS=false",
    "--env",
    "YARN_IGNORE_SCRIPTS=1",
    "--env",
    "YARN_ENABLE_TELEMETRY=0",
    "--env",
    `YARN_CACHE_FOLDER=${CONTAINER_CACHE_ROOT}/yarn`,
    "--env",
    `YARN_GLOBAL_FOLDER=${CONTAINER_CACHE_ROOT}/yarn-global`,
    "--env",
    "YARN_ENABLE_GLOBAL_CACHE=false",
    "--env",
    `YARN_ENABLE_NETWORK=${input.install ? "true" : "false"}`,
    "--env",
    `YARN_ENABLE_IMMUTABLE_CACHE=${input.install ? "false" : "true"}`,
    "--env",
    `PNPM_CONFIG_STORE_DIR=${CONTAINER_CACHE_ROOT}/pnpm-store`,
    "--env",
    "pnpm_config_verify_deps_before_run=false",
    "--env",
    `PIP_CACHE_DIR=${CONTAINER_CACHE_ROOT}/pip-cache`,
    "--env",
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    "--env",
    "PIP_NO_INPUT=1",
    "--env",
    `CARGO_HOME=${CONTAINER_CACHE_ROOT}/cargo`,
    "--env",
    "GOCACHE=/tmp/go-cache",
    "--env",
    `GOMODCACHE=${CONTAINER_CACHE_ROOT}/go-mod-cache`,
    ...(input.install ? [] : ["--env", "GOPROXY=off"]),
    dockerImage(input.ecosystem),
    "timeout",
    "--signal=TERM",
    "--kill-after=5s",
    `${inContainerTimeoutSeconds}s`,
    "bash",
    "-lc",
    input.install
      ? installRuntimeCommand(input.ecosystem, input.command, input.packageManager ?? null)
      : runtimeCommand(input.ecosystem, input.command, input.packageManager ?? null),
  ];
}

async function runDockerCommand(input: {
  root: string;
  ecosystem: string;
  command: string;
  network: "bridge" | "none";
  timeoutMs: number;
  signal?: AbortSignal;
  install: boolean;
  cacheRoot: string;
  packageManager: PinnedCorepackPackageManager | null;
}): Promise<VerificationResult["commands"][number]> {
  const startedAt = Date.now();
  const containerName = `patchrail-${randomUUID()}`;
  const args = buildVerificationDockerArguments({ ...input, containerName });

  return new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let cleanup: Promise<void> | null = null;

    const capture = (chunks: Buffer[], currentBytes: number, chunk: Buffer) => {
      if (currentBytes < MAX_CAPTURED_STREAM_BYTES) {
        chunks.push(chunk.subarray(0, MAX_CAPTURED_STREAM_BYTES - currentBytes));
      }
      return currentBytes + chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = capture(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = capture(stderr, stderrBytes, chunk);
    });

    const terminate = () => {
      cleanup ??= forceRemoveContainer(containerName);
      child.kill("SIGKILL");
      return cleanup;
    };
    const timeoutMarker = setTimeout(
      () => {
        timedOut = true;
      },
      containerTimeoutSeconds(input.timeoutMs) * 1000,
    );
    const timeout = setTimeout(
      () => {
        timedOut = true;
        void terminate();
      },
      Math.max(1, input.timeoutMs),
    );
    const onAbort = () => {
      aborted = true;
      void terminate();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = async (exitCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutMarker);
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      await (cleanup ?? forceRemoveContainer(containerName));
      const extra = error?.message ?? (aborted && input.signal ? abortMessage(input.signal) : "");
      resolve({
        command: input.command,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout: boundedLog(Buffer.concat(stdout).toString("utf8")),
        stderr: boundedLog(
          [Buffer.concat(stderr).toString("utf8"), extra].filter(Boolean).join("\n"),
        ),
        timedOut,
      });
    };
    child.once("error", (error) => void finish(null, error));
    child.once("close", (exitCode) => void finish(exitCode));
    if (input.signal?.aborted) onAbort();
  });
}

export async function inspectAppliedPayloadDigests(
  root: string,
  changes: RepositoryChange[],
): Promise<string[]> {
  const findings: string[] = [];
  for (const change of changes) {
    try {
      await assertNoSymlinkInPath(root, change.path);
      const absolute = path.resolve(root, ...change.path.split("/"));
      let current: Buffer | null = null;
      try {
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.size > MAX_VERIFICATION_FILE_BYTES) {
          throw new Error("patched path is no longer a bounded regular file");
        }
        current = await fs.readFile(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (
        change.after === null
          ? current !== null
          : current === null || sha256(current) !== sha256(change.after)
      ) {
        findings.push(`${change.path}: Verification command mutated a delivered file`);
      }
    } catch (error) {
      findings.push(
        `${change.path}: Verification command invalidated a delivered path (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
    if (findings.length >= 50) break;
  }
  return findings.map((finding) => boundedLog(finding, 1000));
}

function timedOutResult(
  command: string,
  startedAt: number,
): VerificationResult["commands"][number] {
  return {
    command,
    exitCode: null,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdout: "",
    stderr: "Patchrail's total verification timeout was reached before this command ran.",
    timedOut: true,
  };
}

export async function executeVerification(input: {
  root: string;
  ecosystem: string;
  installCommand: string | null;
  commands: string[];
  payload: ChangedFilePayload[];
  runnerId: string;
  signal?: AbortSignal;
}): Promise<VerificationResult> {
  const startedAt = new Date();
  const totalSteps = input.commands.length + (input.installCommand ? 1 : 0);
  if (input.commands.length === 0 || totalSteps > MAX_VERIFICATION_COMMANDS) {
    throw new Error("Verification command count is invalid");
  }
  if (input.signal?.aborted) throw new Error(abortMessage(input.signal));
  assertSupportedDependencyPreparation(input.ecosystem, input.installCommand);

  await makeRepositoryTreeOwnerWritable(input.root);
  const changes = await applyVerificationPayload(input.root, input.payload);
  const inspectedIntegrity = inspectTestIntegrity(changes);
  const integrity = {
    passed: inspectedIntegrity.passed,
    findings: inspectedIntegrity.findings.slice(0, 50).map((finding) => boundedLog(finding, 1000)),
  };
  const results: VerificationResult["commands"] = [];
  const deadline = Date.now() + verificationTimeoutSeconds() * 1000;
  const packageManager = integrity.passed ? await resolveJobPackageManager(input) : null;
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "patchrail-verification-cache-"));

  try {
    await chownTreeForContainer(input.root);
    await chownTreeForContainer(cacheRoot);
    const mergePayloadIntegrity = async () => {
      const payloadFindings = await inspectAppliedPayloadDigests(input.root, changes);
      for (const finding of payloadFindings) {
        if (!integrity.findings.includes(finding) && integrity.findings.length < 50) {
          integrity.findings.push(finding);
        }
      }
      integrity.passed = integrity.findings.length === 0;
    };
    const run = async (command: string, network: "bridge" | "none", install = false) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return timedOutResult(command, startedAt.getTime());
      const result = await runDockerCommand({
        root: input.root,
        cacheRoot,
        ecosystem: input.ecosystem,
        command,
        network,
        timeoutMs: remaining,
        signal: input.signal,
        install,
        packageManager,
      });
      if (input.signal?.aborted) throw new Error(abortMessage(input.signal));
      await mergePayloadIntegrity();
      return result;
    };

    if (integrity.passed && input.installCommand) {
      results.push(await run(input.installCommand, "bridge", true));
    }

    if (integrity.passed && results.every((result) => result.exitCode === 0 && !result.timedOut)) {
      for (const command of input.commands) {
        const result = await run(command, "none");
        results.push(result);
        if (result.exitCode !== 0 || result.timedOut || !integrity.passed) break;
      }
    }

    await mergePayloadIntegrity();

    const passed =
      integrity.passed &&
      results.length === totalSteps &&
      results.every((result) => result.exitCode === 0 && !result.timedOut);
    return {
      status: passed ? "PASSED" : "FAILED",
      commands: results,
      integrityPassed: integrity.passed,
      integrityFindings: integrity.findings,
      runner: input.runnerId,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
}
