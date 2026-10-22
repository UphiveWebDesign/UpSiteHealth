import { describe, expect, test } from "vitest";
import { parsePage } from "./html";

const URL = "https://site.example/cottages/";
const words = (n: number, w = "lorem") =>
  Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const CHROME = `
  <header><a href="/">Home</a><a href="/cottages/">Cottages</a> ${words(80, "head")}</header>
  <nav>${words(120, "nav")}</nav>
  <div class="cookie-notice">We use cookies. ${words(60, "cookie")}</div>
  <footer>${words(150, "foot")} Cottages near Kasol</footer>`;

describe("main content (page opportunities, not technical checks)", () => {
  test("a matching title with an empty main area: no main-content words", () => {
    const p = parsePage(
      `<html><head><title>Cottages</title></head><body>${CHROME}<main><h1>Cottages</h1></main></body></html>`,
      URL,
    );
    expect(p.result.content.source).toBe("main");
    expect(p.result.content.words).toBe(1); // just the heading
    // The page-wide count technical findings use is unchanged (chrome counts).
    expect(p.wordCount).toBeGreaterThan(400);
  });

  test("a real page: its own words, and blocks that mention the offering", () => {
    const p = parsePage(
      `<html><body>${CHROME}<main><h1>Our cottages</h1><p>Each of our cottages ${words(250)}</p></main></body></html>`,
      URL,
    );
    expect(p.result.content.words).toBeGreaterThanOrEqual(250);
    expect(p.result.content.blocks.some((b) => /cottages/.test(b.t))).toBe(
      true,
    );
    expect(p.result.content.blocks.every((b) => b.t.length <= 200)).toBe(true);
  });

  test("without <main>: one article, else the body without chrome", () => {
    const article = parsePage(
      `<html><body>${CHROME}<article><p>${words(30)}</p></article></body></html>`,
      URL,
    );
    expect(article.result.content).toMatchObject({
      source: "article",
      words: 30,
    });
    const body = parsePage(
      `<html><body>${CHROME}<div id="sidebar">${words(50, "side")}</div><section><p>${words(40)}</p></section><div class="food-menu">Momos and chai</div></body></html>`,
      URL,
    );
    expect(body.result.content.source).toBe("body");
    // Chrome and sidebars removed; a food menu (bare "menu") is content.
    expect(body.result.content.words).toBe(43); // 40 + "Momos and chai"
  });
});

describe("contact signals", () => {
  const contact = (html: string) =>
    parsePage(`<html><body>${html}</body></html>`, URL).result.contact;
  test("phone, email and WhatsApp links are counted, never crawled", () => {
    const p = parsePage(
      `<html><body><a href="tel:+919876543210">Call</a><a href="MAILTO:stay@site.example">Email</a><a href="https://wa.me/919876543210">WhatsApp</a><a href="https://api.whatsapp.com/send?phone=91">Chat</a><a href="whatsapp://send?phone=91">App</a></body></html>`,
      URL,
    );
    expect(p.result.contact).toEqual({
      tel: 1,
      mailto: 1,
      whatsapp: 3,
      forms: 0,
    });
    // tel: and mailto: are not links to crawl (wa.me is an external link).
    expect(
      p.result.links.map((l) => l.url).some((u) => /^(tel|mailto):/i.test(u)),
    ).toBe(false);
    expect(p.result.links.every((l) => l.type === "external")).toBe(true);
  });
  test("contact forms count; search forms and forms without contact fields do not", () => {
    expect(
      contact(`<form><input type="email" name="e"><textarea></textarea></form>`)
        .forms,
    ).toBe(1);
    expect(contact(`<form><input name="phone_number"></form>`).forms).toBe(1);
    expect(
      contact(`<form role="search"><input type="email"></form>`).forms,
    ).toBe(0);
    expect(contact(`<form><input type="search" name="q"></form>`).forms).toBe(
      0,
    );
  });
  test("a page with no contact signals", () => {
    expect(contact(`<p>Hello</p><a href="/about">About</a>`)).toEqual({
      tel: 0,
      mailto: 0,
      whatsapp: 0,
      forms: 0,
    });
  });
});
