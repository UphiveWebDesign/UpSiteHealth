"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Navigation link that highlights itself on its own route (or sub-routes unless `exact`). */
export function NavLink({
  href,
  children,
  exact = false,
  variant = "tab",
}: {
  href: string;
  children: ReactNode;
  exact?: boolean;
  variant?: "tab" | "pill";
}) {
  const pathname = usePathname();
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
  const styles =
    variant === "tab"
      ? `relative inline-flex h-11 items-center px-1 text-sm font-medium transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full ${
          active
            ? "text-brand-800 after:bg-brand-600"
            : "text-ink-2 hover:text-ink after:bg-transparent"
        }`
      : `inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          active
            ? "bg-brand-50 text-brand-800"
            : "text-ink-2 hover:bg-slate-100 hover:text-ink"
        }`;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={styles}
    >
      {children}
    </Link>
  );
}
