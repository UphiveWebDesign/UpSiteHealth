import { canSeeBusiness } from "@/lib/business/visibility";
import { requireOrgContext } from "@/lib/tenancy/context";
import { NavLink } from "./nav-link";

/**
 * Shared sub-navigation for every website page. Business pages are listed
 * only for members who may see business data (CLIENT members may not).
 */
export async function WebsiteNav({
  orgSlug,
  websiteId,
}: {
  orgSlug: string;
  websiteId: string;
}) {
  // Same request-cached membership the page already loaded.
  const { role } = await requireOrgContext(orgSlug);
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  // Grouped by job: daily work, what was found, how the site is set up.
  // Same links as before; business pages only for members who may see them.
  const groups = [
    [
      { href: base, label: "Overview", exact: true },
      { href: `${base}/growth`, label: "Organic growth" },
      { href: `${base}/recommendations`, label: "Recommendations" },
      { href: `${base}/plan`, label: "SEO plan" },
      { href: `${base}/progress`, label: "Progress" },
      { href: `${base}/report`, label: "Report" },
    ],
    [
      { href: `${base}/seo`, label: "SEO findings" },
      { href: `${base}/monitoring`, label: "Monitoring" },
      { href: `${base}/crawls`, label: "Crawls" },
      { href: `${base}/ai-search`, label: "AI Search" },
    ],
    [
      ...(canSeeBusiness(role)
        ? [
            { href: `${base}/business`, label: "Business" },
            { href: `${base}/coverage`, label: "Coverage" },
          ]
        : []),
      { href: `${base}/integrations`, label: "Integrations" },
      { href: `${base}/settings`, label: "Settings" },
    ],
  ];
  return (
    <nav
      aria-label="Website sections"
      className="-mt-1 mb-6 overflow-x-auto border-b border-line [scrollbar-width:thin] print:hidden"
    >
      <div className="flex min-w-max items-center gap-5">
        {groups.map((items, g) => (
          <div key={g} className="flex items-center gap-5">
            {g > 0 && <span aria-hidden className="h-4 w-px bg-line-strong" />}
            {items.map((i) => (
              <NavLink key={i.href} href={i.href} exact={i.exact}>
                {i.label}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
