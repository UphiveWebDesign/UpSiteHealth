import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dal";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create account · UpSiteHealth" };

export default async function SignupPage() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Create your account
      </h1>
      <SignupForm />
      <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
        Already have an account?{" "}
        <Link href="/login" className="font-medium underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
