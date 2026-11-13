import Link from "next/link";
import { PulseIcon } from "./ui/icons";

export function BrandMark({ href = "/dashboard" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 font-semibold tracking-tight text-ink"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-700 text-gold-500">
        <PulseIcon className="h-4 w-4" />
      </span>
      UpSiteHealth
    </Link>
  );
}
