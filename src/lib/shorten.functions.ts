import { createServerFn } from "@tanstack/react-start";

export const shortenUrl = createServerFn({ method: "POST" })
  .inputValidator((input: { url: string; alias?: string }) => {
    if (!input || typeof input.url !== "string" || input.url.trim().length === 0) {
      throw new Error("A destination URL is required");
    }
    let raw = input.url.trim();
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      // eslint-disable-next-line no-new
      new URL(raw);
    } catch {
      throw new Error("Destination must be a valid URL");
    }
    const alias = typeof input.alias === "string" ? input.alias.trim() : "";
    if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias)) {
      throw new Error("Alias must be 3–30 chars, letters/numbers/-/_ only");
    }
    return { url: raw, alias };
  })
  .handler(async ({ data }) => {
    const token = process.env.AROLINKS_API_TOKEN;
    if (!token) throw new Error("Shortener not configured");

    // Always use the JSON response: format=text returns an EMPTY 200 body on
    // errors (e.g. "Alias already exists."), which is unrecoverable to report.
    async function callApi(alias: string) {
      const params = new URLSearchParams({ api: token!, url: data.url });
      if (alias) params.set("alias", alias);
      const res = await fetch(`https://arolinks.com/api?${params.toString()}`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
        },
      });
      const text = (await res.text()).trim();
      if (/^https?:\/\/\S+$/i.test(text)) return { shortUrl: text, error: "" };
      try {
        const j = JSON.parse(text) as {
          status?: string;
          message?: unknown;
          shortenedUrl?: string;
          short?: string;
        };
        const url = j.shortenedUrl || j.short || "";
        if (j.status === "success" && url) return { shortUrl: url, error: "" };
        const msg = Array.isArray(j.message) ? j.message.join(", ") : String(j.message ?? "");
        return { shortUrl: "", error: msg || `HTTP ${res.status}` };
      } catch {
        return { shortUrl: "", error: text.slice(0, 180) || `HTTP ${res.status}` };
      }
    }

    let attempt = await callApi(data.alias);

    // Alias collision → retry with short random suffixes, then with no alias.
    if (!attempt.shortUrl && data.alias && /alias/i.test(attempt.error)) {
      for (let i = 0; i < 3 && !attempt.shortUrl; i++) {
        const suffix = Math.random().toString(36).slice(2, 5);
        attempt = await callApi(`${data.alias.slice(0, 26)}-${suffix}`);
      }
      if (!attempt.shortUrl) attempt = await callApi("");
    }

    if (!attempt.shortUrl) throw new Error(`Shortener failed: ${attempt.error}`);
    return { shortUrl: attempt.shortUrl };
  });