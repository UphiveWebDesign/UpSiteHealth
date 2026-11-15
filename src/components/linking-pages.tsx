import { UrlText } from "@/components/ui/layout";
import { evidenceLinkingPages } from "@/lib/seo/recheck";

/**
 * The pages whose links point at a finding's URL (broken pages and
 * redirects): the pages to edit. At most 20 are stored, with the total.
 * "Linked from N pages" only when the crawl that counted them was complete;
 * otherwise "N crawled pages", with a note that other pages may link too.
 */
export function LinkingPages({ evidence }: { evidence: unknown }) {
  const linking = evidenceLinkingPages(evidence);
  if (linking.urls.length === 0) return null;
  const pages = `page${linking.count === 1 ? "" : "s"}`;
  const complete = linking.coverage === "complete";
  return (
    <details className="mt-1 text-xs text-ink-2">
      <summary className="cursor-pointer text-brand-700 hover:underline">
        {complete
          ? `Linked from ${linking.count} ${pages}`
          : `Linked from ${linking.count} crawled ${pages}`}
        : update the links there
      </summary>
      <ul className="mt-1 space-y-0.5 pl-4">
        {linking.urls.map((u) => (
          <li key={u} className="break-anywhere list-disc">
            <a
              href={u}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-brand-700 hover:underline"
            >
              <UrlText url={u} pathFirst />
            </a>
          </li>
        ))}
      </ul>
      {linking.truncated && (
        <p className="mt-1 text-muted">
          Showing the first {linking.urls.length} of {linking.count} (in URL
          order).
        </p>
      )}
      {linking.coverage === "partial" && (
        <p className="mt-1 text-muted">
          This crawl did not cover the whole site
          {linking.pagesAnalysed !== null
            ? ` (it analysed ${linking.pagesAnalysed} page${linking.pagesAnalysed === 1 ? "" : "s"})`
            : ""}
          : it stopped at the page limit, or some pages failed, so other pages
          may also link here.
        </p>
      )}
      {linking.mayBeIncomplete && (
        <p className="mt-1 text-muted">
          Some pages have more links than the crawler records, so this list may
          miss a page.
        </p>
      )}
    </details>
  );
}
