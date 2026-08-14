export type PinnedCorepackPackageManager = {
  name: "pnpm" | "yarn";
  descriptor: string;
  version: string;
  major: number;
};

// Corepack accepts integrity-qualified descriptors such as
// `pnpm@10.0.0+sha224.<hex>`. Restrict the version portion to an exact SemVer
// so an untrusted repository cannot make the runner resolve a tag, range, or
// custom package-manager URL while its install container has egress.
const EXACT_COREPACK_DESCRIPTOR =
  /^(pnpm|yarn)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+sha(?:224|256|384|512)\.[0-9a-fA-F]+)?$/;

export function parsePinnedCorepackPackageManager(
  value: unknown,
): PinnedCorepackPackageManager | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const match = EXACT_COREPACK_DESCRIPTOR.exec(value);
  if (!match) return null;
  const major = Number(match[2]);
  if (!Number.isSafeInteger(major)) return null;
  return {
    name: match[1] as "pnpm" | "yarn",
    descriptor: value,
    version: `${match[2]}.${match[3]}.${match[4]}${match[5] ?? ""}`,
    major,
  };
}

export function requirePinnedCorepackPackageManager(
  value: unknown,
  expected: "pnpm" | "yarn",
): PinnedCorepackPackageManager {
  const manager = parsePinnedCorepackPackageManager(value);
  if (!manager || manager.name !== expected) {
    throw new Error(
      `${expected} verification requires package.json packageManager to pin an exact ${expected} version`,
    );
  }
  return manager;
}
