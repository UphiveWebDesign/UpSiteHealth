import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <BrandMark href="/" />
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card sm:p-8">
          {children}
        </div>
      </div>
    </main>
  );
}
