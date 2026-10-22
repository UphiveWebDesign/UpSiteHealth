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
  const items = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/monitoring`, label: "Monitoring" },
    { href: `${base}/seo`, label: "SEO findings" },
    ...(canSeeBusiness(role)
      ? [
          { href: `${base}/business`, label: "Business" },
          { href: `${base}/coverage`, label: "Coverage" },
        ]
      : []),
    { href: `${base}/plan`, label: "SEO plan" },
    { href: `${base}/progress`, label: "Progress" },
    { href: `${base}/report`, label: "Report" },
    { href: `${base}/recommendations`, label: "Recommendations" },
    { href: `${base}/crawls`, label: "Crawls" },
    { href: `${base}/integrations`, label: "Integrations" },
    { href: `${base}/ai-search`, label: "AI Search" },
    { href: `${base}/settings`, label: "Settings" },
  ];
  return (
    <nav
      aria-label="Website sections"
      className="-mt-2 mb-6 overflow-x-auto border-b border-line print:hidden"
    >
      <div className="flex min-w-max gap-5">
        {items.map((i) => (
          <NavLink key={i.href} href={i.href} exact={i.exact}>
            {i.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
