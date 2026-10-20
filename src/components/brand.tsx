import Link from "next/link";
import { PulseIcon } from "./ui/icons";

export function BrandMark({ href = "/dashboard" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 font-semibold tracking-tight text-ink"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-700 text-white">
        <PulseIcon className="h-4 w-4" />
      </span>
      UpSiteHealth
    </Link>
  );
}
