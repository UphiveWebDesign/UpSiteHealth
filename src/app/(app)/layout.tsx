import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/(auth)/actions";
import { BrandMark } from "@/components/brand";
import { Button } from "@/components/ui/form";
import { requireUser } from "@/lib/auth/dal";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line bg-surface print:hidden">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <BrandMark />
          <div className="flex items-center gap-1 text-sm">
            <Link
              href="/account"
              className="hidden max-w-56 truncate rounded-md px-2 py-1 text-ink-2 hover:bg-slate-100 hover:text-ink sm:block"
              title="Account settings"
            >
              {user.email}
            </Link>
            <form action={logout}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
