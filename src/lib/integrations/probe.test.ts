import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type { NetPolicy } from "@/lib/net/ssrf";
import { ProbeDeadlineError, probeIntegrations } from "./probe";

// Every name resolves to the local test server; only loopback is allowed.
const local: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};
const noTxt = async () => [] as string[][];

let server: Server;
let port: number;
let routes: Record<string, (res: import("node:http").ServerResponse) => void>;
const hits: string[] = [];

const send =
  (status: number, body = "", headers: Record<string, string> = {}) =>
  (res: import("node:http").ServerResponse) => {
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(body);
  };

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = `${req.headers.host?.split(":")[0]}${req.url}`;
    hits.push(key);
    (routes[key] ?? send(404))(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  hits.length = 0;
  routes = {};
});

const site = () => ({ url: `http://site.test:${port}/`, domain: "site.test" });
const gtmOrigin = () => `http://gtm.test:${port}`;

describe("public checks", () => {
  test("robots.txt, sitemap, DNS TXT and BingSiteAuth", async () => {
    routes = {
      "site.test/robots.txt": send(
        200,
        `User-agent: *\nDisallow: /private\nSitemap: http://site.test:${port}/sm.xml`,
      ),
      "site.test/sm.xml": send(
        200,
        `<urlset><url><loc>http://site.test:${port}/</loc></url><url><loc>http://site.test:${port}/a</loc></url></urlset>`,
      ),
      "site.test/BingSiteAuth.xml": send(
        200,
        "<users><user>ABC</user></users>",
      ),
    };
    const r = await probeIntegrations(site(), [], {
      policy: local,
      resolveTxt: async () => [
        ["google-site-verification=tok"],
        ["v=spf1 -all"],
      ],
    });
    expect(r.robots).toMatchObject({
      status: "found",
      blocksAll: false,
      sitemaps: [`http://site.test:${port}/sm.xml`],
    });
    expect(r.sitemaps).toMatchObject({ source: "robots", totalUrls: 2 });
    expect(r.sitemaps.sampleUrls).toHaveLength(2);
    expect(r.dnsTxt).toEqual({ status: "ok", googleTokens: 1, error: null });
    expect(r.bing.status).toBe("found");
    expect(r.gtm).toEqual([]);
  });

  test("Disallow: / for everyone is detected; a 503 robots.txt is an error, not 'missing'", async () => {
    routes = {
      "site.test/robots.txt": send(200, "User-agent: *\nDisallow: /"),
    };
    expect(
      (
        await probeIntegrations(site(), [], {
          policy: local,
          resolveTxt: noTxt,
        })
      ).robots.blocksAll,
    ).toBe(true);
    routes = { "site.test/robots.txt": send(503) };
    const r = await probeIntegrations(site(), [], {
      policy: local,
      resolveTxt: noTxt,
    });
    expect(r.robots).toMatchObject({ status: "error", httpStatus: 503 });
    // Default sitemap location is tried when robots.txt lists none.
    expect(r.sitemaps.source).toBe("default");
    expect(r.sitemaps.files[0]).toMatchObject({ httpStatus: 404 });
  });

  test("DNS: no TXT records is an answer; a resolver failure is an error", async () => {
    const enodata = Object.assign(new Error("x"), { code: "ENODATA" });
    const servfail = Object.assign(new Error("x"), { code: "ESERVFAIL" });
    const run = (e: Error) =>
      probeIntegrations(site(), [], {
        policy: local,
        resolveTxt: async () => {
          throw e;
        },
      });
    expect((await run(enodata)).dnsTxt).toEqual({
      status: "ok",
      googleTokens: 0,
      error: null,
    });
    expect((await run(servfail)).dnsTxt).toMatchObject({
      status: "error",
      error: "ESERVFAIL",
    });
  });
});

