import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase.server";

export const runtime = "nodejs";

type SubmitBody = {
  applicationId?: string; // If provided, UPDATE this specific row (same person re-submitting)
  user: {
    employer: "carrefour" | "quickmart" | "naivas";
    fullName: string;
    staffNumber: string;
    position: string;
    branch?: string;
  };
  onb: {
    photoDataUrl?: string;
    idFrontDataUrl?: string;
    idFrontPath?: string;
    idBackDataUrl?: string;
    idBackPath?: string;
    uniformSize?: string;
    uniformTypes?: string[];
    lockerRequested?: boolean;
    lockerKeys?: number;
    trainingAccepted?: boolean;
    trainingReviewed?: boolean;
    badgeSubmitted?: boolean;
    contractDownloaded?: boolean;
    paymentCompleted?: boolean;
    paymentRef?: string;
    paymentPhone?: string;
    paymentAt?: string;
    paymentAmount?: number;
  };
};

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string; ext: string } {
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!m) throw new Error("Invalid data URL");
  const mime = m[1];
  const b64 = m[2];
  const buffer = Buffer.from(b64, "base64");
  // Support common mobile formats (iOS may give HEIC/HEIF, some browsers give WEBP).
  const ext = (() => {
    if (mime === "image/png") return "png";
    if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
    if (mime === "image/webp") return "webp";
    if (mime === "image/heic") return "heic";
    if (mime === "image/heif") return "heif";
    if (mime === "application/pdf") return "pdf";
    // Fallback: use subtype as extension (sanitized)
    const subtype = mime.split("/")[1] || "bin";
    return subtype.replace(/[^a-z0-9]+/gi, "").toLowerCase() || "bin";
  })();
  return { buffer, mime, ext };
}

