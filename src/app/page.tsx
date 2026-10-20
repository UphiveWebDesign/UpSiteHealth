import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">UpSiteHealth</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Website health monitoring and SEO analysis.
      </p>
      <div className="flex gap-4 text-sm font-medium">
        <Link href="/login" className="underline">
          Sign in
        </Link>
        <Link href="/signup" className="underline">
          Create account
        </Link>
      </div>
    </main>
  );
}
