import { createServerFn } from "@tanstack/react-start";
import { useSession, getRequest } from "@tanstack/react-start/server";
import { createHash, timingSafeEqual } from "node:crypto";

export type LinkEntry = {
  id: string;
  title: string;
  alias: string;
  destination: string;
  image: string;
  shortUrl: string;
  createdAt: number;
};

type GateSession = { unlocked?: boolean; user?: string };

function sessionConfig() {
  return {
    password: process.env.SESSION_SECRET!,
    name: "freekitaab-gate",
    maxAge: 60 * 60 * 24 * 30, // 30 days — stays signed in across browsers/sessions
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      path: "/",
    },
  };
}

function passwordMatches(input: string, expected: string) {
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

async function getSession() {
  return useSession<GateSession>(sessionConfig());
}

// Preview / local dev bypass — vault opens without a password on the
// Lovable preview host or localhost. Published production stays gated.
function isPreviewHost(): boolean {
  try {
    const req = getRequest();
    const host = req?.headers.get("host") ?? "";
    return (
      host.includes("id-preview--") ||
      host.includes("-dev.lovable.app") ||
      host.startsWith("localhost") ||
      host.startsWith("127.0.0.1")
    );
  } catch {
    return false;
  }
}

function rowToEntry(r: {
  id: string;
  title: string;
  alias: string | null;
  destination: string;
  image_url: string | null;
  short_url: string | null;
  created_at: string;
}): LinkEntry {
  return {
    id: r.id,
    title: r.title,
    alias: r.alias ?? "",
    destination: r.destination,
    image: r.image_url ?? "",
    shortUrl: r.short_url ?? "",
    createdAt: new Date(r.created_at).getTime(),
  };
}

export const getGateState = createServerFn({ method: "GET" }).handler(async () => {
  const session = await getSession();
  const bypass = isPreviewHost();
  if (!session.data.unlocked && !bypass) {
    return { unlocked: false as const };
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("links")
    .select("id,title,alias,destination,image_url,short_url,created_at,deleted_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const active = (data ?? []).filter((r) => !r.deleted_at);
  const trashCount = (data ?? []).length - active.length;
  return {
    unlocked: true as const,
    user: session.data.user ?? (bypass ? "Lakshay" : ""),
    entries: active.map(rowToEntry),
    trashCount,
  };
});

export const unlockSite = createServerFn({ method: "POST" })
  .inputValidator((data: { username: string; password: string }) => data)
  .handler(async ({ data }) => {
    const expected = process.env.SITE_PASSWORD;
    if (!expected) throw new Error("Server is missing SITE_PASSWORD");
    if (!data.password || !passwordMatches(data.password, expected)) {
      return { ok: false as const };
    }
    const session = await getSession();
    await session.update({ unlocked: true, user: data.username?.trim() || "guest" });
    return { ok: true as const };
  });

export const lockSite = createServerFn({ method: "POST" }).handler(async () => {
  const session = await getSession();
  await session.clear();
  return { ok: true as const };
});

async function requireUnlocked() {
  const session = await getSession();
  if (!session.data.unlocked && !isPreviewHost()) throw new Error("Locked");
}

export const saveLink = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      title: string;
      alias: string;
      destination: string;
      image: string;
      shortUrl: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("links")
      .insert({
        title: data.title,
        alias: data.alias || null,
        destination: data.destination,
        image_url: data.image || null,
        short_url: data.shortUrl || null,
      })
      .select("id,title,alias,destination,image_url,short_url,created_at")
      .single();
    if (error) throw new Error(error.message);
    return rowToEntry(row);
  });

export const deleteLink = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Soft-delete → moves to trash instead of destroying the record.
    const { error } = await supabaseAdmin
      .from("links")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const getTrash = createServerFn({ method: "GET" }).handler(async () => {
  await requireUnlocked();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("links")
    .select("id,title,alias,destination,image_url,short_url,created_at,deleted_at")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToEntry);
});

export const restoreLink = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("links")
      .update({ deleted_at: null })
      .eq("id", data.id)
      .select("id,title,alias,destination,image_url,short_url,created_at")
      .single();
    if (error) throw new Error(error.message);
    return rowToEntry(row);
  });

export const purgeLink = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("links").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const emptyTrash = createServerFn({ method: "POST" }).handler(async () => {
  await requireUnlocked();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("links")
    .delete()
    .not("deleted_at", "is", null);
  if (error) throw new Error(error.message);
  return { ok: true as const };
});