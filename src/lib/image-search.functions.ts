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
    // Run all sources in parallel and merge — much better recall for books.
    const [ddg, bing, gb, ol] = await Promise.all([
      tryDuckDuckGo(data.q),
      tryBing(data.q),
      tryGoogleBooks(data.q),
      tryOpenLibrary(data.q),
    ]);
    // Interleave web results first (DDG + Bing), then book-specific sources.
    const merged: ImageHit[] = [];
    const max = Math.max(ddg.length, bing.length);
    for (let i = 0; i < max; i++) {
      if (ddg[i]) merged.push(ddg[i]);
      if (bing[i]) merged.push(bing[i]);
    }
    merged.push(...gb, ...ol);
    // Dedupe by URL.
    const seen = new Set<string>();
    const results = merged.filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
    return { results: results.slice(0, 120) };
  });

async function tryBing(q: string): Promise<ImageHit[]> {
  try {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    const res = await fetch(
      `https://www.bing.com/images/async?q=${encodeURIComponent(q + " book cover")}&first=0&count=60&mmasync=1`,
      { headers: { "User-Agent": ua, Accept: "text/html" } },
    );
    if (!res.ok) return [];
    const html = await res.text();
    const hits: ImageHit[] = [];
    const re = /<a class="iusc"[^>]*m="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && hits.length < 60) {
      try {
        const meta = JSON.parse(m[1].replace(/&quot;/g, '"'));
        if (meta.murl && meta.turl) {
          hits.push({
            id: `bing-${hits.length}-${meta.murl}`,
            title: (meta.t || meta.desc || "Untitled").replace(/<[^>]+>/g, "").trim(),
            url: meta.murl,
            thumbnail: meta.turl,
            source: meta.purl ?? "",
          });
        }
      } catch {
        // skip
      }
    }
    return hits;
  } catch {
    return [];
  }
}

async function tryDuckDuckGo(q: string): Promise<ImageHit[]> {
  try {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    // Step 1 — fetch the SERP HTML to get the vqd token DDG requires.
    const tokenRes = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`,
      { headers: { "User-Agent": ua, Accept: "text/html" } },
    );
    if (!tokenRes.ok) return [];
    const html = await tokenRes.text();
    const m =
      html.match(/vqd=["']([\d-]+)["']/) ||
      html.match(/vqd=([\d-]+)&/) ||
      html.match(/"vqd":"([\d-]+)"/);
    const vqd = m?.[1];
    if (!vqd) return [];
    // Step 2 — call the JSON image endpoint.
    const params = new URLSearchParams({
      l: "us-en",
      o: "json",
      q,
      vqd,
      f: ",,,,,",
      p: "1",
    });
    const res = await fetch(`https://duckduckgo.com/i.js?${params.toString()}`, {
      headers: {
        "User-Agent": ua,
        Accept: "application/json",
        Referer: "https://duckduckgo.com/",
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      results?: Array<{
        title?: string;
        image?: string;
        thumbnail?: string;
        url?: string;
        source?: string;
      }>;
    };
    return (json.results ?? [])
      .filter((r) => r.image && r.thumbnail)
      .slice(0, 60)
      .map((r, i) => ({
        id: `ddg-${i}-${r.image}`,
        title: (r.title || r.source || "Untitled").trim(),
        url: r.image as string,
        thumbnail: r.thumbnail as string,
        source: r.url ?? "",
      }));
  } catch {
    return [];
  }
}

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