"use client";

export default function AppError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        The request could not be completed. If this keeps happening, contact
        your organization owner.
      </p>
      <button onClick={reset} className="text-sm font-medium underline">
        Try again
      </button>
    </div>
  );
}
