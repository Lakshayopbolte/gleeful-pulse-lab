import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { QRCodeSVG } from "qrcode.react";
import { shortenUrl } from "@/lib/shorten.functions";
import { searchImages, type ImageHit } from "@/lib/image-search.functions";
import {
  getGateState,
  unlockSite,
  lockSite,
  saveLink,
  deleteLink,
  getTrash,
  restoreLink,
  purgeLink,
  emptyTrash,
  type LinkEntry,
} from "@/lib/gate.functions";

export const Route = createFileRoute("/")({
  loader: () => getGateState(),
  component: Workspace,
});

type Entry = LinkEntry;

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

function Workspace() {
  const router = useRouter();
  const state = Route.useLoaderData();

  if (!state.unlocked) {
    return <UnlockScreen onUnlocked={async () => router.invalidate()} />;
  }

  return (
    <WorkspaceInner
      initialEntries={state.entries}
      user={state.user}
      initialTrashCount={state.trashCount ?? 0}
    />
  );
}

function WorkspaceInner({
  initialEntries,
  user,
  initialTrashCount,
}: {
  initialEntries: Entry[];
  user: string;
  initialTrashCount: number;
}) {
  const router = useRouter();
  const shorten = useServerFn(shortenUrl);
  const runImageSearch = useServerFn(searchImages);
  const saveLinkFn = useServerFn(saveLink);
  const deleteLinkFn = useServerFn(deleteLink);
  const lockFn = useServerFn(lockSite);
  const getTrashFn = useServerFn(getTrash);
  const restoreLinkFn = useServerFn(restoreLink);
  const purgeLinkFn = useServerFn(purgeLink);
  const emptyTrashFn = useServerFn(emptyTrash);

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

  const [entries, setEntries] = useState<Entry[]>(initialEntries);
  const [query, setQuery] = useState("");
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

  // Trash / archive
  const [view, setView] = useState<"vault" | "trash">("vault");
  const [trashCount, setTrashCount] = useState<number>(initialTrashCount);
  const [trashEntries, setTrashEntries] = useState<Entry[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);

  // Duplicate detection
  const [dupWarning, setDupWarning] = useState<Entry | null>(null);

  // Bulk import
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; failed: number }>({ done: 0, total: 0, failed: 0 });

  async function pasteDestination() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setStatus({ kind: "error", message: "Clipboard is empty" });
        return;
      }
      setDestination(text.trim());
      setFlash("Pasted from clipboard");
      window.setTimeout(() => setFlash((f) => (f === "Pasted from clipboard" ? null : f)), 1400);
    } catch {
      setStatus({ kind: "error", message: "Clipboard blocked — allow permission" });
    }
  }

  async function handleBulkImport() {
    const lines = importText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    setImportBusy(true);
    setImportProgress({ done: 0, total: lines.length, failed: 0 });
    let failed = 0;
    const existing = new Set(entries.map((e) => e.destination.replace(/\/+$/, "").toLowerCase()));
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // Support "Title | url" or "Title,url" or bare url
      let t = "";
      let url = raw;
      const sep = raw.match(/^(.*?)\s*[|,\t]\s*(https?:\S+|\S+\.\S+.*)$/i);
      if (sep) { t = sep[1].trim(); url = sep[2].trim(); }
      const dest = normalizeUrl(url);
      if (!dest) { failed++; setImportProgress((p) => ({ ...p, done: i + 1, failed })); continue; }
      const norm = dest.replace(/\/+$/, "").toLowerCase();
      if (existing.has(norm)) { setImportProgress((p) => ({ ...p, done: i + 1 })); continue; }
      const finalTitle = t || hostOf(dest);
      const finalAlias = makeShortAlias(finalTitle);
      try {
        const res = await shorten({ data: { url: dest, alias: finalAlias } });
        const saved = await saveLinkFn({
          data: {
            title: finalTitle,
            alias: finalAlias,
            destination: dest,
            image: "",
            shortUrl: res.shortUrl,
          },
        });
        setEntries((prev) => [saved, ...prev]);
        existing.add(norm);
      } catch {
        failed++;
      }
      setImportProgress({ done: i + 1, total: lines.length, failed });
    }
    setImportBusy(false);
    setImportText("");
    setStatus({ kind: "success", message: `Imported ${lines.length - failed}/${lines.length}` });
  }

  async function loadTrash() {
    setTrashLoading(true);
    try {
      const list = await getTrashFn();
      setTrashEntries(list);
      setTrashCount(list.length);
    } catch {
      setStatus({ kind: "error", message: "Couldn't load trash" });
    } finally {
      setTrashLoading(false);
    }
  }

  useEffect(() => {
    if (view === "trash") loadTrash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

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

  // Auto-derive alias from title until the user edits alias manually
  useEffect(() => {
    if (aliasTouched) return;
    setAlias(makeShortAlias(title));
  }, [title, aliasTouched]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    const terms = q.split(/\s+/).filter(Boolean);
    return entries.filter((e) => {
      const hay = [e.title, e.alias, e.destination, e.shortUrl, hostOf(e.destination)]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
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
    // Duplicate detection — same destination already in vault
    const norm = dest.replace(/\/+$/, "").toLowerCase();
    const dup = entries.find(
      (e) => e.destination.replace(/\/+$/, "").toLowerCase() === norm,
    );
    if (dup && dupWarning?.id !== dup.id) {
      setDupWarning(dup);
      setStatus({ kind: "error", message: "Duplicate — click Save again to add anyway" });
      return;
    }
    setDupWarning(null);
    setStatus({ kind: "saving" });
    try {
      // Always mint a fresh short link on save so the record is guaranteed complete
      const res = await shorten({ data: { url: dest, alias: alias.trim() } });
      const finalShort = res.shortUrl;
      setShortUrl(finalShort);
      const saved = await saveLinkFn({
        data: {
          title: title.trim(),
          alias: alias.trim(),
          destination: dest,
          image: image.trim(),
          shortUrl: finalShort,
        },
      });
      setEntries((prev) => [saved, ...prev]);
      resetForm();
      setStatus({ kind: "success", message: "Saved to cloud" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save",
      });
    }
  }

  async function deleteEntry(id: string) {
    const prev = entries;
    setEntries((p) => p.filter((e) => e.id !== id));
    setTrashCount((c) => c + 1);
    try {
      await deleteLinkFn({ data: { id } });
      setFlash("Moved to trash");
      window.setTimeout(() => setFlash((f) => (f === "Moved to trash" ? null : f)), 1400);
    } catch {
      setEntries(prev);
      setTrashCount((c) => Math.max(0, c - 1));
      setStatus({ kind: "error", message: "Failed to delete" });
    }
  }

  async function restoreEntry(id: string) {
    const target = trashEntries.find((e) => e.id === id);
    setTrashEntries((p) => p.filter((e) => e.id !== id));
    setTrashCount((c) => Math.max(0, c - 1));
    try {
      const restored = await restoreLinkFn({ data: { id } });
      setEntries((prev) => [restored, ...prev]);
    } catch {
      if (target) setTrashEntries((p) => [target, ...p]);
      setTrashCount((c) => c + 1);
      setStatus({ kind: "error", message: "Failed to restore" });
    }
  }

  async function purgeEntry(id: string) {
    const target = trashEntries.find((e) => e.id === id);
    setTrashEntries((p) => p.filter((e) => e.id !== id));
    setTrashCount((c) => Math.max(0, c - 1));
    try {
      await purgeLinkFn({ data: { id } });
    } catch {
      if (target) setTrashEntries((p) => [target, ...p]);
      setTrashCount((c) => c + 1);
      setStatus({ kind: "error", message: "Couldn't permanently delete" });
    }
  }

  async function handleEmptyTrash() {
    if (trashEntries.length === 0) return;
    if (!window.confirm(`Permanently delete ${trashEntries.length} item(s)? This cannot be undone.`)) return;
    const prev = trashEntries;
    setTrashEntries([]);
    setTrashCount(0);
    try {
      await emptyTrashFn();
      setFlash("Trash emptied");
      window.setTimeout(() => setFlash((f) => (f === "Trash emptied" ? null : f)), 1400);
    } catch {
      setTrashEntries(prev);
      setTrashCount(prev.length);
      setStatus({ kind: "error", message: "Couldn't empty trash" });
    }
  }

  async function handleLock() {
    await lockFn();
    router.invalidate();
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
      <header className="apple-nav sticky top-0 z-30">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-6">
          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-gradient-to-br from-amber-400 to-amber-600 text-black shadow-[0_0_0_0.5px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.35)]">
              <span className="font-display text-[13px] font-black tracking-tight">F</span>
            </div>
            <span className="apple-title text-[15px] font-semibold tracking-[-0.01em] text-white/95">
              FREEKITAAB
            </span>
          </div>

          {/* Segmented control — Apple-style */}
          <div className="apple-segment ml-4">
            <button
              onClick={() => setView("vault")}
              className={`segment ${view === "vault" ? "segment-active" : ""}`}
            >
              Vault
              <span className="ml-1.5 text-[11px] tabular-nums opacity-70">
                {entries.length}
              </span>
            </button>
            <button
              onClick={() => setView("trash")}
              className={`segment ${view === "trash" ? "segment-active" : ""}`}
            >
              Trash
              {trashCount > 0 && (
                <span className="ml-1.5 text-[11px] tabular-nums opacity-70">
                  {trashCount}
                </span>
              )}
            </button>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {user && (
              <span className="apple-pill hidden sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {user}
              </span>
            )}
            <button
              onClick={exportJson}
              disabled={entries.length === 0}
              className="apple-btn"
              title="Export JSON"
            >
              Export
            </button>
            <button onClick={handleLock} className="apple-btn apple-btn-danger" title="Lock vault">
              Lock
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        {view === "trash" ? (
          <TrashPanel
            entries={trashEntries}
            loading={trashLoading}
            onRestore={restoreEntry}
            onPurge={purgeEntry}
            onEmpty={handleEmptyTrash}
            onBack={() => setView("vault")}
            hostOf={hostOf}
            faviconFor={faviconFor}
          />
        ) : (
          <>
        {/* Quick actions bar */}
        <section className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-900/30 bg-gradient-to-r from-[#161311]/90 via-[#141210]/70 to-[#161311]/90 px-4 py-3 shadow-[inset_0_1px_0_0_rgba(251,191,36,0.05)] backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <Stat label="Entries" value={entries.length} />
            <Stat label="Aliased" value={entries.filter((e) => e.alias).length} />
            <Stat label="With art" value={entries.filter((e) => e.image).length} />
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-lg border border-amber-900/30 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500 md:flex">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
              </span>
              Cloud synced
            </div>
            <div className="hidden items-center gap-1.5 rounded-lg border border-amber-900/30 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500 lg:flex">
              <kbd className="rounded border border-amber-900/50 bg-black/60 px-1.5 py-0.5 text-amber-300">⌘</kbd>
              <kbd className="rounded border border-amber-900/50 bg-black/60 px-1.5 py-0.5 text-amber-300">K</kbd>
              <span className="ml-1">search</span>
            </div>
            <button
              onClick={() => setImportOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg border-2 border-amber-500/60 bg-amber-500/10 px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-widest text-amber-300 shadow-[0_0_20px_-8px_rgba(251,191,36,0.5)] transition hover:bg-amber-500/20 hover:shadow-[0_0_24px_-6px_rgba(251,191,36,0.6)]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Import
            </button>
          </div>
        </section>

        {importOpen && (
          <section className="mb-8 rounded-xl border-2 border-amber-500/40 bg-[#141210] p-5 shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="font-display text-lg font-extrabold text-amber-50">Bulk import</h3>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-600/70">
                  One per line · <span className="text-amber-400">Title | url</span> or just url
                </p>
              </div>
              <button
                onClick={() => setImportOpen(false)}
                className="rounded border border-amber-900/40 px-2 py-1 text-xs text-stone-400 hover:text-amber-200"
              >
                ✕
              </button>
            </div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={6}
              placeholder={"Physics Ch 3 | https://example.com/phy-ch3.pdf\nhttps://example.com/notes.pdf\nChemistry Notes, https://example.com/chem.pdf"}
              className="input w-full font-mono text-xs"
              disabled={importBusy}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="font-mono text-[11px] text-stone-500">
                {importBusy ? (
                  <>
                    <span className="text-amber-400">{importProgress.done}</span>
                    <span> / {importProgress.total} processed</span>
                    {importProgress.failed > 0 && (
                      <span className="ml-2 text-red-400">· {importProgress.failed} failed</span>
                    )}
                  </>
                ) : (
                  <>
                    {importText.split(/\r?\n/).filter((l) => l.trim()).length} link(s) ready
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    try {
                      const t = await navigator.clipboard.readText();
                      setImportText((prev) => (prev ? prev + "\n" + t : t));
                    } catch {
                      setStatus({ kind: "error", message: "Clipboard blocked" });
                    }
                  }}
                  disabled={importBusy}
                  className="rounded-md border border-amber-900/40 px-3 py-2 font-mono text-xs font-bold uppercase tracking-widest text-stone-300 hover:border-amber-500/60 hover:text-amber-200"
                >
                  Paste
                </button>
                <button
                  onClick={handleBulkImport}
                  disabled={importBusy || !importText.trim()}
                  className="rounded-md bg-amber-500 px-5 py-2 font-mono text-xs font-bold uppercase tracking-widest text-black shadow-[0_3px_0_0_#92400e] transition hover:bg-amber-400 active:translate-y-0.5 active:shadow-none disabled:opacity-40"
                >
                  {importBusy ? "Importing…" : "Start import"}
                </button>
              </div>
            </div>
            {importBusy && (
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-amber-900/30">
                <div
                  className="h-full bg-amber-500 transition-all"
                  style={{ width: `${(importProgress.done / Math.max(1, importProgress.total)) * 100}%` }}
                />
              </div>
            )}
          </section>
        )}

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
                    type="button"
                    onClick={pasteDestination}
                    className="btn-ghost-amber flex items-center gap-1.5 whitespace-nowrap px-4 font-mono text-xs font-bold uppercase tracking-wider"
                    title="Paste from clipboard"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
                    Paste
                  </button>
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
              {dupWarning && (
                <div className="rounded-lg border-2 border-amber-500/50 bg-amber-500/10 p-3">
                  <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-400">
                    ⚠ Duplicate destination
                  </div>
                  <div className="text-xs text-amber-100/90">
                    Already saved as <span className="font-semibold">“{dupWarning.title}”</span>
                    {dupWarning.alias && (
                      <span className="ml-1 font-mono text-amber-400">/{dupWarning.alias}</span>
                    )}
                    . Click <span className="font-semibold">Shorten &amp; save</span> again to add anyway, or clear the destination.
                  </div>
                </div>
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
          <section className="relative overflow-hidden rounded-xl border-2 border-amber-900/40 bg-[#141210] shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-900/20 px-6 pt-6 pb-4 sm:px-8 sm:pt-8 sm:pb-6">
              <div>
                <h2 className="font-display text-2xl font-extrabold tracking-tight text-amber-50 sm:text-3xl">
                  Vault
                  <span className="ml-2 font-mono text-xs font-medium text-stone-500">
                    [{String(filtered.length).padStart(2, "0")}
                    {selected.size > 0 && (
                      <span className="text-amber-500"> / {selected.size} picked</span>
                    )}
                    ]
                  </span>
                </h2>
                <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-600/60">
                  02 · Retrieve
                </p>
              </div>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-600">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  id="vault-search"
                  placeholder="Search  ⌘K"
                  className="input h-11 w-56 pl-9 text-sm"
                />
              </div>
            </div>

            <div className="p-6 sm:p-8">
              {/* Bulk toolbar */}
              <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border-2 border-amber-900/30 bg-[#1c1917] p-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-stone-400 hover:text-amber-200">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    disabled={filtered.length === 0}
                    className="accent-amber-500"
                  />
                  <span className="font-mono font-bold uppercase tracking-widest">
                    {allVisibleSelected ? "Unselect" : "Select all"}
                  </span>
                </label>
                <div className="mx-1 h-5 w-px bg-amber-900/40" />
                <div className="flex items-center gap-0.5 rounded-md border-2 border-amber-900/30 bg-[#0f0d0b] p-0.5">
                  {(["json", "csv", "markdown", "text", "html"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setCopyFormat(f)}
                      className={`rounded px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest transition ${
                        copyFormat === f
                          ? "bg-amber-500 text-black"
                          : "text-stone-500 hover:text-amber-200"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <div className="flex items-center gap-0.5 rounded-md border-2 border-amber-900/30 bg-[#0f0d0b] p-0.5">
                    {(["grid", "list"] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => setDensity(d)}
                        title={`${d} view`}
                        className={`rounded px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest transition ${
                          density === d
                            ? "bg-amber-200 text-black"
                            : "text-stone-500 hover:text-amber-200"
                        }`}
                      >
                        {d === "grid" ? "▦" : "≡"}
                      </button>
                    ))}
                  </div>
                  {selected.size > 0 && (
                    <button
                      onClick={clearSelection}
                      className="font-mono text-[10px] font-bold uppercase tracking-widest text-stone-500 hover:text-red-400"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    onClick={copySelected}
                    disabled={filtered.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-2 font-display text-xs font-bold text-black shadow-[0_3px_0_0_#92400e] transition-all hover:bg-amber-400 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span aria-hidden>⧉</span>
                    Copy {selected.size > 0 ? selected.size : "all"} · {copyFormat.toUpperCase()}
                  </button>
                </div>
              </div>

              {flash && (
                <div className="mb-3 rounded-md border-2 border-amber-500/50 bg-amber-500/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-amber-400">
                  ✓ {flash} copied to clipboard
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-amber-900/30 bg-[#1c1917]/40 py-16 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg border-2 border-amber-900/40 bg-[#292524] font-mono text-lg text-stone-500">
                    ∅
                  </div>
                  <p className="font-mono text-xs uppercase tracking-widest text-stone-500">
                    {entries.length === 0
                      ? "Vault empty — mint your first short link"
                      : "No matches for that search"}
                  </p>
                </div>
              ) : (
                <div
                  className={
                    density === "grid"
                      ? "grid gap-4 sm:grid-cols-2"
                      : "space-y-3"
                  }
                >
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
                </div>
              )}
            </div>
          </section>
        </div>

          </>
        )}

        <footer className="mt-16 flex flex-col items-center justify-between gap-2 border-t border-border/60 pt-6 font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground sm:flex-row">
          <span>FREEKITAAB · workspace</span>
          <span>powered by arolinks</span>
        </footer>
      </main>

      <style>{`
        /* Apple-style translucent nav */
        .apple-nav {
          background: color-mix(in oklab, #0a0a0a 72%, transparent);
          -webkit-backdrop-filter: saturate(180%) blur(24px);
          backdrop-filter: saturate(180%) blur(24px);
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .apple-title { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", ui-sans-serif, system-ui; }
        .apple-segment {
          display: inline-flex;
          padding: 2px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 9px;
        }
        .segment {
          display: inline-flex; align-items: center;
          padding: 4px 12px;
          font-size: 12.5px; font-weight: 500;
          letter-spacing: -0.005em;
          color: rgba(255,255,255,0.72);
          border-radius: 7px;
          transition: background 0.15s, color 0.15s;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
        }
        .segment:hover { color: rgba(255,255,255,0.92); }
        .segment-active {
          background: rgba(255,255,255,0.11);
          color: #fff;
          box-shadow: 0 0 0 0.5px rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.3);
        }
        .apple-pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 11.5px; font-weight: 500;
          letter-spacing: -0.005em;
          color: rgba(255,255,255,0.82);
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.08);
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
        }
        .apple-btn {
          padding: 5px 12px;
          border-radius: 7px;
          font-size: 12.5px; font-weight: 500;
          letter-spacing: -0.005em;
          color: rgba(255,255,255,0.9);
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.08);
          transition: background 0.15s, color 0.15s, transform 0.05s;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
        }
        .apple-btn:hover { background: rgba(255,255,255,0.14); }
        .apple-btn:active { transform: translateY(0.5px); }
        .apple-btn:disabled { opacity: 0.4; }
        .apple-btn-danger:hover { background: rgba(239,68,68,0.18); color: #fecaca; }

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
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-amber-600">
          {label}
          {required && <span className="ml-1 text-amber-500">*</span>}
        </span>
        {hint && (
          <span className="font-mono text-[9px] font-medium text-stone-500">
            {hint}
          </span>
        )}
      </div>
      {children}
    </label>
  );
}

function UnlockScreen({ onUnlocked }: { onUnlocked: () => Promise<void> }) {
  const unlockFn = useServerFn(unlockSite);
  const [username, setUsername] = useState("Lakshay");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter username and password");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await unlockFn({ data: { username: username.trim(), password } });
      if (!res.ok) {
        setError("Password is wrong. Use the vault password, not the username.");
        setBusy(false);
        return;
      }
      await onUnlocked();
      window.location.replace(window.location.pathname);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border-2 border-amber-900/40 bg-[#141210] p-8 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500 text-black shadow-[0_4px_0_0_#92400e]">
            <span className="font-display text-xl font-bold">F</span>
          </div>
          <div>
            <div className="font-display text-xl font-extrabold tracking-tight text-amber-50">
              FREEKITAAB
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-amber-600/60">
              00 · Sign in to the vault
            </div>
          </div>
        </div>

        <label className="mb-4 block">
          <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-widest text-amber-600">
            Username
          </div>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="admin"
            className="w-full rounded-lg border-2 border-amber-900/30 bg-[#1c1917] px-4 py-3 font-mono text-amber-50 outline-none focus:border-amber-500/55"
          />
        </label>
        <label className="mb-4 block">
          <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-widest text-amber-600">
            Password
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
            className="w-full rounded-lg border-2 border-amber-900/30 bg-[#1c1917] px-4 py-3 font-mono text-amber-50 outline-none focus:border-amber-500/55"
          />
        </label>

        {error && (
          <p className="mb-3 rounded-md border-2 border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-amber-500 px-6 py-3.5 font-display font-bold text-black shadow-[0_4px_0_0_#92400e] transition-all hover:bg-amber-400 active:translate-y-1 active:shadow-none disabled:opacity-40"
        >
          {busy ? "Unlocking…" : "Unlock vault"}
        </button>
        <p className="mt-4 text-center font-mono text-[10px] uppercase tracking-widest text-stone-500">
          Username is Lakshay · enter your vault password
        </p>
      </form>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="group relative flex min-w-[92px] items-center gap-3 rounded-xl border border-amber-900/40 bg-gradient-to-br from-amber-500/[0.06] to-transparent px-4 py-2.5 transition hover:border-amber-500/50">
      <div className="font-display text-2xl font-bold leading-none text-amber-50 tabular-nums">
        {value}
      </div>
      <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-amber-500/70">
        {label}
      </div>
    </div>
  );
}

function TrashPanel({
  entries,
  loading,
  onRestore,
  onPurge,
  onEmpty,
  onBack,
  hostOf,
  faviconFor,
}: {
  entries: Entry[];
  loading: boolean;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onEmpty: () => void;
  onBack: () => void;
  hostOf: (u: string) => string;
  faviconFor: (u: string) => string;
}) {
  return (
    <section className="rounded-xl border-2 border-amber-900/40 bg-[#141210] p-6 shadow-[0_20px_50px_rgba(0,0,0,0.5)] sm:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-amber-900/20 pb-4">
        <div>
          <h2 className="font-display text-2xl font-extrabold tracking-tight text-amber-50 sm:text-3xl">
            Trash
            <span className="ml-2 font-mono text-xs font-medium text-stone-500">
              [{String(entries.length).padStart(2, "0")}]
            </span>
          </h2>
          <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-600/60">
            Deleted items · restore or purge
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="apple-btn">← Vault</button>
          <button
            onClick={onEmpty}
            disabled={entries.length === 0}
            className="apple-btn apple-btn-danger disabled:opacity-40"
          >
            Empty trash
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center font-mono text-xs uppercase tracking-widest text-stone-500">
          Loading…
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-amber-900/30 bg-[#1c1917]/40 py-16 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg border-2 border-amber-900/40 bg-[#292524] font-mono text-lg text-stone-500">
            ✓
          </div>
          <p className="font-mono text-xs uppercase tracking-widest text-stone-500">
            Trash is empty
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-3 rounded-lg border-2 border-amber-900/30 bg-[#1c1917] p-3 transition hover:border-amber-500/40"
            >
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded border-2 border-amber-900/40 bg-[#0f0d0b]">
                {e.image ? (
                  <img
                    src={e.image}
                    alt=""
                    className="h-full w-full object-cover opacity-60"
                    onError={(ev) => {
                      (ev.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center font-display text-sm font-extrabold text-amber-900/60">
                    {e.title.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-1 font-display text-sm font-bold text-amber-50/80">
                  {e.title}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-stone-500">
                  {faviconFor(e.destination) && (
                    <img src={faviconFor(e.destination)} alt="" className="h-3 w-3 rounded-sm opacity-60" />
                  )}
                  <span className="truncate">{hostOf(e.destination)}</span>
                  {e.alias && <span className="text-amber-500/70">· /{e.alias}</span>}
                </div>
              </div>
              <button
                onClick={() => onRestore(e.id)}
                className="apple-btn"
                title="Restore"
              >
                Restore
              </button>
              <button
                onClick={() => {
                  if (window.confirm("Permanently delete this link?")) onPurge(e.id);
                }}
                className="apple-btn apple-btn-danger"
                title="Delete forever"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
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
  const isList = density === "list";

  return (
    <div
      className={`group relative overflow-hidden rounded-lg border-2 bg-[#1c1917] transition-all ${
        selected
          ? "border-amber-500/70 shadow-[0_0_0_2px_rgba(245,158,11,0.15),0_8px_0_0_#92400e]"
          : "border-amber-900/30 hover:border-amber-500/40 hover:-translate-y-0.5"
      }`}
    >
      {/* Cover */}
      {!isList && (
        <div className="relative h-36 w-full overflow-hidden border-b-2 border-amber-900/30 bg-[#0f0d0b]">
          {entry.image ? (
            <img
              src={entry.image}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.05]"
              onError={(ev) => {
                (ev.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#292524] to-[#0f0d0b] font-display text-4xl font-extrabold text-amber-900/40">
              {entry.title.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#141210] via-[#141210]/30 to-transparent" />
          <label
            className="absolute left-2 top-2 flex cursor-pointer items-center gap-1 rounded border-2 border-amber-900/40 bg-[#141210]/90 p-1 backdrop-blur"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              className="h-3.5 w-3.5 accent-amber-500"
              aria-label={`Select ${entry.title}`}
            />
          </label>
          {entry.alias && (
            <span className="absolute right-2 top-2 rounded border-2 border-amber-500/50 bg-[#141210]/90 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-400 backdrop-blur">
              /{entry.alias}
            </span>
          )}
          <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded border border-amber-900/40 bg-[#141210]/80 px-1.5 py-0.5 text-[10px] text-stone-400 backdrop-blur">
            {faviconFor(entry.destination) && (
              <img
                src={faviconFor(entry.destination)}
                alt=""
                className="h-3.5 w-3.5 rounded-sm"
              />
            )}
            <span className="font-mono font-medium">{hostOf(entry.destination)}</span>
          </div>
        </div>
      )}

      <div className="p-4">
        <div className="flex items-start gap-3">
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
                  className="h-4 w-4 accent-amber-500"
                />
              </label>
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded border-2 border-amber-900/40 bg-[#0f0d0b]">
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
                  <div className="flex h-full w-full items-center justify-center font-display text-sm font-extrabold text-amber-900/60">
                    {entry.title.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 font-display text-sm font-bold leading-snug text-amber-50">
              {entry.title}
            </h3>
            <a
              href={entry.shortUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate font-mono text-[11px] font-medium text-amber-400 hover:underline"
            >
              {entry.shortUrl}
            </a>
            {isList && entry.alias && (
              <span className="mt-1 inline-block rounded border border-amber-900/40 bg-[#0f0d0b] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-amber-500">
                /{entry.alias}
              </span>
            )}
          </div>
          <button
            onClick={onDelete}
            className="rounded p-1 font-mono text-xs text-stone-600 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-400"
            title="Delete"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px]">
          <button
            onClick={onCopyAll}
            className="inline-flex items-center gap-1 rounded border-2 border-amber-500/50 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-400 transition hover:bg-amber-500/20"
          >
            ⧉ Copy all
          </button>
          <button
            onClick={() => onCopyField(entry.shortUrl)}
            className="rounded border-2 border-amber-900/30 bg-[#0f0d0b] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-stone-400 hover:border-amber-500/40 hover:text-amber-200"
          >
            Short
          </button>
          <button
            onClick={() => onCopyField(entry.destination)}
            className="rounded border-2 border-amber-900/30 bg-[#0f0d0b] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-stone-400 hover:border-amber-500/40 hover:text-amber-200"
          >
            Dest
          </button>
          {entry.image && (
            <button
              onClick={() => onCopyField(entry.image)}
              className="rounded border-2 border-amber-900/30 bg-[#0f0d0b] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-stone-400 hover:border-amber-500/40 hover:text-amber-200"
            >
              Img
            </button>
          )}
          <button
            onClick={onToggleQr}
            className={`ml-auto rounded border-2 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest transition ${
              qrOpen
                ? "border-amber-500 bg-amber-500/20 text-amber-300"
                : "border-amber-900/30 bg-[#0f0d0b] text-stone-400 hover:border-amber-500/40 hover:text-amber-200"
            }`}
            title="QR code"
          >
            ▦ QR
          </button>
        </div>

        {qrOpen && (
          <div className="mt-3">
            <div className="flex items-center gap-3 rounded-lg border-2 border-amber-900/40 bg-[#0f0d0b] p-3">
              <div className="rounded bg-white p-2">
                  <QRCodeSVG
                    value={entry.shortUrl}
                    size={96}
                    level="M"
                    bgColor="#ffffff"
                    fgColor="#000000"
                  />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-amber-600">
                  Scannable short link
                </div>
                <div className="truncate font-mono text-[11px] text-amber-400">
                  {entry.shortUrl}
                </div>
                <button
                  onClick={() => onCopyField(entry.shortUrl)}
                  className="mt-1 rounded border border-amber-900/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-stone-400 hover:text-amber-200"
                >
                  Copy link
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}