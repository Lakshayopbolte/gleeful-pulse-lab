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
    // Google Books first — great covers, real titles, no key required.
    const gb = await tryGoogleBooks(data.q);
    if (gb.length > 0) return { results: gb };
    // Open Library fallback — no rate limit, no key.
    const ol = await tryOpenLibrary(data.q);
    return { results: ol };
  });

async function tryGoogleBooks(q: string): Promise<ImageHit[]> {
  try {
    const params = new URLSearchParams({
      q,
      maxResults: "30",
      printType: "books",
      projection: "lite",
    });
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?${params.toString()}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      items?: Array<{
        id?: string;
        volumeInfo?: {
          title?: string;
          subtitle?: string;
          authors?: string[];
          infoLink?: string;
          imageLinks?: {
            smallThumbnail?: string;
            thumbnail?: string;
            small?: string;
            medium?: string;
            large?: string;
            extraLarge?: string;
          };
        };
      }>;
    };
    const items = json.items ?? [];
    return items
      .map((it) => {
        const v = it.volumeInfo;
        const links = v?.imageLinks;
        const big =
          links?.extraLarge ||
          links?.large ||
          links?.medium ||
          links?.small ||
          links?.thumbnail ||
          links?.smallThumbnail;
        if (!v?.title || !big) return null;
        // Google returns http and edge=curl noise; normalize + upsize a bit.
        const url = big.replace(/^http:/, "https:").replace(/&edge=curl/, "");
        const thumb = (links?.thumbnail || links?.smallThumbnail || url)
          .replace(/^http:/, "https:")
          .replace(/&edge=curl/, "");
        const fullTitle = v.subtitle ? `${v.title}: ${v.subtitle}` : v.title;
        return {
          id: String(it.id ?? url),
          title: fullTitle,
          url,
          thumbnail: thumb,
          source: v.infoLink ?? "",
        } as ImageHit;
      })
      .filter((x): x is ImageHit => x !== null);
  } catch {
    return [];
  }
}

async function tryOpenLibrary(q: string): Promise<ImageHit[]> {
  try {
    const params = new URLSearchParams({
      q,
      limit: "30",
      fields: "key,title,subtitle,author_name,cover_i",
    });
    const res = await fetch(
      `https://openlibrary.org/search.json?${params.toString()}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      docs?: Array<{
        key?: string;
        title?: string;
        subtitle?: string;
        author_name?: string[];
        cover_i?: number;
      }>;
    };
    return (json.docs ?? [])
      .filter((d) => d.cover_i && d.title)
      .map((d) => {
        const cover = d.cover_i as number;
        const fullTitle = d.subtitle ? `${d.title}: ${d.subtitle}` : (d.title as string);
        return {
          id: String(d.key ?? cover),
          title: fullTitle,
          url: `https://covers.openlibrary.org/b/id/${cover}-L.jpg`,
          thumbnail: `https://covers.openlibrary.org/b/id/${cover}-M.jpg`,
          source: d.key ? `https://openlibrary.org${d.key}` : "",
        } as ImageHit;
      });
  } catch {
    return [];
  }
}