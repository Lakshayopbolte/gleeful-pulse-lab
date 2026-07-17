import { createServerFn } from "@tanstack/react-start";

export type ImageHit = {
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  source: string;
};

export const searchImages = createServerFn({ method: "POST" })
  .inputValidator((input: { q: string }) => {
    const q = (input?.q ?? "").trim();
    if (!q) throw new Error("Enter something to search");
    if (q.length > 100) throw new Error("Query too long");
    return { q };
  })
  .handler(async ({ data }): Promise<{ results: ImageHit[] }> => {
    // Wikimedia Commons — free, no auth, reliable
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      generator: "search",
      gsrnamespace: "6", // File namespace
      gsrlimit: "30",
      gsrsearch: `${data.q} filetype:bitmap|drawing -fileres:0`,
      prop: "imageinfo",
      iiprop: "url|extmetadata",
      iiurlwidth: "320",
      origin: "*",
    });
    const res = await fetch(
      `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "FREEKITAAB-Workspace/1.0 (image-picker)",
        },
      },
    );
    if (!res.ok) throw new Error(`Image search failed (${res.status})`);
    const json = (await res.json()) as {
      query?: {
        pages?: Array<{
          pageid?: number;
          title?: string;
          imageinfo?: Array<{
            url?: string;
            thumburl?: string;
            descriptionurl?: string;
            extmetadata?: {
              ObjectName?: { value?: string };
              ImageDescription?: { value?: string };
            };
          }>;
        }>;
      };
    };
    const pages = json.query?.pages ?? [];
    const cleanTitle = (raw: string) =>
      raw
        .replace(/^File:/i, "")
        .replace(/\.(jpe?g|png|gif|webp|svg|tiff?)$/i, "")
        .replace(/[_-]+/g, " ")
        .trim();
    const stripHtml = (s: string) =>
      s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

    const results: ImageHit[] = pages
      .map((p) => {
        const info = p.imageinfo?.[0];
        if (!info?.url) return null;
        const descRaw = info.extmetadata?.ImageDescription?.value;
        const objName = info.extmetadata?.ObjectName?.value;
        const nice =
          (objName && stripHtml(objName)) ||
          (descRaw && stripHtml(descRaw)) ||
          cleanTitle(p.title ?? "");
        return {
          id: String(p.pageid ?? info.url),
          title: nice || data.q,
          url: info.url,
          thumbnail: info.thumburl || info.url,
          source: info.descriptionurl ?? "",
        } as ImageHit;
      })
      .filter((x): x is ImageHit => x !== null);
    return { results };
  });