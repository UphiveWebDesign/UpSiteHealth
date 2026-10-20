import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { buttonClass } from "@/components/ui/button";

// Rendered per request so its scripts receive the CSP nonce (see src/proxy.ts).
export const dynamic = "force-dynamic";

const FEATURES = [
  [
    "Always-on monitoring",
    "Uptime, SSL and DNS checks with alerts when something breaks.",
  ],
  [
    "Technical SEO",
    "Crawl every page and get prioritised fixes, not just a list of errors.",
  ],
  [
    "One health score",
    "See what is measured, what is missing and what to do next.",
  ],
] as const;

export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <BrandMark href="/" />
        <Link href="/login" className={buttonClass("ghost", "sm")}>
          Sign in
        </Link>
      </header>
      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-16">
        <p className="text-sm font-semibold text-brand-700">
          Website health monitoring
        </p>
        <h1 className="mt-2 max-w-2xl text-4xl font-semibold tracking-tight text-ink">
          Know when your websites need attention — and exactly what to fix.
        </h1>
        <p className="mt-4 max-w-xl text-ink-2">
          UpSiteHealth watches availability, certificates, DNS, SEO and
          performance for every site you manage, then turns the results into
          clear next steps.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/signup" className={buttonClass("primary")}>
            Create account
          </Link>
          <Link href="/login" className={buttonClass("secondary")}>
            Sign in
          </Link>
        </div>
        <dl className="mt-14 grid gap-4 sm:grid-cols-3">
          {FEATURES.map(([title, text]) => (
            <div
              key={title}
              className="rounded-xl border border-line bg-surface p-5 shadow-card"
            >
              <dt className="text-sm font-semibold text-ink">{title}</dt>
              <dd className="mt-1 text-sm text-muted">{text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
