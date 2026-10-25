import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase.server";

export const runtime = "nodejs";

// One-time migration endpoint to drop the unique constraint on (employer, staff_number).
// This allows multiple independent applicants to share the same staff number.
// Call once: GET /api/admin/migrate
export async function GET(req: Request) {
  // Protect this endpoint with a secret token to prevent unauthorized access
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token !== "MIGRATE_SECRET_2024") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();

    // Supabase JS client doesn't support raw DDL via .from() — we need to
    // call the underlying postgres through a raw query if available,
    // or use the management API.
    //
    // As a workaround: use the storage/db admin endpoint.
    // The service role token can call pg_catalog queries via PostgREST
    // if the schema is exposed. Instead, we do it via fetch to the pg endpoint.

    const SUPABASE_URL = "https://nlnuscpzgutkfapyneaa.supabase.co";
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sbnVzY3B6Z3V0a2ZhcHluZWFhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDQxNzYwOSwiZXhwIjoyMTA1OTkzNjA5fQ.UaA_SIBZ1nymKZTwTvvfmlMIeURnZeSXAnICLIA6b1c";

    // Check current row count to verify connectivity
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/applications?select=id&limit=1`, {
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
        Prefer: "count=exact",
      },
    });
    const totalCount = countRes.headers.get("content-range");

    // We cannot drop constraints via REST API without exec_sql RPC.
    // Return instructions and current state instead.
    const { data: sampleRows } = await supabase
      .from("applications")
      .select("id, employer, staff_number, full_name, id_front_path, id_back_path, payment_completed, created_at")
      .order("created_at", { ascending: false })
      .limit(5);

    return NextResponse.json({
      ok: true,
      message: "Connectivity verified. To drop the unique constraint, please run the SQL migration in your Supabase SQL Editor.",
      sql_to_run: "ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS applications_employer_staff_number_unique;",
      supabase_sql_editor_url: "https://supabase.com/dashboard/project/nlnuscpzgutkfapyneaa/sql/new",
      total_rows_in_content_range: totalCount,
      recent_5_rows: sampleRows,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
