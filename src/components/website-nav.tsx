import { NavLink } from "./nav-link";

/** Shared sub-navigation for every website page. */
export function WebsiteNav({
  orgSlug,
  websiteId,
}: {
  orgSlug: string;
  websiteId: string;
}) {
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const items = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/monitoring`, label: "Monitoring" },
    { href: `${base}/seo`, label: "SEO findings" },
    { href: `${base}/plan`, label: "SEO plan" },
    { href: `${base}/progress`, label: "Progress" },
    { href: `${base}/recommendations`, label: "Recommendations" },
    { href: `${base}/crawls`, label: "Crawls" },
    { href: `${base}/integrations`, label: "Integrations" },
    { href: `${base}/ai-search`, label: "AI Search" },
    { href: `${base}/settings`, label: "Settings" },
  ];
  return (
    <nav
      aria-label="Website sections"
      className="-mt-2 mb-6 overflow-x-auto border-b border-line"
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
