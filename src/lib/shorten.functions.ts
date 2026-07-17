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
    const res = await fetch(apiUrl);
    const text = (await res.text()).trim();

    if (!res.ok || !text) {
      throw new Error(`Shortener failed (${res.status})`);
    }
    // Arolinks returns either a short URL or an error string like "error: ..."
    if (!/^https?:\/\//i.test(text)) {
      throw new Error(text.slice(0, 200));
    }
    return { shortUrl: text };
  });