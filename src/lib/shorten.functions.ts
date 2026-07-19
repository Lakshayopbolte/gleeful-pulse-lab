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

    const params = new URLSearchParams({
      api: token,
      url: data.url,
      format: "text",
    });
    if (data.alias) params.set("alias", data.alias);

    const apiUrl = `https://arolinks.com/api?${params.toString()}`;
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/plain, application/json, */*",
      },
    });
    const text = (await res.text()).trim();

    // Try to parse a URL out of the response: plain text URL, JSON {shortenedUrl|short|url},
    // or an error string / HTML block.
    let short = "";
    if (/^https?:\/\/\S+$/i.test(text)) {
      short = text;
    } else {
      try {
        const j = JSON.parse(text);
        if (j && j.status === "success" && typeof j.shortenedUrl === "string") {
          short = j.shortenedUrl;
        } else if (j && typeof j.short === "string") {
          short = j.short;
        } else if (j && j.message) {
          throw new Error(String(j.message).slice(0, 200));
        }
      } catch (e) {
        if (e instanceof Error && e.message && !text.startsWith("{")) {
          // fall through to generic error below
        } else if (e instanceof Error) {
          throw e;
        }
      }
    }

    if (!short) {
      const preview = text ? text.slice(0, 180) : `HTTP ${res.status}`;
      throw new Error(`Shortener failed: ${preview}`);
    }
    return { shortUrl: short };
  });