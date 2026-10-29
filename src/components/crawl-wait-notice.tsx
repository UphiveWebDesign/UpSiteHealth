import Link from "next/link";
import type { CrawlMode } from "@/generated/prisma/enums";
import { Callout } from "@/components/ui/feedback";

/**
 * Shown where tasks wait for evidence that only a crawl can bring, when the
 * website will not crawl by itself (crawl mode MANUAL, or monitoring
 * paused). Nothing when no such task waits or crawling is automatic.
 */
export function CrawlWaitNotice({
  crawlMode,
  monitoringEnabled,
  waiting,
  crawlsHref,
}: {
  crawlMode: CrawlMode;
  monitoringEnabled: boolean;
  waiting: number;
  crawlsHref: string;
}) {
  if (waiting === 0) return null;
  if (crawlMode === "AUTOMATIC" && monitoringEnabled) return null;
  const tasks = waiting === 1 ? "1 task is" : `${waiting} tasks are`;
  return (
    <div className="mb-4">
      <Callout
        title="Waiting for a crawl you start"
        action={
          <Link href={crawlsHref} className="text-sm underline">
            Go to crawls
          </Link>
        }
      >
        {tasks} waiting for evidence from a new crawl.{" "}
        {crawlMode === "MANUAL"
          ? "Crawling is manual for this website, so they are checked only when someone starts a crawl."
          : "Automatic crawling is paused while monitoring is paused, so they are checked only when someone starts a crawl."}
      </Callout>
    </div>
  );
}