async function uploadIfPresent(opts: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  bucket: string;
  folder: string;
  name: string;
  dataUrl?: string;
}) {
  const { supabase, bucket, folder, name, dataUrl } = opts;
  if (!dataUrl) return null;
  const { buffer, mime, ext } = dataUrlToBuffer(dataUrl);
  const path = `${folder}/${name}.${ext}`;

  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType: mime,
    upsert: true,
  });
  if (error) throw error;
  return path;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as SubmitBody | null;
    if (!body?.user?.employer || !body?.user?.fullName || !body?.user?.staffNumber || !body?.user?.position) {
      return NextResponse.json({ ok: false, error: "Missing required user fields" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const employer = body.user.employer.trim().toLowerCase();
    const staffNumber = body.user.staffNumber.trim().toUpperCase();
    const fullName = body.user.fullName.trim();

    // -------------------------------------------------------------------------
    // STRATEGY:
    //   - If the client provides an applicationId, this is the SAME person
    //     updating their own record → UPDATE by id.
    //   - If no applicationId, treat this as a NEW independent applicant and
    //     INSERT a new row. Multiple people CAN share the same staff number.
    //     We do NOT collapse them via upsert on (employer, staff_number).
    // -------------------------------------------------------------------------

    // Unique folder per submission so files from different people never overwrite each other
    const sanitize = (v: string) => v.replace(/[^a-z0-9_-]+/gi, "_");
    const folder = `${employer}/${sanitize(staffNumber)}_${sanitize(fullName)}/${Date.now()}`;

    // Upload images (optional if already stored as paths)
    const photo_path = await uploadIfPresent({
      supabase,
      bucket: "applications",
      folder,
      name: "photo",
      dataUrl: body.onb?.photoDataUrl,
    });
    const id_front_path = body.onb?.idFrontPath ?? (await uploadIfPresent({
      supabase,
      bucket: "applications",
      folder,
      name: "id_front",
      dataUrl: body.onb?.idFrontDataUrl,
    }));
    const id_back_path = body.onb?.idBackPath ?? (await uploadIfPresent({
      supabase,
      bucket: "applications",
      folder,
      name: "id_back",
      dataUrl: body.onb?.idBackDataUrl,
    }));

    // Build the shared payload fields
    const basePayload: Record<string, any> = {
      employer,
      full_name: fullName,
      staff_number: staffNumber,
      position: body.user.position.trim(),
      branch: body.user.branch?.trim() ?? null,
      updated_at: new Date().toISOString(),
    };

    if (body.onb?.uniformSize !== undefined) basePayload.uniform_size = body.onb.uniformSize;
    if (body.onb?.uniformTypes !== undefined) basePayload.uniform_types = body.onb.uniformTypes;
    if (body.onb?.lockerRequested !== undefined) basePayload.locker_requested = !!body.onb.lockerRequested;
    if (body.onb?.lockerKeys !== undefined) basePayload.locker_keys = body.onb.lockerKeys;
    if (body.onb?.trainingAccepted !== undefined) basePayload.training_accepted = !!body.onb.trainingAccepted;
    if (body.onb?.trainingReviewed !== undefined) basePayload.training_reviewed = !!body.onb.trainingReviewed;
    if (body.onb?.badgeSubmitted !== undefined) basePayload.badge_submitted = !!body.onb.badgeSubmitted;
    if (body.onb?.contractDownloaded !== undefined) basePayload.contract_downloaded = !!body.onb.contractDownloaded;

    if (body.onb?.paymentRef !== undefined) basePayload.payment_ref = body.onb.paymentRef;
    if (body.onb?.paymentPhone !== undefined) basePayload.payment_phone = body.onb.paymentPhone;
    if (body.onb?.paymentAt) basePayload.payment_at = new Date(body.onb.paymentAt).toISOString();
    if (body.onb?.paymentAmount !== undefined) basePayload.payment_amount = body.onb.paymentAmount;

    // Preserve IDs & photos regardless of whether payment has been completed
    if (photo_path) basePayload.photo_path = photo_path;
    if (id_front_path) basePayload.id_front_path = id_front_path;
    if (id_back_path) basePayload.id_back_path = id_back_path;

    // ---- UPDATE existing row (same person re-submitting with their applicationId) ----
    if (body.applicationId) {
      // Fetch existing row to merge/preserve payment and file paths
      const { data: existing } = await supabase
        .from("applications")
        .select("id, id_front_path, id_back_path, photo_path, payment_completed, payment_ref, payment_phone, payment_at, payment_amount")
        .eq("id", body.applicationId)
        .single();

      const updatePayload = { ...basePayload };

      // Merge: preserve existing values if new values not provided
      if (!id_front_path && existing?.id_front_path) updatePayload.id_front_path = existing.id_front_path;
      if (!id_back_path && existing?.id_back_path) updatePayload.id_back_path = existing.id_back_path;
      if (!photo_path && existing?.photo_path) updatePayload.photo_path = existing.photo_path;
      if (!body.onb?.paymentRef && existing?.payment_ref) updatePayload.payment_ref = existing.payment_ref;
      if (!body.onb?.paymentPhone && existing?.payment_phone) updatePayload.payment_phone = existing.payment_phone;
      if (!body.onb?.paymentAt && existing?.payment_at) updatePayload.payment_at = existing.payment_at;
      if (body.onb?.paymentAmount === undefined && existing?.payment_amount) updatePayload.payment_amount = existing.payment_amount;

      // Payment: stays completed once it has been set to completed
      updatePayload.payment_completed = !!(body.onb?.paymentCompleted || existing?.payment_completed);

      const { data, error } = await supabase
        .from("applications")
        .update(updatePayload)
        .eq("id", body.applicationId)
        .select("id, created_at")
        .single();

      if (error) {
        console.error("[applications/submit] Supabase update error:", error.message, error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, applicationId: data.id, createdAt: data.created_at });
    }

    // ---- INSERT new independent applicant row ----
    // NOTE: The DB unique constraint on (employer, staff_number) must be DROPPED
    // or handled at the DB level. We INSERT regardless — two people CAN have the
    // same staff number and must be stored as independent records.
    const insertPayload = {
      ...basePayload,
      payment_completed: !!body.onb?.paymentCompleted,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("applications")
      .insert(insertPayload)
      .select("id, created_at")
      .single();

    if (error) {
      console.error("[applications/submit] Supabase insert error:", error.message, error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, applicationId: data.id, createdAt: data.created_at });
  } catch (e: any) {
    console.error("[applications/submit] Unexpected error:", e?.message, e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
