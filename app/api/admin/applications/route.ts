import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const includeIncomplete = url.searchParams.get("include_incomplete") === "true";

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("applications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(2000);

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const rawList = (data || []) as any[];

    // -----------------------------------------------------------------------
    // IMPORTANT: Every row in the DB is an INDEPENDENT applicant.
    // Staff numbers CAN be shared by different people — do NOT deduplicate
    // by staff_number or full_name across different DB rows.
    // Only exclude records that have NO ID uploaded at all (both paths null).
    // When includeIncomplete=true, return everything regardless of ID.
    // -----------------------------------------------------------------------
    const validList = includeIncomplete
      ? rawList
      : rawList.filter((r) => r.id_front_path || r.id_back_path);

    // Deduplicate only by exact DB row id (safety net against accidental
    // duplicated fetches — each DB id is unique by definition).
    const seen = new Set<string>();
    const deduplicated: any[] = [];
    for (const r of validList) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      deduplicated.push(r);
    }

    // Sort: Paid first, then by latest created_at
    deduplicated.sort((a, b) => {
      if (a.payment_completed !== b.payment_completed) {
        return a.payment_completed ? -1 : 1;
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return NextResponse.json({ ok: true, data: deduplicated });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const { id, is_used } = body || {};

    if (!id || typeof is_used !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: id and boolean is_used" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("applications")
      .update({
        is_used,
        used_at: is_used ? new Date().toISOString() : null,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

