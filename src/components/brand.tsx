import Image from "next/image";
import Link from "next/link";

type BrandProps = {
  href?: string;
  inverse?: boolean;
  compact?: boolean;
  className?: string;
};

export function Brand({ href = "/", inverse = false, compact = false, className }: BrandProps) {
  const src = compact
    ? inverse
      ? "/symbol-reverse.svg"
      : "/symbol-master.svg"
    : inverse
      ? "/wordmark-horizontal-reverse.svg"
      : "/wordmark-horizontal.svg";
  const image = (
    <Image
      alt=""
      aria-hidden="true"
      className={className}
      height={compact ? 28 : 32}
      priority
      src={src}
      width={compact ? 28 : 140}
    />
  );

  return (
    <Link aria-label="Patchrail home" className="brand-link" href={href}>
      {image}
      <span className="sr-only">Patchrail</span>
    </Link>
  );
}

export function BrandMark({
  inverse = false,
  className,
}: Pick<BrandProps, "inverse" | "className">) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={className}
      height={24}
      src={inverse ? "/symbol-reverse.svg" : "/symbol-master.svg"}
      width={24}
    />
  );
}
