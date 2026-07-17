import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence, Reorder, useDragControls } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import { shortenUrl } from "@/lib/shorten.functions";
import { searchImages, type ImageHit } from "@/lib/image-search.functions";

export const Route = createFileRoute("/")({
  component: Workspace,
});

type Entry = {
  id: string;
  title: string;
  alias: string;
  destination: string;
  image: string;
  shortUrl: string;
  createdAt: number;
};

const STORAGE_KEY = "freekitaab.entries.v1";

const STOP_WORDS = new Set([
  "the","a","an","of","and","or","for","to","in","on","at","by","with","from",
  "is","are","be","this","that","my","your","our","new","how","what","why",
]);

function makeShortAlias(title: string): string {
  const cleaned = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (cleaned.length === 0) return "";
  const meaningful = cleaned.filter((w) => !STOP_WORDS.has(w));
  const words = (meaningful.length ? meaningful : cleaned).slice(0, 2);
  const joined = words.join("-").slice(0, 12).replace(/-+$/,"");
  return joined;
}

function loadEntries(): Entry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEntries(entries: Entry[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function Workspace() {
  const shorten = useServerFn(shortenUrl);
  const runImageSearch = useServerFn(searchImages);

  const [title, setTitle] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasTouched, setAliasTouched] = useState(false);
  const [destination, setDestination] = useState("");
  const [image, setImage] = useState("");
  const [shortUrl, setShortUrl] = useState("");
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "shortening" }
    | { kind: "saving" }
    | { kind: "error"; message: string }
    | { kind: "success"; message: string }
  >({ kind: "idle" });

  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copyFormat, setCopyFormat] = useState<"json" | "csv" | "markdown" | "text" | "html">("json");
  const [flash, setFlash] = useState<string | null>(null);

  const [imgQuery, setImgQuery] = useState("");
  const [imgResults, setImgResults] = useState<ImageHit[]>([]);
  const [imgSearching, setImgSearching] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const [imgPanelOpen, setImgPanelOpen] = useState(false);
  const [qrOpenFor, setQrOpenFor] = useState<string | null>(null);
  const [density, setDensity] = useState<"grid" | "list">("grid");

  // Keyboard shortcuts: ⌘/Ctrl+K → focus search, ⌘/Ctrl+Enter → save, Esc → close panels
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        const el = document.getElementById("vault-search") as HTMLInputElement | null;
        el?.focus();
        el?.select();
      } else if (meta && ev.key === "Enter") {
        ev.preventDefault();
        const btn = document.getElementById("save-btn") as HTMLButtonElement | null;
        btn?.click();
      } else if (ev.key === "Escape") {
        setImgPanelOpen(false);
        setQrOpenFor(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function faviconFor(url: string) {
    try {
      const u = new URL(url);
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
    } catch {
      return "";
    }
  }

  function hostOf(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  async function handleImageSearch() {
    const q = (imgQuery.trim() || title.trim());
    if (!q) {
      setImgError("Type something or fill the title first");
      return;
    }
    setImgError(null);
    setImgSearching(true);
    setImgPanelOpen(true);
    try {
      const res = await runImageSearch({ data: { q } });
      setImgResults(res.results);
      if (res.results.length === 0) setImgError("No images found");
    } catch (err) {
      setImgError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setImgSearching(false);
    }
  }

  function pickImage(hit: ImageHit) {
    setImage(hit.url);
    if (!title.trim()) setTitle(hit.title);
    setImgPanelOpen(false);
    setFlash("Image linked");
    window.setTimeout(() => setFlash((f) => (f === "Image linked" ? null : f)), 1400);
  }

  useEffect(() => {
    setEntries(loadEntries());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveEntries(entries);
  }, [entries, hydrated]);

  // Auto-derive alias from title until the user edits alias manually
  useEffect(() => {
    if (aliasTouched) return;
    setAlias(makeShortAlias(title));
  }, [title, aliasTouched]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.title, e.alias, e.destination, e.shortUrl]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [entries, query]);

  const selectedEntries = useMemo(
    () => filtered.filter((e) => selected.has(e.id)),
    [filtered, selected],
  );
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((e) => selected.has(e.id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((e) => e.id)));
    }
  }
  function clearSelection() {
    setSelected(new Set());
  }

  function formatEntries(list: Entry[], fmt: typeof copyFormat): string {
    if (list.length === 0) return "";
    if (fmt === "json") return JSON.stringify(list, null, 2);
    if (fmt === "csv") {
      const esc = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
      const head = ["title", "alias", "image", "destination", "shortUrl"].join(",");
      const rows = list.map((e) =>
        [e.title, e.alias, e.image, e.destination, e.shortUrl].map(esc).join(","),
      );
      return [head, ...rows].join("\n");
    }
    if (fmt === "markdown") {
      const head = "| Title | Alias | Short | Destination | Image |\n|---|---|---|---|---|";
      const rows = list.map(
        (e) =>
          `| ${e.title} | \`${e.alias}\` | ${e.shortUrl} | ${e.destination} | ${e.image} |`,
      );
      return [head, ...rows].join("\n");
    }
    if (fmt === "html") {
      return list
        .map(
          (e) =>
            `<a href="${e.shortUrl}" data-alias="${e.alias}" data-image="${e.image}" data-destination="${e.destination}">${e.title}</a>`,
        )
        .join("\n");
    }
    // text
    return list
      .map(
        (e) =>
          `Title: ${e.title}\nAlias: ${e.alias}\nImage: ${e.image}\nDestination: ${e.destination}\nShort: ${e.shortUrl}`,
      )
      .join("\n\n---\n\n");
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ kind: "success", message: `${label} copied` });
      setFlash(label);
      window.setTimeout(() => setFlash((f) => (f === label ? null : f)), 1400);
    } catch {
      setStatus({ kind: "error", message: "Clipboard blocked" });
    }
  }

  function copyOne(e: Entry) {
    copyText(formatEntries([e], copyFormat), `Entry · ${copyFormat.toUpperCase()}`);
  }
  function copySelected() {
    const list = selectedEntries.length ? selectedEntries : filtered;
    if (list.length === 0) return;
    copyText(formatEntries(list, copyFormat), `${list.length} × ${copyFormat.toUpperCase()}`);
  }

  function resetForm() {
    setTitle("");
    setAlias("");
    setAliasTouched(false);
    setDestination("");
    setImage("");
    setShortUrl("");
  }

  function normalizeUrl(u: string) {
    const v = u.trim();
    if (!v) return "";
    return /^https?:\/\//i.test(v) ? v : `https://${v}`;
  }

  async function handleShorten() {
    const dest = normalizeUrl(destination);
    if (!dest) {
      setStatus({ kind: "error", message: "Enter a destination link first" });
      return;
    }
    setStatus({ kind: "shortening" });
    try {
      const res = await shorten({ data: { url: dest, alias: alias.trim() } });
      setDestination(dest);
      setShortUrl(res.shortUrl);
      setStatus({ kind: "success", message: "Short link generated" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to shorten",
      });
    }
  }

  async function handleSave() {
    const dest = normalizeUrl(destination);
    if (!title.trim() || !dest) {
      setStatus({ kind: "error", message: "Title and destination are required" });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      // Always mint a fresh short link on save so the record is guaranteed complete
      const res = await shorten({ data: { url: dest, alias: alias.trim() } });
      const finalShort = res.shortUrl;
      setShortUrl(finalShort);
      const entry: Entry = {
        id: crypto.randomUUID(),
        title: title.trim(),
        alias: alias.trim(),
        destination: dest,
        image: image.trim(),
        shortUrl: finalShort,
        createdAt: Date.now(),
      };
      setEntries((prev) => [entry, ...prev]);
      resetForm();
      setStatus({ kind: "success", message: "Saved to workspace" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save",
      });
    }
  }

  function deleteEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function copy(text: string) {
    copyText(text, "Value");
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `freekitaab-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const busy = status.kind === "shortening" || status.kind === "saving";

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-border/70 glass-panel sticky top-0 z-20">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-[image:var(--gradient-hero)] text-primary-foreground shadow-[var(--shadow-glow)]">
              <span className="font-display text-xl font-bold">F</span>
              <span className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-accent ring-2 ring-background pulse-dot" />
            </div>
            <div className="leading-tight">
              <div className="font-display text-lg font-bold tracking-tight">
                FREEKITAAB
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                Link Workspace
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              {entries.length} saved
            </span>
            <button
              onClick={exportJson}
              disabled={entries.length === 0}
              className="rounded-full border border-border bg-secondary/60 px-4 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/60 hover:text-primary hover:-translate-y-px disabled:opacity-40 disabled:hover:translate-y-0"
            >
              Export JSON
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        {/* Hero */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="mb-12 grid gap-6 md:grid-cols-[1.4fr_1fr] md:items-end"
        >
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary pulse-dot" /> arolinks · live
            </div>
            <h1 className="text-5xl font-bold leading-[1.02] tracking-tight md:text-7xl">
              Shorten. Tag.{" "}
              <span className="text-gradient italic">Vault.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
              Paste a destination, mint a short link, attach title & artwork,
              and pipe the whole record into your next project.
            </p>
          </div>
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.15, ease: "easeOut" }}
            className="relative overflow-hidden rounded-2xl border border-border glass-panel p-5 shadow-[var(--shadow-card)]"
          >
            <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-[image:var(--gradient-hero)] opacity-20 blur-3xl" />
            <div className="flex items-center justify-between">
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                Endpoint
              </div>
              <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-primary">
                200 · OK
              </span>
            </div>
            <div className="mt-2 font-mono text-sm text-foreground">
              <span className="text-muted-foreground">GET </span>arolinks.com/api
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <Stat label="Entries" value={entries.length} />
              <Stat label="Aliased" value={entries.filter((e) => e.alias).length} />
              <Stat
                label="With art"
                value={entries.filter((e) => e.image).length}
              />
            </div>
          </motion.div>
        </motion.section>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Composer */}
          <section className="composer-card relative overflow-hidden rounded-xl border-2 border-amber-900/40 bg-[#141210] shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            <div className="flex items-center justify-between border-b border-amber-900/20 px-6 pt-6 pb-4 sm:px-8 sm:pt-8 sm:pb-6">
              <h2 className="font-display text-2xl font-extrabold tracking-tight text-amber-50 sm:text-3xl">
                New link
              </h2>
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-600/60">
                01 · Compose
              </span>
            </div>

            <div className="space-y-6 p-6 sm:p-8">
              <Field label="Title" required>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex. Physics Class 12 — Chapter 3 Notes"
                  className="input"
                />
              </Field>

              <div className="grid grid-cols-12 gap-4">
                <div className="col-span-12 sm:col-span-5">
                <Field label="Alias" hint="a-z 0-9 _ -">
                  <input
                    value={alias}
                    onChange={(e) => {
                      setAliasTouched(true);
                      setAlias(e.target.value);
                    }}
                    placeholder="phy-ch3"
                    className="input font-mono"
                  />
                </Field>
                </div>
                <div className="col-span-12 sm:col-span-7">
                <Field label="Image link">
                  <div className="flex gap-2">
                    <input
                      value={image}
                      onChange={(e) => setImage(e.target.value)}
                      placeholder="https://…/cover.jpg"
                      className="input flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setImgPanelOpen((v) => !v)}
                      className="btn-ghost-amber flex aspect-square items-center justify-center"
                      title="Search images"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    </button>
                  </div>
                </Field>
                </div>
              </div>

              {imgPanelOpen && (
                <div className="rounded-xl border border-border bg-background/40 p-3">
                  <div className="mb-2 flex gap-2">
                    <input
                      value={imgQuery}
                      onChange={(e) => setImgQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleImageSearch();
                        }
                      }}
                      placeholder={title ? `Search images (default: “${title}”)` : "Search images…"}
                      className="input flex-1"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleImageSearch}
                      disabled={imgSearching}
                      className="rounded-md bg-[image:var(--gradient-hero)] px-4 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-glow)] transition hover:brightness-110 disabled:opacity-40"
                    >
                      {imgSearching ? "…" : "Search"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setImgPanelOpen(false)}
                      className="rounded-md border border-border px-3 text-xs text-muted-foreground hover:text-foreground"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                    Click any tile to grab its image link {title || imgQuery ? "& title" : ""}
                  </div>
                  {imgError && (
                    <p className="mb-2 text-xs text-destructive-foreground">{imgError}</p>
                  )}
                  {imgSearching ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {Array.from({ length: 9 }).map((_, i) => (
                        <div
                          key={i}
                          className="aspect-[4/5] animate-pulse rounded-lg border border-border bg-secondary/60"
                        />
                      ))}
                    </div>
                  ) : imgResults.length > 0 ? (
                    <div className="grid max-h-[32rem] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
                      {imgResults.map((hit) => (
                        <button
                          key={hit.id}
                          type="button"
                          onClick={() => pickImage(hit)}
                          title={hit.title}
                          className="group flex flex-col overflow-hidden rounded-lg border border-border bg-secondary text-left transition hover:border-primary hover:shadow-[var(--shadow-glow)]"
                        >
                          <div className="relative aspect-[4/5] w-full overflow-hidden bg-background">
                            <img
                              src={hit.thumbnail}
                              alt={hit.title}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-cover transition group-hover:scale-105"
                              onError={(ev) => {
                                (ev.currentTarget as HTMLImageElement).style.visibility = "hidden";
                              }}
                            />
                          </div>
                          <div className="border-t border-border/60 px-2 py-1.5 text-[11px] leading-snug text-foreground line-clamp-2 min-h-[2.4rem]">
                            {hit.title}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    !imgError && (
                      <p className="py-6 text-center text-xs text-muted-foreground">
                        Type a query and hit Search — results come from across the web.
                      </p>
                    )
                  )}
                </div>
              )}

              <Field label="Destination link" required>
                <div className="flex gap-2">
                  <input
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="https://example.com/long/path"
                    className="input flex-1"
                  />
                  <button
                    onClick={handleShorten}
                    disabled={busy || !destination.trim()}
                    className="btn-ghost-amber whitespace-nowrap px-5 font-mono text-sm font-bold uppercase tracking-wider disabled:opacity-40"
                  >
                    {status.kind === "shortening" ? "…" : "Shorten"}
                  </button>
                </div>
              </Field>

              {shortUrl && (
                <div className="rounded-lg border border-primary/40 bg-primary/10 p-3">
                  <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-primary">
                    Short URL
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <a
                      href={shortUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-mono text-sm text-foreground hover:underline"
                    >
                      {shortUrl}
                    </a>
                    <button
                      onClick={() => copy(shortUrl)}
                      className="rounded border border-border/60 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}

              {status.kind === "error" && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                  {status.message}
                </p>
              )}
              {status.kind === "success" && (
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
                  ✓ {status.message}
                </p>
              )}

              <div className="flex items-center justify-between pt-4">
                <button
                  onClick={resetForm}
                  className="font-mono text-[11px] font-bold uppercase tracking-widest text-stone-500 transition-colors hover:text-red-400"
                >
                  Clear
                </button>
                <button
                  onClick={handleSave}
                  id="save-btn"
                  disabled={busy || !title.trim() || !destination.trim()}
                  className="group relative flex items-center gap-3 rounded-lg bg-amber-500 px-6 py-3.5 font-display font-bold text-black shadow-[0_4px_0_0_#92400e] transition-all hover:bg-amber-400 active:translate-y-1 active:shadow-none disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-[0_4px_0_0_#92400e]"
                >
                  {status.kind === "saving" ? (
                    <span className="text-base">Shortening & saving…</span>
                  ) : (
                    <>
                      <span className="text-base sm:text-lg">Shorten &amp; save</span>
                      <kbd className="flex items-center gap-1 rounded border border-black/10 bg-black/10 px-2 py-1 font-mono text-[10px] font-bold">
                        <span>⌘</span>
                        <span>↵</span>
                      </kbd>
                    </>
                  )}
                </button>
              </div>
            </div>
          </section>

          {/* Vault */}
          <section className="rounded-2xl border border-border glass-panel p-6 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">
                  Vault
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    · {filtered.length}
                    {selected.size > 0 && (
                      <span className="ml-1 text-primary">/ {selected.size} picked</span>
                    )}
                  </span>
                </h2>
                <p className="text-xs text-muted-foreground">
                  Select rows → pick a format → copy the whole payload
                </p>
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                id="vault-search"
                placeholder="Search…  ⌘K"
                className="input h-9 w-48 text-sm"
              />
            </div>

            {/* Bulk toolbar */}
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-background/40 p-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  disabled={filtered.length === 0}
                  className="accent-primary"
                />
                <span className="font-mono uppercase tracking-widest">
                  {allVisibleSelected ? "Unselect all" : "Select all"}
                </span>
              </label>
              <div className="mx-1 h-5 w-px bg-border" />
              <div className="flex items-center gap-1 rounded-md border border-border bg-secondary/40 p-0.5">
                {(["json", "csv", "markdown", "text", "html"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setCopyFormat(f)}
                    className={`rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
                      copyFormat === f
                        ? "bg-primary text-primary-foreground shadow-[var(--shadow-glow)]"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <button
                onClick={copySelected}
                disabled={filtered.length === 0}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-[image:var(--gradient-hero)] px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-[var(--shadow-glow)] transition hover:brightness-110 disabled:opacity-40"
              >
                <span aria-hidden>⧉</span>
                Copy {selected.size > 0 ? `${selected.size}` : "all"} as {copyFormat.toUpperCase()}
              </button>
              <div className="flex items-center gap-0.5 rounded-md border border-border bg-secondary/40 p-0.5">
                {(["grid", "list"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDensity(d)}
                    title={`${d} view`}
                    className={`rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
                      density === d
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {d === "grid" ? "▦" : "≡"}
                  </button>
                ))}
              </div>
              {selected.size > 0 && (
                <button
                  onClick={clearSelection}
                  className="text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>

            <AnimatePresence>
              {flash && (
                <motion.div
                  key={flash}
                  initial={{ opacity: 0, y: -6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.98 }}
                  transition={{ duration: 0.18 }}
                  className="mb-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-primary"
                >
                  ✓ {flash} copied to clipboard
                </motion.div>
              )}
            </AnimatePresence>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-16 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-secondary/50 font-mono text-lg text-muted-foreground">
                  ∅
                </div>
                <p className="text-sm text-muted-foreground">
                  {entries.length === 0
                    ? "No links saved yet — start with your first short."
                    : "No matches for that search."}
                </p>
              </div>
            ) : (
              <Reorder.Group
                axis="y"
                values={entries}
                onReorder={setEntries}
                className={
                  density === "grid"
                    ? "grid gap-3 sm:grid-cols-2"
                    : "space-y-2"
                }
              >
                <AnimatePresence initial={false}>
                  {filtered.map((e) => (
                    <VaultCard
                      key={e.id}
                      entry={e}
                      density={density}
                      selected={selected.has(e.id)}
                      onToggle={() => toggleSelect(e.id)}
                      onCopyAll={() => copyOne(e)}
                      onCopyField={(v) => copy(v)}
                      onDelete={() => deleteEntry(e.id)}
                      qrOpen={qrOpenFor === e.id}
                      onToggleQr={() =>
                        setQrOpenFor((cur) => (cur === e.id ? null : e.id))
                      }
                      hostOf={hostOf}
                      faviconFor={faviconFor}
                    />
                  ))}
                </AnimatePresence>
              </Reorder.Group>
            )}
          </section>
        </div>

        <footer className="mt-16 flex flex-col items-center justify-between gap-2 border-t border-border/60 pt-6 font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground sm:flex-row">
          <span>FREEKITAAB · workspace</span>
          <span>powered by arolinks</span>
        </footer>
      </main>

      <style>{`
        .input {
          width: 100%;
          height: 3rem;
          border-radius: 0.5rem;
          border: 2px solid rgb(120 53 15 / 0.3);
          background: #1c1917;
          padding: 0 1rem;
          color: rgb(254 243 199);
          font-size: 0.9rem;
          outline: none;
          transition: border-color 0.15s;
        }
        .input:focus {
          border-color: rgb(245 158 11 / 0.55);
        }
        .input::placeholder {
          color: rgb(120 113 108);
        }
        .btn-ghost-amber {
          border-radius: 0.5rem;
          border: 2px solid rgb(120 53 15 / 0.3);
          background: #292524;
          color: rgb(253 230 138);
          height: 3rem;
          transition: background 0.15s, transform 0.05s;
        }
        .btn-ghost-amber:hover { background: #3d3835; }
        .btn-ghost-amber:active { transform: translateY(2px); }
        .composer-card { position: relative; }
        .composer-card::before {
          content: "";
          position: absolute; inset: 0;
          pointer-events: none;
          background-image: radial-gradient(rgb(120 53 15 / 0.08) 1px, transparent 1px);
          background-size: 18px 18px;
          mask-image: linear-gradient(to bottom, black, transparent 70%);
        }
      `}</style>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          {label}
          {required && <span className="ml-1 text-primary">*</span>}
        </span>
        {hint && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {hint}
          </span>
        )}
      </div>
      {children}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 py-2">
      <div className="font-display text-xl font-semibold text-foreground">
        {value}
      </div>
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function VaultCard({
  entry,
  density,
  selected,
  onToggle,
  onCopyAll,
  onCopyField,
  onDelete,
  qrOpen,
  onToggleQr,
  hostOf,
  faviconFor,
}: {
  entry: Entry;
  density: "grid" | "list";
  selected: boolean;
  onToggle: () => void;
  onCopyAll: () => void;
  onCopyField: (v: string) => void;
  onDelete: () => void;
  qrOpen: boolean;
  onToggleQr: () => void;
  hostOf: (u: string) => string;
  faviconFor: (u: string) => string;
}) {
  const controls = useDragControls();
  const isList = density === "list";

  return (
    <Reorder.Item
      value={entry}
      dragListener={false}
      dragControls={controls}
      layout
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20, scale: 0.96 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      whileDrag={{ scale: 1.02, zIndex: 30 }}
      className={`group relative overflow-hidden rounded-xl border backdrop-blur transition ${
        selected
          ? "border-primary/70 bg-primary/10 shadow-[0_0_0_1px_var(--color-primary)]"
          : "border-border bg-background/60 hover:border-primary/40 hover:shadow-[0_10px_40px_-20px_var(--color-primary)]"
      }`}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-0 transition group-hover:opacity-100"
        style={{ background: "var(--gradient-hero)" }}
      />

      {/* Cover */}
      {!isList && (
        <div className="relative h-32 w-full overflow-hidden border-b border-border/60 bg-secondary">
          {entry.image ? (
            <img
              src={entry.image}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
              onError={(ev) => {
                (ev.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div
              className="h-full w-full"
              style={{ background: "var(--gradient-mesh)" }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/10 to-transparent" />
          <div className="absolute left-2 top-2 flex items-center gap-1.5">
            <label
              className="cursor-pointer rounded-md border border-border bg-background/80 p-1 backdrop-blur"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={onToggle}
                className="h-3.5 w-3.5 accent-primary"
                aria-label={`Select ${entry.title}`}
              />
            </label>
            <button
              onPointerDown={(e) => controls.start(e)}
              title="Drag to reorder"
              className="cursor-grab rounded-md border border-border bg-background/80 px-1.5 py-1 font-mono text-[10px] text-muted-foreground backdrop-blur hover:text-foreground active:cursor-grabbing"
            >
              ⋮⋮
            </button>
          </div>
          {entry.alias && (
            <span className="absolute right-2 top-2 rounded-md border border-primary/40 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-primary backdrop-blur">
              /{entry.alias}
            </span>
          )}
          <div className="absolute bottom-2 left-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {faviconFor(entry.destination) && (
              <img
                src={faviconFor(entry.destination)}
                alt=""
                className="h-3.5 w-3.5 rounded-sm"
              />
            )}
            <span className="font-mono">{hostOf(entry.destination)}</span>
          </div>
        </div>
      )}

      <div className="p-3">
        <div className="flex items-start gap-2">
          {isList && (
            <>
              <label
                className="mt-1 cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={onToggle}
                  className="h-4 w-4 accent-primary"
                />
              </label>
              <button
                onPointerDown={(e) => controls.start(e)}
                className="mt-1 cursor-grab font-mono text-xs text-muted-foreground hover:text-foreground active:cursor-grabbing"
                title="Drag"
              >
                ⋮⋮
              </button>
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-border bg-secondary">
                {entry.image ? (
                  <img
                    src={entry.image}
                    alt=""
                    className="h-full w-full object-cover"
                    onError={(ev) => {
                      (ev.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center font-mono text-xs text-muted-foreground">
                    {entry.title.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
              {entry.title}
            </h3>
            <a
              href={entry.shortUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate font-mono text-[11px] text-primary hover:underline"
            >
              {entry.shortUrl}
            </a>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px]">
          <button
            onClick={onCopyAll}
            className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-medium text-primary transition hover:bg-primary/20"
          >
            ⧉ Copy
          </button>
          <button
            onClick={() => onCopyField(entry.shortUrl)}
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:border-primary/60 hover:text-primary"
          >
            Short
          </button>
          <button
            onClick={() => onCopyField(entry.destination)}
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:border-primary/60 hover:text-primary"
          >
            Dest
          </button>
          {entry.image && (
            <button
              onClick={() => onCopyField(entry.image)}
              className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:border-primary/60 hover:text-primary"
            >
              Img
            </button>
          )}
          <button
            onClick={onToggleQr}
            className={`rounded-md border px-2 py-1 transition ${
              qrOpen
                ? "border-primary bg-primary/20 text-primary"
                : "border-border text-muted-foreground hover:border-primary/60 hover:text-primary"
            }`}
            title="QR code"
          >
            ▦ QR
          </button>
          <button
            onClick={onDelete}
            className="ml-auto rounded-md px-2 py-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
          >
            ✕
          </button>
        </div>

        <AnimatePresence>
          {qrOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="mt-3 overflow-hidden"
            >
              <div className="flex items-center gap-3 rounded-lg border border-border bg-background/70 p-3">
                <div className="rounded-md bg-white p-2">
                  <QRCodeSVG
                    value={entry.shortUrl}
                    size={96}
                    level="M"
                    bgColor="#ffffff"
                    fgColor="#000000"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Scannable short link
                  </div>
                  <div className="truncate font-mono text-[11px] text-primary">
                    {entry.shortUrl}
                  </div>
                  <button
                    onClick={() => onCopyField(entry.shortUrl)}
                    className="mt-1 rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Copy link
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Reorder.Item>
  );
}