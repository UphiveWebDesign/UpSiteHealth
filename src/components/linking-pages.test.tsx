// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LinkingPages } from "./linking-pages";

afterEach(cleanup);

const SITE = "https://site.example";
const urls = (n: number) =>
  Array.from({ length: n }, (_, i) => `${SITE}/p${i}`);
const text = (evidence: unknown) =>
  render(<LinkingPages evidence={evidence} />).container.textContent ?? "";

describe("LinkingPages wording", () => {
  test("complete crawl: linked from N pages, no coverage note", () => {
    const t = text({
      linkingPages: urls(2),
      linkingPageCount: 2,
      linkingCoverage: "complete",
      pagesAnalysed: 40,
    });
    expect(t).toContain("Linked from 2 pages: update the links there");
    expect(t).not.toMatch(/crawled page|did not cover/);
  });

  test("partial crawl: N crawled pages, with how many pages were analysed", () => {
    const t = text({
      linkingPages: urls(1),
      linkingPageCount: 1,
      linkingCoverage: "partial",
      pagesAnalysed: 100,
    });
    expect(t).toContain("Linked from 1 crawled page: update the links there");
    expect(t).toContain(
      "This crawl did not cover the whole site (it analysed 100 pages)",
    );
    expect(t).toMatch(/other pages may also link here/);
  });

  test("more than 20: the first 20 listed, the total named", () => {
    const { container } = render(
      <LinkingPages
        evidence={{
          linkingPages: urls(20),
          linkingPageCount: 35,
          linkingPagesTruncated: true,
          linkingCoverage: "complete",
          pagesAnalysed: 90,
        }}
      />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(20);
    expect(container.textContent).toContain("Linked from 35 pages");
    expect(container.textContent).toContain("Showing the first 20 of 35");
  });

  test("evidence recorded before coverage was stored never claims the whole site", () => {
    const t = text({ linkingPages: urls(3), linkingPageCount: 3 });
    expect(t).toContain("Linked from 3 crawled pages");
    expect(t).not.toMatch(/did not cover/);
  });

  test("nothing to show without linking pages", () => {
    expect(text({ linkedFrom: `${SITE}/a` })).toBe("");
  });
});
