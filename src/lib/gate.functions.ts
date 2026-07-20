import { createServerFn } from "@tanstack/react-start";

export type LinkEntry = {
  id: string;
  title: string;
  alias: string;
  destination: string;
  image: string;
  shortUrl: string;
  createdAt: number;
};

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
  try {
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
      user: "",
      entries: active.map(rowToEntry),
      trashCount,
    };
  } catch (error) {
    console.error(error);
    return {
      unlocked: true as const,
      user: "",
      entries: [] as LinkEntry[],
      trashCount: 0,
    };
  }
});

async function requireUnlocked() {
  // Auth removed — open workspace.
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