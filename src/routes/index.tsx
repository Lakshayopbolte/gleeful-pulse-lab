import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { shortenUrl } from "@/lib/shorten.functions";

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
        <section className="mb-12 grid gap-6 md:grid-cols-[1.4fr_1fr] md:items-end">
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
          <div className="relative overflow-hidden rounded-2xl border border-border glass-panel p-5 shadow-[var(--shadow-card)]">
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
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Composer */}
          <section className="relative rounded-2xl border border-border glass-panel p-6 shadow-[var(--shadow-card)]">
            <div className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold">New link</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                01 · Compose
              </span>
            </div>

            <div className="space-y-4">
              <Field label="Title" required>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex. Physics Class 12 — Chapter 3 Notes"
                  className="input"
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
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
                <Field label="Image link">
                  <input
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    placeholder="https://…/cover.jpg"
                    className="input"
                  />
                </Field>
              </div>

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
                    className="whitespace-nowrap rounded-md border border-border bg-secondary px-4 text-sm font-medium text-secondary-foreground transition hover:border-primary/60 hover:text-primary disabled:opacity-40"
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

              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={resetForm}
                  className="text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
                <button
                  onClick={handleSave}
                  disabled={busy || !title.trim() || !destination.trim()}
                  className="group relative overflow-hidden rounded-lg bg-[image:var(--gradient-hero)] px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-glow)] transition hover:-translate-y-px hover:brightness-110 active:translate-y-0 disabled:opacity-40 disabled:shadow-none disabled:hover:translate-y-0"
                >
                  <span className="relative z-10 inline-flex items-center gap-2">
                    {status.kind === "saving" ? (
                      <>Shortening & saving…</>
                    ) : (
                      <>Shorten &amp; save <span aria-hidden>→</span></>
                    )}
                  </span>
                </button>
              </div>
            </div>
          </section>

          {/* Vault */}
          <section className="rounded-2xl border border-border glass-panel p-6 shadow-[var(--shadow-card)]">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Vault <span className="ml-1 font-mono text-xs text-muted-foreground">· {filtered.length}</span></h2>
                <p className="text-xs text-muted-foreground">
                  Saved locally to this browser
                </p>
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="input h-9 w-40 text-sm"
              />
            </div>

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
              <ul className="space-y-3">
                {filtered.map((e) => (
                  <li
                    key={e.id}
                    className="group rounded-xl border border-border bg-background/60 p-4 transition hover:border-primary/40"
                  >
                    <div className="flex gap-4">
                      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-secondary">
                        {e.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={e.image}
                            alt=""
                            className="h-full w-full object-cover"
                            onError={(ev) => {
                              (ev.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center font-mono text-xs text-muted-foreground">
                            {e.title.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="truncate font-semibold text-foreground">
                            {e.title}
                          </h3>
                          {e.alias && (
                            <span className="shrink-0 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                              /{e.alias}
                            </span>
                          )}
                        </div>
                        <a
                          href={e.shortUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block truncate font-mono text-xs text-primary hover:underline"
                        >
                          {e.shortUrl}
                        </a>
                        <div
                          className="mt-0.5 truncate text-xs text-muted-foreground"
                          title={e.destination}
                        >
                          → {e.destination}
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs">
                          <button
                            onClick={() => copy(e.shortUrl)}
                            className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:border-primary/60 hover:text-primary"
                          >
                            Copy short
                          </button>
                          <button
                            onClick={() =>
                              copy(JSON.stringify(e, null, 2))
                            }
                            className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:border-primary/60 hover:text-primary"
                          >
                            Copy JSON
                          </button>
                          <button
                            onClick={() => deleteEntry(e.id)}
                            className="ml-auto rounded px-2 py-0.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
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
          height: 2.5rem;
          border-radius: 0.5rem;
          border: 1px solid var(--color-border);
          background: color-mix(in oklab, var(--color-background) 75%, transparent);
          padding: 0 0.75rem;
          color: var(--color-foreground);
          font-size: 0.875rem;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input:focus {
          border-color: color-mix(in oklab, var(--color-primary) 60%, transparent);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-primary) 20%, transparent);
        }
        .input::placeholder {
          color: color-mix(in oklab, var(--color-muted-foreground) 70%, transparent);
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