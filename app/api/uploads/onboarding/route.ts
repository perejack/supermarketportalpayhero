import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase.server";

export const runtime = "nodejs";

type UploadField = "id_front" | "id_back";

function sanitizeSegment(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "_");
}

function extensionFromFile(file: File): string {
  const mime = file.type.toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";

  const nameExt = file.name.split(".").pop()?.toLowerCase();
  return nameExt?.replace(/[^a-z0-9]+/g, "") || "jpg";
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const employer = String(form.get("employer") || "").trim().toLowerCase();
    const staffNumber = String(form.get("staffNumber") || "").trim().toUpperCase();
    const fullName = String(form.get("fullName") || "").trim();
    const field = String(form.get("field") || "").trim() as UploadField;
    // Optional: existing applicationId to update this specific row in DB
    const applicationId = String(form.get("applicationId") || "").trim() || null;

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
    }
    if (!employer || !staffNumber || !field) {
      return NextResponse.json({ ok: false, error: "Missing upload details" }, { status: 400 });
    }
    if (!["id_front", "id_back"].includes(field)) {
      return NextResponse.json({ ok: false, error: "Invalid upload field" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ ok: false, error: "Only image uploads are supported" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const ext = extensionFromFile(file);

    // Include fullName in path so different people with the same staff number
    // do NOT overwrite each other's ID files in storage.
    const nameSegment = fullName ? `_${sanitizeSegment(fullName)}` : "";
    const path = `staged/${sanitizeSegment(employer)}/${sanitizeSegment(staffNumber)}${nameSegment}/${field}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error } = await supabase.storage.from("applications").upload(path, buffer, {
      contentType: file.type || "application/octet-stream",
      upsert: true,
    });

    if (error) {
      console.error("[uploads/onboarding] Supabase storage error:", error.message, error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // Auto-update the applications record in database if we know which row to update.
    // Prefer updating by specific applicationId (avoids wrong-row updates when staff
    // numbers are shared between different people).
    const fieldColumn = field === "id_front" ? "id_front_path" : "id_back_path";
    try {
      if (applicationId) {
        // Update the specific applicant's row by ID
        await supabase
          .from("applications")
          .update({
            [fieldColumn]: path,
            updated_at: new Date().toISOString(),
          })
          .eq("id", applicationId);
      } else if (employer && staffNumber) {
        // Fallback: update by employer + staff_number (works when only one person has that number)
        await supabase
          .from("applications")
          .update({
            [fieldColumn]: path,
            updated_at: new Date().toISOString(),
          })
          .eq("employer", employer)
          .ilike("staff_number", staffNumber);
      }
    } catch (dbErr) {
      console.warn("[uploads/onboarding] Optional db update warning:", dbErr);
    }

    return NextResponse.json({ ok: true, path });
  } catch (e: any) {
    console.error("[uploads/onboarding] Unexpected error:", e?.message, e);
    return NextResponse.json({ ok: false, error: e?.message || "Upload failed" }, { status: 500 });
  }
}