describe("SSRF protection", () => {
  test("a website on a private address is never requested", async () => {
    const r = await probeIntegrations(
      { url: `http://127.0.0.1:${port}/`, domain: "127.0.0.1" },
      ["GTM-AB12CD"],
      { resolveTxt: noTxt, gtmOrigin: `http://127.0.0.1:${port}` }, // default strict policy
    );
    expect(r.robots).toMatchObject({ status: "error", error: "BLOCKED" });
    expect(r.sitemaps.files[0].error).toBe("BLOCKED");
    expect(r.bing).toMatchObject({ status: "error", error: "BLOCKED" });
    expect(r.gtm[0]).toMatchObject({ status: "error", error: "BLOCKED" });
    expect(hits).toEqual([]);
  });

  test("a redirect to a private address is blocked", async () => {
    routes = {
      "site.test/robots.txt": send(302, "", {
        location: "http://169.254.169.254/latest",
      }),
    };
    const r = await probeIntegrations(site(), [], {
      policy: local,
      resolveTxt: noTxt,
    });
    expect(r.robots).toMatchObject({ status: "error", error: "BLOCKED" });
  });

  test("errors never include response bodies or addresses", async () => {
    routes = {
      "site.test/robots.txt": send(302, "", { location: "http://10.0.0.1/" }),
    };
    const r = await probeIntegrations(site(), [], {
      policy: local,
      resolveTxt: noTxt,
    });
    expect(JSON.stringify(r)).not.toContain("10.0.0.1");
  });
});

describe("GTM availability", () => {
  test("only valid container IDs are requested, only at the GTM host, without redirects", async () => {
    routes = {
      "gtm.test/gtm.js?id=GTM-AB12CD": send(
        200,
        "var x={'vtp_tagId':'G-ZZZ999'};",
        { "content-type": "application/javascript" },
      ),
      "gtm.test/gtm.js?id=GTM-NOPE00": send(404),
      "gtm.test/gtm.js?id=GTM-MOVED1": send(302, "", {
        location: `http://gtm.test:${port}/elsewhere`,
      }),
    };
    const r = await probeIntegrations(
      site(),
      [
        "GTM-AB12CD",
        "GTM-NOPE00",
        "GTM-MOVED1",
        "GTM-../../x",
        "gtm-lower1",
        "G-ABC123",
      ],
      { policy: local, resolveTxt: noTxt, gtmOrigin: gtmOrigin() },
    );
    expect(r.gtm).toEqual([
      {
        id: "GTM-AB12CD",
        status: "available",
        httpStatus: 200,
        error: null,
        ga4Ids: ["G-ZZZ999"],
      },
      {
        id: "GTM-NOPE00",
        status: "not-found",
        httpStatus: 404,
        error: null,
        ga4Ids: [],
      },
      {
        id: "GTM-MOVED1",
        status: "error",
        httpStatus: null,
        error: "TOO_MANY_REDIRECTS",
        ga4Ids: [],
      },
    ]);
    const gtmHits = hits.filter((h) => h.startsWith("gtm.test"));
    expect(gtmHits).toEqual([
      "gtm.test/gtm.js?id=GTM-AB12CD",
      "gtm.test/gtm.js?id=GTM-NOPE00",
      "gtm.test/gtm.js?id=GTM-MOVED1",
    ]);
  });

  test("a 200 that is not JavaScript (e.g. a sign-in page) is indeterminate, not published", async () => {
    routes = {
      "gtm.test/gtm.js?id=GTM-HTML01": send(200, "<html>sign in</html>", {
        "content-type": "text/html",
      }),
    };
    const r = await probeIntegrations(site(), ["GTM-HTML01"], {
      policy: local,
      resolveTxt: noTxt,
      gtmOrigin: gtmOrigin(),
    });
    expect(r.gtm).toEqual([
      {
        id: "GTM-HTML01",
        status: "error",
        httpStatus: 200,
        error: "UNEXPECTED_RESPONSE",
        ga4Ids: [],
      },
    ]);
  });

  test("at most three containers are checked", async () => {
    const r = await probeIntegrations(
      site(),
      ["GTM-AAAA01", "GTM-AAAA02", "GTM-AAAA03", "GTM-AAAA04"],
      { policy: local, resolveTxt: noTxt, gtmOrigin: gtmOrigin() },
    );
    expect(r.gtm).toHaveLength(3);
  });
});

test("a passed deadline stops the probe instead of recording failures", async () => {
  await expect(
    probeIntegrations(site(), [], {
      policy: local,
      resolveTxt: noTxt,
      deadline: Date.now() - 1,
    }),
  ).rejects.toBeInstanceOf(ProbeDeadlineError);
});
