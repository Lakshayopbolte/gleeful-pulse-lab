import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { QRCodeSVG } from "qrcode.react";
import { shortenUrl } from "@/lib/shorten.functions";
import { searchImages, type ImageHit } from "@/lib/image-search.functions";
import { verifyShortLink } from "@/lib/verify.functions";
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
  const verifyFn = useServerFn(verifyShortLink);
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

  // Live status per entry id (in-memory; verified on demand + after save)
  type LiveStatus = {
    state: "checking" | "live" | "broken" | "unknown";
    message?: string;
    latencyMs?: number;
    checkedAt?: string;
  };
  const [liveStatus, setLiveStatus] = useState<Record<string, LiveStatus>>({});

  async function verifyEntry(id: string, shortUrl: string, destination: string) {
    if (!shortUrl) return;
    setLiveStatus((m) => ({ ...m, [id]: { ...(m[id] ?? {}), state: "checking" } }));
    try {
      const res = await verifyFn({ data: { shortUrl, destination } });
      setLiveStatus((m) => ({
        ...m,
        [id]: {
          state: res.status,
          message: res.message,
          latencyMs: res.latencyMs,
          checkedAt: res.checkedAt,
        },
      }));
    } catch (err) {
      setLiveStatus((m) => ({
        ...m,
        [id]: {
          state: "broken",
          message: err instanceof Error ? err.message : "Verify failed",
        },
      }));
    }
  }

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
    const titleVal = title.trim();
    const aliasVal = alias.trim();
    const imageVal = image.trim();
    if (!titleVal || !dest) {
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

    // ── Optimistic path: clear the form INSTANTLY and put a placeholder in the vault
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const placeholder: Entry = {
      id: tempId,
      title: titleVal,
      alias: aliasVal,
      destination: dest,
      image: imageVal,
      shortUrl: "",
      createdAt: Date.now(),
    } as Entry;
    setEntries((prev) => [placeholder, ...prev]);
    setLiveStatus((m) => ({ ...m, [tempId]: { state: "checking", message: "Shortening…" } }));
    resetForm();
    setStatus({ kind: "success", message: "Added — shortening in background" });

    // ── Background: shorten → save → verify. Update the placeholder as we go.
    try {
      const res = await shorten({ data: { url: dest, alias: aliasVal } });
      const finalShort = res.shortUrl;
      setLiveStatus((m) => ({
        ...m,
        [tempId]: { state: "checking", message: "Saving to cloud…" },
      }));
      const saved = await saveLinkFn({
        data: {
          title: titleVal,
          alias: aliasVal,
          destination: dest,
          image: imageVal,
          shortUrl: finalShort,
        },
      });
      // Swap placeholder → real row and migrate the status entry.
      setEntries((prev) => prev.map((e) => (e.id === tempId ? saved : e)));
      setLiveStatus((m) => {
        const next = { ...m };
        delete next[tempId];
        next[saved.id] = { state: "checking", message: "Verifying link…" };
        return next;
      });
      // Verify (does not block the UI)
      void verifyEntry(saved.id, saved.shortUrl, saved.destination);
    } catch (err) {
      // Roll back placeholder on failure
      setEntries((prev) => prev.filter((e) => e.id !== tempId));
      setLiveStatus((m) => {
        const next = { ...m };
        delete next[tempId];
        return next;
      });
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
              <span className="ml-1.5 text-[13px] tabular-nums opacity-70">
                {entries.length}
              </span>
            </button>
            <button
              onClick={() => setView("trash")}
              className={`segment ${view === "trash" ? "segment-active" : ""}`}
            >
              Trash
              {trashCount > 0 && (
                <span className="ml-1.5 text-[13px] tabular-nums opacity-70">
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
            <div className="hidden items-center gap-2 rounded-lg border border-amber-900/30 bg-black/30 px-3 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-stone-500 md:flex">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
              </span>
              Cloud synced
            </div>
            <div className="hidden items-center gap-1.5 rounded-lg border border-amber-900/30 bg-black/30 px-3 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-stone-500 lg:flex">
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
                <p className="mt-1 font-mono text-[12px] uppercase tracking-[0.14em] text-amber-600/70">
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
              <div className="font-mono text-[13px] text-stone-500">
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

        <div className="flex flex-col gap-8">
          {/* Composer */}
          <section className="apple-card relative overflow-hidden">
            <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-6 pt-6 pb-5 sm:px-8 sm:pt-7">
              <div>
                <h2 className="apple-title text-[26px] font-semibold tracking-[-0.02em] text-white sm:text-[30px]">
                  Link Box
                </h2>
                <p className="apple-subtitle mt-1 text-[13px] text-white/45">
                  Compose, shorten &amp; save a new link
                </p>
              </div>
              <span className="hidden sm:inline-flex items-center gap-2 rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1 text-[12px] font-medium text-amber-300">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]" />
                Live endpoint
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
                  <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.16em] text-muted-foreground">
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
                          <div className="border-t border-border/60 px-2 py-1.5 text-[13px] leading-snug text-foreground line-clamp-2 min-h-[2.4rem]">
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
                  <div className="font-mono text-[12px] uppercase tracking-[0.16em] text-primary">
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
                  <div className="mb-1 font-mono text-[12px] font-bold uppercase tracking-widest text-amber-400">
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
                <p className="font-mono text-[13px] uppercase tracking-[0.14em] text-primary">
                  ✓ {status.message}
                </p>
              )}

              <div className="flex items-center justify-between gap-3 pt-4">
                <button
                  onClick={resetForm}
                  className="apple-btn-ghost"
                >
                  Clear
                </button>
                <button
                  onClick={handleSave}
                  id="save-btn"
                  disabled={busy || !title.trim() || !destination.trim()}
                  className="apple-cta"
                >
                  {status.kind === "saving" ? (
                    <>
                      <span className="apple-cta-spinner" />
                      <span>Shortening &amp; saving…</span>
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      <span>Shorten &amp; save</span>
                      <kbd className="apple-cta-kbd">⌘ ↵</kbd>
                    </>
                  )}
                </button>
              </div>
            </div>
          </section>

          {/* Vault */}
          <section className="apple-card relative overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.06] px-6 pt-6 pb-5 sm:px-8 sm:pt-7">
              <div>
                <h2 className="apple-title text-[26px] font-semibold tracking-[-0.02em] text-white sm:text-[30px]">
                  Vault
                  <span className="ml-2.5 text-[15px] font-medium tabular-nums text-white/40">
                    {filtered.length}
                    {selected.size > 0 && (
                      <span className="text-amber-400"> · {selected.size} selected</span>
                    )}
                  </span>
                </h2>
                <p className="apple-subtitle mt-1 text-[13px] text-white/45">
                  Your saved short links
                </p>
              </div>
              <div className="apple-search relative">
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  id="vault-search"
                  placeholder="Search"
                  className="apple-search-input"
                />
                {query ? (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white/70 transition hover:bg-white/25 hover:text-white"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                  </button>
                ) : (
                  <kbd className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-white/50">⌘K</kbd>
                )}
              </div>
            </div>

            <div className="p-5 sm:p-7">
              {/* Bulk toolbar */}
              <div className="apple-toolbar mb-6 flex flex-wrap items-center gap-3">
                <label className="apple-check">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    disabled={filtered.length === 0}
                  />
                  <span>{allVisibleSelected ? "Deselect all" : "Select all"}</span>
                </label>
                <div className="apple-divider" />
                <div className="apple-segment-sm">
                  {(["json", "csv", "markdown", "text", "html"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setCopyFormat(f)}
                      className={`segment-sm ${copyFormat === f ? "segment-sm-active" : ""}`}
                    >
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <div className="apple-segment-sm">
                    {(["grid", "list"] as const).map((d) => (
                      <button
                        key={d}
                        onClick={() => setDensity(d)}
                        title={`${d} view`}
                        className={`segment-sm ${density === d ? "segment-sm-active" : ""}`}
                        aria-label={`${d} view`}
                      >
                        {d === "grid" ? (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>
                        )}
                      </button>
                    ))}
                  </div>
                  {selected.size > 0 && (
                    <button onClick={clearSelection} className="apple-btn">
                      Clear
                    </button>
                  )}
                  <button
                    onClick={copySelected}
                    disabled={filtered.length === 0}
                    className="apple-btn apple-btn-primary apple-btn-lg"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copy {selected.size > 0 ? `${selected.size} selected` : "all entries"}
                  </button>
                </div>
              </div>

              {flash && (
                <div className="apple-toast mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3.5 py-1.5 text-[13px] font-medium text-emerald-300">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                  {flash}
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02] py-20 text-center">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-white/40">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  </div>
                  <p className="text-[15px] font-medium text-white/70">
                    {entries.length === 0 ? "Your vault is empty" : "No matches"}
                  </p>
                  <p className="mt-1 text-[13px] text-white/40">
                    {entries.length === 0
                      ? "Save your first short link above"
                      : "Try a different search term"}
                  </p>
                </div>
              ) : (
                <div
                  className={
                    density === "grid"
                      ? "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
                      : "space-y-2.5"
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
                      live={liveStatus[e.id]}
                      onVerify={() => verifyEntry(e.id, e.shortUrl, e.destination)}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

          </>
        )}

        <footer className="mt-16 flex flex-col items-center justify-between gap-2 border-t border-border/60 pt-6 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground sm:flex-row">
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
        .apple-btn-lg {
          padding: 8px 18px;
          font-size: 13.5px;
          font-weight: 600;
          border-radius: 9px;
          display: inline-flex; align-items: center; gap: 7px;
        }

        .input {
          width: 100%;
          height: 3.25rem;
          border-radius: 0.625rem;
          border: 2px solid rgb(120 53 15 / 0.3);
          background: #1c1917;
          padding: 0 1rem;
          color: rgb(254 243 199);
          font-size: 1rem;
          line-height: 1.25;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input:focus {
          border-color: rgb(245 158 11 / 0.55);
          box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
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

        /* ── Apple-class Vault surfaces ─────────────────────────────── */
        .apple-card {
          border-radius: 20px;
          background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015));
          border: 1px solid rgba(255,255,255,0.07);
          box-shadow:
            0 1px 0 rgba(255,255,255,0.05) inset,
            0 30px 60px -30px rgba(0,0,0,0.6),
            0 8px 24px -12px rgba(0,0,0,0.45);
          backdrop-filter: blur(20px) saturate(140%);
        }
        .apple-subtitle {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
          letter-spacing: -0.005em;
        }

        /* Search field */
        .apple-search { width: 100%; max-width: 320px; }
        .apple-search-input {
          width: 100%;
          height: 36px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.05);
          padding: 0 44px 0 34px;
          color: rgba(255,255,255,0.95);
          font-size: 14px;
          letter-spacing: -0.005em;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
          outline: none;
          transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
        }
        .apple-search-input::placeholder { color: rgba(255,255,255,0.4); }
        .apple-search-input:focus {
          background: rgba(255,255,255,0.08);
          border-color: rgba(245,158,11,0.5);
          box-shadow: 0 0 0 3px rgba(245,158,11,0.14);
        }

        /* Toolbar shell */
        .apple-toolbar {
          padding: 8px;
          border-radius: 14px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
        }
        .apple-divider {
          width: 1px; height: 20px;
          background: rgba(255,255,255,0.08);
          margin: 0 4px;
        }
        .apple-check {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 4px 10px;
          font-size: 13px; font-weight: 500;
          letter-spacing: -0.005em;
          color: rgba(255,255,255,0.8);
          cursor: pointer; user-select: none;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
        }
        .apple-check input { accent-color: #f59e0b; width: 15px; height: 15px; }
        .apple-check:hover { color: #fff; }

        /* Small segmented control */
        .apple-segment-sm {
          display: inline-flex; padding: 2px;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 9px;
        }
        .segment-sm {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 32px; height: 26px;
          padding: 0 10px;
          font-size: 11.5px; font-weight: 600;
          letter-spacing: 0.02em;
          color: rgba(255,255,255,0.55);
          border-radius: 7px;
          transition: background 0.15s, color 0.15s;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
        }
        .segment-sm:hover { color: rgba(255,255,255,0.9); }
        .segment-sm-active {
          background: rgba(255,255,255,0.11);
          color: #fff;
          box-shadow: 0 0 0 0.5px rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.3);
        }

        /* Primary Apple button */
        .apple-btn-primary {
          background: linear-gradient(180deg, #fbbf24, #f59e0b);
          color: #1a1108;
          font-weight: 600;
          border: 1px solid rgba(0,0,0,0.15);
          box-shadow:
            0 1px 0 rgba(255,255,255,0.35) inset,
            0 6px 16px -6px rgba(245,158,11,0.55);
        }
        .apple-btn-primary:hover { background: linear-gradient(180deg, #fcd34d, #fbbf24); }
        .apple-btn-primary:disabled { opacity: 0.4; }

        /* Icon-only button */
        .apple-icon-btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 28px;
          border-radius: 8px;
          color: rgba(255,255,255,0.55);
          background: transparent;
          border: 1px solid transparent;
          transition: background 0.15s, color 0.15s;
        }
        .apple-icon-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }

        /* Vault card */
        .vault-card {
          position: relative; overflow: hidden;
          border-radius: 16px;
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015));
          border: 1px solid rgba(255,255,255,0.07);
          box-shadow:
            0 1px 0 rgba(255,255,255,0.04) inset,
            0 12px 32px -18px rgba(0,0,0,0.55);
          transition: transform 0.18s ease, border-color 0.15s, box-shadow 0.2s;
        }
        .vault-card:hover {
          transform: translateY(-2px);
          border-color: rgba(255,255,255,0.12);
          box-shadow:
            0 1px 0 rgba(255,255,255,0.05) inset,
            0 20px 44px -18px rgba(0,0,0,0.7);
        }
        .vault-card-selected {
          border-color: rgba(245,158,11,0.55);
          box-shadow:
            0 0 0 3px rgba(245,158,11,0.15),
            0 16px 40px -18px rgba(245,158,11,0.25);
        }
        .vault-card-list { border-radius: 12px; }

        /* Chip buttons */
        .apple-chip {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 5px 10px;
          font-size: 12px; font-weight: 500;
          letter-spacing: -0.005em;
          color: rgba(255,255,255,0.72);
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          transition: background 0.15s, color 0.15s, border-color 0.15s;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
        }
        .apple-chip:hover {
          background: rgba(255,255,255,0.1);
          color: #fff;
          border-color: rgba(255,255,255,0.12);
        }
        .apple-chip-primary {
          color: #fde68a;
          background: rgba(245,158,11,0.14);
          border-color: rgba(245,158,11,0.32);
        }
        .apple-chip-primary:hover {
          color: #fef3c7;
          background: rgba(245,158,11,0.22);
          border-color: rgba(245,158,11,0.45);
        }
        .apple-chip-active {
          color: #1a1108;
          background: linear-gradient(180deg, #fbbf24, #f59e0b);
          border-color: rgba(0,0,0,0.2);
        }
        .apple-chip-active:hover { color: #1a1108; }

        /* Enlarged primary chip (Copy everything) */
        .apple-chip-lg {
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 600;
          border-radius: 10px;
          gap: 7px;
          letter-spacing: -0.005em;
        }

        /* Apple-class field label */
        .apple-field-label {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
          font-size: 13.5px;
          font-weight: 600;
          letter-spacing: -0.005em;
          color: rgba(255,255,255,0.88);
        }
        .apple-field-hint {
          font-family: ui-monospace, "SF Mono", "JetBrains Mono", monospace;
          font-size: 12px;
          font-weight: 500;
          color: rgba(255,255,255,0.4);
        }

        /* Apple CTA button */
        .apple-cta {
          display: inline-flex; align-items: center; gap: 10px;
          padding: 12px 22px;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", ui-sans-serif, system-ui;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: -0.01em;
          color: #1a1108;
          background: linear-gradient(180deg, #fcd34d, #f59e0b);
          border: 1px solid rgba(0,0,0,0.18);
          border-radius: 12px;
          box-shadow:
            0 1px 0 rgba(255,255,255,0.4) inset,
            0 0 0 1px rgba(255,255,255,0.06),
            0 10px 28px -10px rgba(245,158,11,0.6),
            0 4px 12px -4px rgba(245,158,11,0.4);
          transition: transform 0.08s ease, box-shadow 0.15s ease, filter 0.15s ease;
        }
        .apple-cta:hover:not(:disabled) {
          filter: brightness(1.05);
          box-shadow:
            0 1px 0 rgba(255,255,255,0.45) inset,
            0 0 0 1px rgba(255,255,255,0.08),
            0 14px 36px -10px rgba(245,158,11,0.75),
            0 6px 16px -4px rgba(245,158,11,0.5);
        }
        .apple-cta:active:not(:disabled) { transform: translateY(1px); }
        .apple-cta:disabled { opacity: 0.4; cursor: not-allowed; }
        .apple-cta-kbd {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 3px 8px;
          font-family: ui-monospace, "SF Mono", "JetBrains Mono", monospace;
          font-size: 11.5px; font-weight: 700;
          color: rgba(26,17,8,0.75);
          background: rgba(0,0,0,0.12);
          border: 1px solid rgba(0,0,0,0.15);
          border-radius: 6px;
        }
        .apple-cta-spinner {
          width: 14px; height: 14px;
          border-radius: 50%;
          border: 2px solid rgba(26,17,8,0.25);
          border-top-color: #1a1108;
          animation: apple-spin 0.7s linear infinite;
        }
        @keyframes apple-spin { to { transform: rotate(360deg); } }

        /* Apple ghost button */
        .apple-btn-ghost {
          padding: 10px 16px;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", ui-sans-serif, system-ui;
          font-size: 14px;
          font-weight: 500;
          letter-spacing: -0.005em;
          color: rgba(255,255,255,0.55);
          background: transparent;
          border-radius: 10px;
          transition: color 0.15s, background 0.15s;
        }
        .apple-btn-ghost:hover {
          color: #fca5a5;
          background: rgba(239,68,68,0.08);
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
        <span className="apple-field-label">
          {label}
          {required && <span className="ml-1 text-amber-400">*</span>}
        </span>
        {hint && <span className="apple-field-hint">{hint}</span>}
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
            <div className="font-mono text-[12px] uppercase tracking-[0.16em] text-amber-600/60">
              00 · Sign in to the vault
            </div>
          </div>
        </div>

        <label className="mb-4 block">
          <div className="mb-2 font-mono text-[13px] font-bold uppercase tracking-widest text-amber-600">
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
          <div className="mb-2 font-mono text-[13px] font-bold uppercase tracking-widest text-amber-600">
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
        <p className="mt-4 text-center font-mono text-[12px] uppercase tracking-widest text-stone-500">
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
      <div className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-amber-500/70">
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
          <p className="mt-1 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-amber-600/60">
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
                <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[13px] text-stone-500">
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
  live,
  onVerify,
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
  live?: {
    state: "checking" | "live" | "broken" | "unknown";
    message?: string;
    latencyMs?: number;
    checkedAt?: string;
  };
  onVerify: () => void;
}) {
  const isList = density === "list";
  const state = live?.state ?? "unknown";
  const dotClass =
    state === "live"
      ? "live-dot live-dot-ok"
      : state === "broken"
        ? "live-dot live-dot-bad"
        : state === "checking"
          ? "live-dot live-dot-checking"
          : "live-dot live-dot-idle";
  const stateLabel =
    state === "live"
      ? live?.latencyMs
        ? `Live · ${live.latencyMs}ms`
        : "Live"
      : state === "checking"
        ? live?.message ?? "Checking…"
        : state === "broken"
          ? "Broken"
          : "Not checked";
  const stateTitle = live?.message
    ? `${stateLabel} — ${live.message}`
    : stateLabel;

  return (
    <div className={`vault-card group ${selected ? "vault-card-selected" : ""} ${isList ? "vault-card-list" : ""}`}>
      {/* Cover */}
      {!isList && (
        <div className="relative h-40 w-full overflow-hidden bg-[#0f0d0b]">
          {entry.image ? (
            <img
              src={entry.image}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.04]"
              onError={(ev) => {
                (ev.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/[0.04] to-black/40 apple-title text-[42px] font-semibold text-white/15">
              {entry.title.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0d0c0b] via-[#0d0c0b]/40 to-transparent" />
          <label
            className="absolute left-2.5 top-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/15 bg-black/50 backdrop-blur-md"
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
            <span className="absolute right-2.5 top-2.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 font-mono text-[11px] font-medium text-amber-300 backdrop-blur-md">
              /{entry.alias}
            </span>
          )}
          <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/55 px-2 py-1 text-[11.5px] text-white/75 backdrop-blur-md">
            {faviconFor(entry.destination) && (
              <img
                src={faviconFor(entry.destination)}
                alt=""
                className="h-3.5 w-3.5 rounded-[3px]"
              />
            )}
            <span className="font-medium">{hostOf(entry.destination)}</span>
          </div>
        </div>
      )}

      <div className="p-4 sm:p-5">
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
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#0f0d0b]">
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
                  <div className="flex h-full w-full items-center justify-center apple-title text-sm font-semibold text-white/25">
                    {entry.title.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="apple-title line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-white sm:text-[16px]">
              {entry.title}
            </h3>
            <a
              href={entry.shortUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 block truncate font-mono text-[12.5px] font-medium text-amber-400/90 hover:text-amber-300"
            >
              {entry.shortUrl}
            </a>
            {isList && entry.alias && (
              <span className="mt-1.5 inline-block rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] font-medium text-amber-300">
                /{entry.alias}
              </span>
            )}
          </div>
          <button
            onClick={onDelete}
            className="apple-icon-btn opacity-0 transition group-hover:opacity-100 hover:bg-red-500/15 hover:text-red-300"
            title="Delete"
            aria-label="Delete"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <button onClick={onCopyAll} className="apple-chip apple-chip-primary apple-chip-lg">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy everything
          </button>
          <button onClick={() => onCopyField(entry.shortUrl)} className="apple-chip">Short</button>
          <button onClick={() => onCopyField(entry.destination)} className="apple-chip">Dest</button>
          {entry.image && (
            <button onClick={() => onCopyField(entry.image)} className="apple-chip">Image</button>
          )}
          <button
            onClick={onToggleQr}
            className={`apple-chip ml-auto ${qrOpen ? "apple-chip-active" : ""}`}
            title="QR code"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            QR
          </button>
        </div>

        {qrOpen && (
          <div className="mt-3.5 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="rounded-lg bg-white p-2 shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
              <QRCodeSVG value={entry.shortUrl} size={92} level="M" bgColor="#ffffff" fgColor="#000000" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] font-medium uppercase tracking-[0.14em] text-white/40">
                Scannable link
              </div>
              <div className="mt-1 truncate font-mono text-[13px] text-amber-300">
                {entry.shortUrl}
              </div>
              <button onClick={() => onCopyField(entry.shortUrl)} className="apple-chip mt-2">
                Copy link
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}