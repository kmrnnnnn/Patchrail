import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const PATCHRAIL_DIRECTORY = "/patchrail";
const ARCHIVE_PATH = `${PATCHRAIL_DIRECTORY}/source.tgz`;
const JOB_PATH = `${PATCHRAIL_DIRECTORY}/job.json`;
const REPOSITORY_ROOT = `${PATCHRAIL_DIRECTORY}/repository`;
const CACHE_ROOT = `${PATCHRAIL_DIRECTORY}/verification-cache`;
const CONTAINER_CACHE_ROOT = "/patchrail-cache";
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 512_000;
const MAX_PAYLOAD_BYTES = 20 * MAX_FILE_BYTES;
const MAX_CAPTURED_BYTES = 64_000;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const EXCLUDED_DIRECTORIES = new Set([
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
const SENSITIVE_NAMES = [
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
const SENSITIVE_PATHS = [
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

const digest = (value) => createHash("sha256").update(value).digest("hex");
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const boundedNumber = (value, minimum, maximum, name) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside its safe range`);
  }
  return value;
};
const boundedInteger = (value, minimum, maximum, name) => {
  boundedNumber(value, minimum, maximum, name);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
};
const EXACT_COREPACK_DESCRIPTOR =
  /^(pnpm|yarn)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+sha(?:224|256|384|512)\.[0-9a-fA-F]+)?$/;
const requirePinnedPackageManager = (value, expected) => {
  if (typeof value !== "string" || value.length > 200) {
    throw new Error(`${expected} verification requires an exact packageManager version`);
  }
  const match = EXACT_COREPACK_DESCRIPTOR.exec(value);
  if (!match || match[1] !== expected) {
    throw new Error(`${expected} verification requires an exact packageManager version`);
  }
  return { name: expected, descriptor: value, major: Number(match[2]) };
};

function safeSegment(segment) {
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

function normalizeRelative(input) {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > 4096 ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input)
  )
    throw new Error("Invalid changed file path");
  const parts = input.split("/");
  if (parts.some((part) => !safeSegment(part))) throw new Error("Invalid changed file path");
  return parts.join("/");
}

function assertPathPolicy(relative) {
  const segments = relative.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment.toLowerCase())))
    throw new Error(`Excluded path: ${relative}`);
  const name = segments.at(-1) ?? "";
  const example = name === ".env.example" || name.endsWith(".env.example");
  if (
    (!example && SENSITIVE_NAMES.some((pattern) => pattern.test(name))) ||
    SENSITIVE_PATHS.some((pattern) => pattern.test(relative))
  )
    throw new Error(`Sensitive path: ${relative}`);
  if (relative.toLowerCase().startsWith(".github/workflows/"))
    throw new Error("GitHub workflow files cannot be changed");
}

function sensitiveRepositoryPath(relative) {
  const name = path.posix.basename(relative);
  const example = name === ".env.example" || name.endsWith(".env.example");
  return (
    (!example && SENSITIVE_NAMES.some((pattern) => pattern.test(name))) ||
    SENSITIVE_PATHS.some((pattern) => pattern.test(relative))
  );
}

function validateArchiveName(input, expectedWrapper) {
  if (
    !input ||
    input.length > 8192 ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input)
  ) {
    throw new Error("Repository archive contains an unsafe path");
  }
  const value = input.endsWith("/") ? input.slice(0, -1) : input;
  const parts = value.split("/");
  if (parts.some((part) => !safeSegment(part)))
    throw new Error("Repository archive contains an unsafe path");
  const wrapper = parts.shift();
  if (!wrapper || (expectedWrapper && wrapper !== expectedWrapper))
    throw new Error("Repository archive has multiple roots");
  return { wrapper, relative: parts.length ? parts.join("/") : null };
}

const jobBytes = await fs.readFile(JOB_PATH);
if (jobBytes.byteLength === 0 || jobBytes.byteLength > 16 * 1024 * 1024)
  throw new Error("Sandbox job is outside its size limit");
const job = JSON.parse(jobBytes.toString("utf8"));
if (!isPlainObject(job) || !["node", "python", "rust", "go"].includes(job.ecosystem))
  throw new Error("Invalid sandbox job");
if (
  job.installCommand !== null &&
  (typeof job.installCommand !== "string" ||
    !job.installCommand ||
    job.installCommand.length > 1000)
)
  throw new Error("Invalid install command");
if (
  !Array.isArray(job.commands) ||
  job.commands.length < 1 ||
  job.commands.length + (job.installCommand ? 1 : 0) > 20 ||
  job.commands.some(
    (command) =>
      typeof command !== "string" || !command || command.length > 1000 || command.includes("\0"),
  )
) {
  throw new Error("Invalid verification commands");
}
if (!Array.isArray(job.payload) || job.payload.length < 1 || job.payload.length > 20)
  throw new Error("Invalid verification payload");
const timeoutSeconds = boundedInteger(job.timeoutSeconds, 30, 3600, "Verification timeout");
const cpuLimit = boundedNumber(job.cpuLimit, 0.25, 8, "CPU limit");
const memoryMb = boundedInteger(job.memoryMb, 256, 16_384, "Memory limit");

const archiveStat = await fs.stat(ARCHIVE_PATH);
if (!archiveStat.isFile() || archiveStat.size <= 0 || archiveStat.size > MAX_ARCHIVE_BYTES)
  throw new Error("Sandbox archive is outside its size limit");
const tarOptions = {
  encoding: "utf8",
  timeout: Math.min(timeoutSeconds * 1000, 300_000),
  maxBuffer: 32 * 1024 * 1024,
};
const namesOutput = execFileSync(
  "tar",
  ["-tzf", ARCHIVE_PATH, "--quoting-style=escape"],
  tarOptions,
);
const verboseOutput = execFileSync(
  "tar",
  ["-tzvf", ARCHIVE_PATH, "--numeric-owner", "--quoting-style=escape"],
  tarOptions,
);
const names = namesOutput.trimEnd().split("\n").filter(Boolean);
const verbose = verboseOutput.trimEnd().split("\n").filter(Boolean);
if (names.length === 0 || names.length !== verbose.length || names.length > MAX_ARCHIVE_ENTRIES)
  throw new Error("Repository archive manifest is invalid");
let wrapper = null;
let expandedBytes = 0;
const archivePaths = new Set();
for (let index = 0; index < names.length; index += 1) {
  const type = verbose[index]?.[0];
  if (type !== "-" && type !== "d")
    throw new Error("Repository archive links and special files are not allowed");
  const parsed = validateArchiveName(names[index], wrapper);
  wrapper ??= parsed.wrapper;
  if (parsed.relative !== null) {
    if (sensitiveRepositoryPath(parsed.relative))
      throw new Error(`Repository archive contains a credential-bearing path: ${parsed.relative}`);
    const key = parsed.relative.normalize("NFC").toLocaleLowerCase("en-US");
    if (archivePaths.has(key))
      throw new Error(`Repository archive path collision: ${parsed.relative}`);
    archivePaths.add(key);
  } else if (type !== "d") throw new Error("Repository archive root must be a directory");
  const sizeMatch = verbose[index].match(/^\S+\s+\S+\s+(\d+)\s+/);
  if (!sizeMatch) throw new Error("Repository archive size manifest is invalid");
  const size = Number(sizeMatch[1]);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_ENTRY_BYTES)
    throw new Error("Repository archive entry is too large");
  expandedBytes += size;
  if (expandedBytes > MAX_EXPANDED_BYTES)
    throw new Error("Repository archive expands beyond the safe limit");
}

await fs.mkdir(REPOSITORY_ROOT, { recursive: true });
execFileSync(
  "tar",
  [
    "-xzf",
    ARCHIVE_PATH,
    "--strip-components=1",
    "-C",
    REPOSITORY_ROOT,
    "--no-same-owner",
    "--no-same-permissions",
    "--delay-directory-restore",
  ],
  {
    timeout: Math.min(timeoutSeconds * 1000, 300_000),
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 1024 * 1024,
  },
);

let extractedEntries = 0;
let extractedBytes = 0;
async function inspectTree(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    extractedEntries += 1;
    if (extractedEntries > MAX_ARCHIVE_ENTRIES)
      throw new Error("Extracted repository has too many entries");
    const absolute = path.join(directory, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error("Extracted repository contains a link or special file");
    if (stat.isDirectory()) await inspectTree(absolute);
    else {
      extractedBytes += stat.size;
      if (stat.size > MAX_ARCHIVE_ENTRY_BYTES || extractedBytes > MAX_EXPANDED_BYTES)
        throw new Error("Extracted repository exceeds its size limit");
    }
  }
}
await inspectTree(REPOSITORY_ROOT);

async function makeTreeOwnerWritable(entryPath) {
  const stat = await fs.lstat(entryPath);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new Error("Repository contains a link or special file");
  await fs.chmod(entryPath, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory())
    for (const entry of await fs.readdir(entryPath))
      await makeTreeOwnerWritable(path.join(entryPath, entry));
}
await makeTreeOwnerWritable(REPOSITORY_ROOT);

const changes = [];
const changedPaths = new Set();
let payloadBytes = 0;
for (const file of job.payload) {
  if (!isPlainObject(file) || !["CREATE", "UPDATE", "DELETE"].includes(file.operation))
    throw new Error("Invalid payload entry");
  const relative = normalizeRelative(file.path);
  assertPathPolicy(relative);
  const key = relative.normalize("NFC").toLocaleLowerCase("en-US");
  if (changedPaths.has(key)) throw new Error(`Duplicate changed file: ${relative}`);
  changedPaths.add(key);
  const absolute = path.resolve(REPOSITORY_ROOT, ...relative.split("/"));
  const relativeToRoot = path.relative(REPOSITORY_ROOT, absolute);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith("../") ||
    path.isAbsolute(relativeToRoot) ||
    absolute === REPOSITORY_ROOT
  )
    throw new Error("Path escaped repository");
  let current = REPOSITORY_ROOT;
  for (const [index, segment] of relative.split("/").entries()) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be changed: ${relative}`);
      if (index < relative.split("/").length - 1 && !stat.isDirectory())
        throw new Error(`Invalid parent path: ${relative}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      else throw error;
    }
  }
  let before = null;
  try {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error(`Changed file is not bounded text: ${relative}`);
    before = await fs.readFile(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if ((before ? digest(before) : null) !== file.beforeSha256)
    throw new Error(`Source digest mismatch: ${relative}`);
  if (file.operation === "CREATE" && before !== null)
    throw new Error(`Create target exists: ${relative}`);
  if (file.operation !== "CREATE" && before === null)
    throw new Error(`Changed target is missing: ${relative}`);
  let after = null;
  if (file.operation === "DELETE") {
    if (file.contentBase64 !== null || file.afterSha256 !== null)
      throw new Error(`Invalid delete payload: ${relative}`);
    await fs.unlink(absolute);
  } else {
    if (
      typeof file.contentBase64 !== "string" ||
      typeof file.afterSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.afterSha256)
    )
      throw new Error(`Missing patch content: ${relative}`);
    if (
      file.contentBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)
    )
      throw new Error(`Invalid base64 patch: ${relative}`);
    after = Buffer.from(file.contentBase64, "base64");
    if (after.length > MAX_FILE_BYTES || after.toString("base64") !== file.contentBase64)
      throw new Error(`Oversized patch: ${relative}`);
    new TextDecoder("utf-8", { fatal: true }).decode(after);
    if (after.includes(0) || digest(after) !== file.afterSha256)
      throw new Error(`Patch digest mismatch: ${relative}`);
    payloadBytes += after.length;
    if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error("Patch payload is too large");
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, after, { flag: file.operation === "CREATE" ? "wx" : "w" });
  }
  changes.push({ path: relative, operation: file.operation, before, after });
}

const findings = [];
const suspicious = [
  [/\.(?:skip|only)\s*\(/, "Focused or skipped test added"],
  [/\b(?:describe|it|test)\.skip\b/, "Skipped test added"],
  [/@ts-(?:ignore|nocheck)/, "Broad TypeScript suppression added"],
  [/"(?:noEmitOnError|strict|noImplicitAny)"\s*:\s*false/i, "TypeScript validation weakened"],
  [/#\s*type:\s*ignore/, "Python type suppression added"],
  [/eslint-disable(?:-next-line)?\b/, "Lint validation suppression added"],
  [/eslint-disable-file\b/, "File-wide lint validation disabled"],
  [/coverage:\s*ignore|istanbul\s+ignore/i, "Coverage suppression added"],
  [/pytest(?:mark)?\.(?:skip|xfail)|@unittest\.skip/i, "Python test skipped"],
  [/#\[ignore\]/, "Rust test skipped"],
  [/t\.Skip\s*\(/, "Go test skipped"],
];
const protectedVerificationConfiguration =
  /(?:^|\/)(?:vitest|vite|jest|playwright|pytest|tox|nox|cargo|tsconfig)(?:\.[^/]+)?\.(?:js|cjs|mjs|ts|json|toml|ini)$|(?:^|\/)pytest\.ini$|(?:^|\/)tox\.ini$/i;
const countMatches = (value, pattern) =>
  value.split("\n").filter((line) => pattern.test(line)).length;
for (const change of changes) {
  const before = change.before?.toString("utf8") ?? "";
  const after = change.after?.toString("utf8") ?? "";
  const beforeLinesSet = new Set(before.split("\n"));
  const added = after
    .split("\n")
    .filter((line) => !beforeLinesSet.has(line))
    .join("\n");
  if (change.path.toLowerCase() === "package.json" && before.length > 0) {
    try {
      const beforeManifest = JSON.parse(before);
      const afterManifest = JSON.parse(after);
      const beforeScripts = beforeManifest.scripts ?? {};
      const afterScripts = afterManifest.scripts ?? {};
      if (afterManifest.packageManager !== beforeManifest.packageManager) {
        findings.push(`${change.path}: Package-manager selection changed`);
      }
      for (const script of ["typecheck", "test", "build"]) {
        const original = beforeScripts[script];
        if (typeof original === "string" && afterScripts[script] !== original) {
          findings.push(
            `${change.path}: Existing ${script} verification script changed or removed`,
          );
        }
        if (typeof original === "string") {
          for (const hook of [`pre${script}`, `post${script}`]) {
            if (afterScripts[hook] !== beforeScripts[hook]) {
              findings.push(`${change.path}: ${script} verification lifecycle hook changed`);
            }
          }
        }
      }
    } catch {
      findings.push(
        `${change.path}: package.json could not be checked for verification-script integrity`,
      );
    }
  }
  for (const [pattern, message] of suspicious)
    if (pattern.test(added)) findings.push(`${change.path}: ${message}`);
  if (before !== after && protectedVerificationConfiguration.test(change.path)) {
    findings.push(`${change.path}: Verification configuration changed`);
  }
  const isTest = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(
    change.path,
  );
  if (!isTest) continue;
  if (change.operation === "DELETE") {
    findings.push(`${change.path}: Test file deleted`);
    continue;
  }
  const beforeAssertions = countMatches(before, /\bexpect\s*\(|\bassert\b|should\s*\(/);
  const afterAssertions = countMatches(after, /\bexpect\s*\(|\bassert\b|should\s*\(/);
  if (beforeAssertions >= 3 && afterAssertions < Math.ceil(beforeAssertions * 0.6))
    findings.push(`${change.path}: Large assertion reduction detected`);
  if (
    before.split("\n").length >= 30 &&
    after.split("\n").length < before.split("\n").length * 0.55
  )
    findings.push(`${change.path}: Large test deletion detected`);
}

async function chownTree(entryPath) {
  const stat = await fs.lstat(entryPath);
  if (stat.isSymbolicLink()) throw new Error("Repository contains a symbolic link");
  if (process.getuid?.() === 0) await fs.chown(entryPath, 1000, 1000);
  if (stat.isDirectory())
    for (const entry of await fs.readdir(entryPath)) await chownTree(path.join(entryPath, entry));
}
await chownTree(REPOSITORY_ROOT);
await fs.mkdir(CACHE_ROOT, { recursive: false });
await chownTree(CACHE_ROOT);

// Keep these multi-architecture manifest pins synchronized with execute.ts.
const images = {
  node: "node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a",
  python:
    "python:3.13-bookworm@sha256:62eafe52c91cad83c2c74e630bfde917da8c253673e695665d454def84fc9a13",
  rust: "rust:1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97",
  go: "golang:1.25-bookworm@sha256:6359592445455f2dbe2412bed411336035bc019a50017720d77454ffdd6d0f82",
};
if (
  job.ecosystem === "rust" &&
  !["cargo fetch", "cargo fetch --locked"].includes(job.installCommand)
) {
  throw new Error("Rust verification requires a bounded cargo fetch preparation step");
}
if (job.ecosystem === "go" && job.installCommand !== "go mod download all") {
  throw new Error("Go verification requires a bounded module download preparation step");
}
if (job.ecosystem === "python" && job.installCommand !== "pip install -r requirements.txt") {
  throw new Error("Python verification requires a supported requirements.txt preparation step");
}

const managerUsedByCommand = (command) =>
  command?.startsWith("pnpm ") ? "pnpm" : command?.startsWith("yarn ") ? "yarn" : null;
const managers = new Set(
  [job.installCommand, ...job.commands].map(managerUsedByCommand).filter(Boolean),
);
let packageManager = null;
if (job.ecosystem === "node" && managers.size > 0 && findings.length === 0) {
  if (managers.size !== 1 || !job.installCommand) {
    throw new Error("Verification uses an unsupported package-manager command set");
  }
  const expected = [...managers][0];
  const manifestBytes = await fs.readFile(path.join(REPOSITORY_ROOT, "package.json"));
  if (manifestBytes.length > MAX_FILE_BYTES) throw new Error("package.json is too large");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  packageManager = requirePinnedPackageManager(manifest.packageManager, expected);
  const expectedInstall =
    expected === "pnpm"
      ? "pnpm install --frozen-lockfile"
      : packageManager.major === 1
        ? "yarn install --frozen-lockfile"
        : "yarn install --immutable";
  if (job.installCommand !== expectedInstall) {
    throw new Error(
      "Verification install command does not match the pinned package-manager version",
    );
  }
}

const normalizeCommand = (command) => {
  if (job.ecosystem === "python")
    return `export PATH="/workspace/.patchrail-venv/bin:$PATH"; ${command}`;
  if (job.ecosystem === "rust") return `export CARGO_NET_OFFLINE=true; ${command}`;
  if (job.ecosystem === "node" && /^(?:pnpm|yarn) /.test(command)) {
    if (!packageManager || !command.startsWith(`${packageManager.name} `)) {
      throw new Error("Verification package manager does not match its pinned descriptor");
    }
    return `export PATH="${CONTAINER_CACHE_ROOT}/bin:$PATH"; ${command}`;
  }
  return command;
};
const installCommand = (command) => {
  if (job.ecosystem === "node") {
    if (command === "npm ci" || command === "npm install")
      return `${command} --ignore-scripts --no-audit --no-fund`;
    if (command === "pnpm install --frozen-lockfile")
      return "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile";
    if (command === "yarn install --immutable") return "yarn install --immutable --mode=skip-build";
    if (command === "yarn install --frozen-lockfile")
      return "yarn install --frozen-lockfile --ignore-scripts --non-interactive";
  }
  if (job.ecosystem === "python" && command === "pip install -r requirements.txt")
    return "python -m venv /workspace/.patchrail-venv && /workspace/.patchrail-venv/bin/pip install --only-binary=:all: --disable-pip-version-check --no-input -r requirements.txt";
  if (job.ecosystem === "rust" && (command === "cargo fetch" || command === "cargo fetch --locked"))
    return command;
  if (job.ecosystem === "go" && command === "go mod download all") return command;
  throw new Error("Unsupported dependency installation command");
};
const prepareInstallCommand = (command) => {
  const hardened = installCommand(command);
  if (!packageManager) return hardened;
  return [
    `mkdir -p "${CONTAINER_CACHE_ROOT}/bin" "${CONTAINER_CACHE_ROOT}/corepack"`,
    `export PATH="${CONTAINER_CACHE_ROOT}/bin:$PATH"`,
    `corepack ${packageManager.descriptor} --version >/dev/null`,
    `corepack enable --install-directory "${CONTAINER_CACHE_ROOT}/bin" ${packageManager.name}`,
    hardened,
  ].join(" && ");
};
const secretPatterns = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED_STRIPE_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED]"],
];
const boundedLog = (value) => {
  let output = value.replace(/\0/g, "");
  for (const [pattern, replacement] of secretPatterns)
    output = output.replace(pattern, replacement);
  return output.length <= 30_000
    ? output
    : `${output.slice(0, 30_000)}\n[output truncated by Patchrail]`;
};
const removeContainer = (name) =>
  new Promise((resolve) => {
    const child = spawn("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 15_000);
    child.once("error", finish);
    child.once("close", finish);
  });
const run = (command, network, timeoutMs, install) =>
  new Promise((resolve) => {
    const started = Date.now();
    const name = `patchrail-${randomUUID()}`;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let cleanup = null;
    const inContainerTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000) - 5);
    const args = [
      "run",
      "--name",
      name,
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
      "1000:1000",
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
      network,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=536870912,mode=1777",
      "--mount",
      `type=bind,src=${REPOSITORY_ROOT},dst=/workspace`,
      "--mount",
      `type=bind,src=${CACHE_ROOT},dst=${CONTAINER_CACHE_ROOT}${install ? "" : ",readonly"}`,
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
      `COREPACK_ENABLE_NETWORK=${install ? "1" : "0"}`,
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
      `YARN_ENABLE_NETWORK=${install ? "true" : "false"}`,
      "--env",
      `YARN_ENABLE_IMMUTABLE_CACHE=${install ? "false" : "true"}`,
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
      ...(!install ? ["--env", "GOPROXY=off"] : []),
      images[job.ecosystem],
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      `${inContainerTimeoutSeconds}s`,
      "bash",
      "-lc",
      install ? prepareInstallCommand(command) : normalizeCommand(command),
    ];
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes < MAX_CAPTURED_BYTES)
        stdout.push(chunk.subarray(0, MAX_CAPTURED_BYTES - stdoutBytes));
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < MAX_CAPTURED_BYTES)
        stderr.push(chunk.subarray(0, MAX_CAPTURED_BYTES - stderrBytes));
      stderrBytes += chunk.length;
    });
    const timeoutMarker = setTimeout(() => {
      timedOut = true;
    }, inContainerTimeoutSeconds * 1000);
    const timeout = setTimeout(
      () => {
        timedOut = true;
        cleanup ??= removeContainer(name);
        child.kill("SIGKILL");
      },
      Math.max(1, timeoutMs),
    );
    const finish = async (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutMarker);
      clearTimeout(timeout);
      await (cleanup ?? removeContainer(name));
      resolve({
        command,
        exitCode,
        durationMs: Date.now() - started,
        stdout: boundedLog(Buffer.concat(stdout).toString("utf8")),
        stderr: boundedLog(
          [Buffer.concat(stderr).toString("utf8"), error?.message].filter(Boolean).join("\n"),
        ),
        timedOut,
      });
    };
    child.once("error", (error) => void finish(null, error));
    child.once("close", (code) => void finish(code));
  });

const startedAt = new Date();
const deadline = Date.now() + timeoutSeconds * 1000;
const results = [];
const inspectPayloadDigests = async () => {
  for (const change of changes) {
    try {
      let currentPath = REPOSITORY_ROOT;
      for (const [index, segment] of change.path.split("/").entries()) {
        currentPath = path.join(currentPath, segment);
        try {
          const stat = await fs.lstat(currentPath);
          if (stat.isSymbolicLink()) throw new Error("delivered path became a symbolic link");
          if (index < change.path.split("/").length - 1 && !stat.isDirectory())
            throw new Error("delivered path parent is no longer a directory");
        } catch (error) {
          if (error.code === "ENOENT") break;
          throw error;
        }
      }
      const absolute = path.resolve(REPOSITORY_ROOT, ...change.path.split("/"));
      let current = null;
      try {
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
          throw new Error("delivered path is no longer a bounded regular file");
        current = await fs.readFile(absolute);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        change.after === null
          ? current !== null
          : current === null || digest(current) !== digest(change.after)
      ) {
        const finding = `${change.path}: Verification command mutated a delivered file`;
        if (!findings.includes(finding)) findings.push(finding);
      }
    } catch (error) {
      const finding = `${change.path}: Verification command invalidated a delivered path (${error instanceof Error ? error.message : "unknown error"})`;
      if (!findings.includes(finding)) findings.push(finding);
    }
    if (findings.length >= 50) break;
  }
};
const runBounded = async (command, network, install = false) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return {
      command,
      exitCode: null,
      durationMs: Date.now() - startedAt.getTime(),
      stdout: "",
      stderr: "Patchrail's total verification timeout was reached before this command ran.",
      timedOut: true,
    };
  const result = await run(command, network, remaining, install);
  await inspectPayloadDigests();
  return result;
};
if (findings.length === 0 && job.installCommand)
  results.push(await runBounded(job.installCommand, "bridge", true));
if (findings.length === 0 && results.every((item) => item.exitCode === 0 && !item.timedOut)) {
  for (const command of job.commands) {
    const result = await runBounded(command, "none");
    results.push(result);
    if (result.exitCode !== 0 || result.timedOut || findings.length > 0) break;
  }
}
await inspectPayloadDigests();
const totalSteps = job.commands.length + (job.installCommand ? 1 : 0);
const passed =
  findings.length === 0 &&
  results.length === totalSteps &&
  results.every((item) => item.exitCode === 0 && !item.timedOut);
await fs.rm(CACHE_ROOT, { recursive: true, force: true });
process.stdout.write(
  JSON.stringify({
    status: passed ? "PASSED" : "FAILED",
    commands: results,
    integrityPassed: findings.length === 0,
    integrityFindings: findings.slice(0, 50).map((finding) => boundedLog(finding).slice(0, 1000)),
    runner: "railway-sandbox",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
  }),
);
