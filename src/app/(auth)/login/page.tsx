import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dal";
import { safeRedirectPath } from "@/lib/auth/redirect";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · UpSiteHealth" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const nextPath = safeRedirectPath(next);
  if (await getCurrentUser()) redirect(nextPath);

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Sign in</h1>
      <LoginForm next={nextPath} />
      <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
        No account?{" "}
        <Link href="/signup" className="font-medium underline">
          Create one
        </Link>
      </p>
    </>
  );
}
