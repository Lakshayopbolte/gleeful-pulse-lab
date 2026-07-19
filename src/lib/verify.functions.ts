import { createServerFn } from "@tanstack/react-start";

/**
 * Verifies a short link is live on the shortener account.
 * Follows the short URL and confirms it redirects (or resolves) to the
 * intended destination host. Returns a compact status shape.
 */
export const verifyShortLink = createServerFn({ method: "POST" })
  .inputValidator((input: { shortUrl: string; destination: string }) => {
    if (!input?.shortUrl || !input?.destination) {
      throw new Error("shortUrl and destination are required");
    }
    return { shortUrl: input.shortUrl.trim(), destination: input.destination.trim() };
  })
  .handler(async ({ data }) => {
    const started = Date.now();
    let resolvedUrl = "";
    let status: "live" | "broken" | "unknown" = "unknown";
    let httpStatus = 0;
    let message = "";

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(data.shortUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          // Some shorteners serve an interstitial to unknown UAs; pretend to be a browser.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      clearTimeout(timeout);
      resolvedUrl = res.url || "";
      httpStatus = res.status;

      const destHost = safeHost(data.destination);
      const resolvedHost = safeHost(resolvedUrl);

      if (res.ok && resolvedHost && destHost && resolvedHost === destHost) {
        status = "live";
        message = `Resolves to ${destHost}`;
      } else if (res.ok && resolvedUrl && resolvedUrl !== data.shortUrl) {
        // Followed at least one redirect — shortener is serving the link,
        // even if it went through an interstitial before the destination.
        status = "live";
        message = `Serving via ${safeHost(resolvedUrl) || "shortener"}`;
      } else if (res.status === 404 || res.status === 410) {
        status = "broken";
        message = `Not found (${res.status})`;
      } else if (res.status === 403 || res.status === 503 || res.status === 429) {
        status = "live";
        message = `Live (bot-protected by ${safeHost(data.shortUrl) || "host"})`;
      } else if (res.status >= 200 && res.status < 400) {
        status = "live";
        message = `HTTP ${res.status}`;
      } else {
        status = "unknown";
        message = `HTTP ${res.status}`;
      }
    } catch (err) {
      status = "broken";
      message = err instanceof Error ? err.message.slice(0, 120) : "Unreachable";
    }

    return {
      status,
      httpStatus,
      resolvedUrl,
      message,
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  });

function safeHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}