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
    const params = new URLSearchParams({
      q: data.q,
      page_size: "24",
    });
    const res = await fetch(
      `https://api.openverse.org/v1/images/?${params.toString()}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Image search failed (${res.status})`);
    const json = (await res.json()) as {
      results?: Array<{
        id?: string;
        title?: string;
        url?: string;
        thumbnail?: string;
        foreign_landing_url?: string;
      }>;
    };
    const results: ImageHit[] = (json.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        id: String(r.id ?? r.url),
        title: (r.title ?? "").trim() || data.q,
        url: r.url as string,
        thumbnail: r.thumbnail || (r.url as string),
        source: r.foreign_landing_url ?? "",
      }));
    return { results };
  });