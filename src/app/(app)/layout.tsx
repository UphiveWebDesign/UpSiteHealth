import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/form";
import { requireUser } from "@/lib/auth/dal";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/dashboard" className="font-semibold">
            UpSiteHealth
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {user.email}
            </span>
            <form action={logout}>
              <Button type="submit" variant="ghost">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </div>
    </div>
  );
}
