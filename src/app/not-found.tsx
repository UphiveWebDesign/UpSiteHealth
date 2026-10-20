import Link from "next/link";
import { buttonClass } from "@/components/ui/button";

/** Also used for organizations and websites the user cannot access, so it reveals nothing. */
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="max-w-md rounded-xl border border-line bg-surface p-8 text-center shadow-card">
        <p className="text-sm font-semibold text-brand-700">404</p>
        <h1 className="mt-1 text-lg font-semibold text-ink">Page not found</h1>
        <p className="mt-1 text-sm text-muted">
          It may have been removed, or you may not have access to it.
        </p>
        <Link href="/dashboard" className={`${buttonClass("primary")} mt-5`}>
          Go to dashboard
        </Link>
      </div>
    </main>
  );
}
