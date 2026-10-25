import { NextResponse } from "next/server";

export const runtime = "nodejs";

const PAYHERO_BASE_URL = process.env.PAYHERO_BASE_URL || "https://backend.payhero.co.ke";
// PayHero credentials
const PAYHERO_AUTH_TOKEN =
  process.env.PAYHERO_AUTH_TOKEN ||
  "Basic MldRbklMTkRMYUk3czhubXh1YTI6dEU0SnZkSnZncEp4M0lCQTdpYU90NTFSaDBnR0RTcElYQWRTamU0aw==";

function getAuthHeader(): string {
  return PAYHERO_AUTH_TOKEN;
}

function mapPayheroStatus(rawStatus: string): "paid" | "failed" | "pending" {
  const status = rawStatus.toUpperCase();
  if (status === "SUCCESS" || status === "COMPLETED" || status === "PAID") return "paid";
  if (status === "FAILED" || status === "CANCELLED" || status === "CANCELED") return "failed";
  return "pending";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

    const reference =
      (typeof body?.checkoutId === "string" ? body.checkoutId : undefined) ??
      (typeof body?.checkoutRequestId === "string" ? body.checkoutRequestId : undefined) ??
      (typeof body?.checkoutid === "string" ? body.checkoutid : undefined) ??
      (typeof body?.reference === "string" ? body.reference : undefined);

    if (!reference?.trim()) {
      return NextResponse.json(
        { status: "error", message: "Missing checkoutId/reference" },
        { status: 400 },
      );
    }

    const payheroRes = await fetch(
      `${PAYHERO_BASE_URL}/api/v2/transaction-status?reference=${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: { Authorization: getAuthHeader() },
      },
    );

    const data = (await payheroRes.json().catch(() => null)) as Record<string, unknown> | null;

    if (!payheroRes.ok || !data) {
      return NextResponse.json(
        {
          status: "error",
          message:
            (typeof data?.message === "string" ? data.message : null) ??
            (typeof data?.error === "string" ? data.error : null) ??
            "Status check failed",
          raw: data,
        },
        { status: payheroRes.status || 502 },
      );
    }

    const rawStatus = String(data.status ?? data.Status ?? "").trim();
    const mappedStatus = mapPayheroStatus(rawStatus);
    const success = data.success === true || mappedStatus === "paid";

    return NextResponse.json({
      success,
      status: mappedStatus,
      state: mappedStatus === "paid" ? "success" : mappedStatus === "failed" ? "failed" : "pending",
      rawStatus,
      resultDesc:
        (typeof data.message === "string" ? data.message : "") ||
        (typeof data.resultDesc === "string" ? data.resultDesc : "") ||
        rawStatus,
      receiptNumber:
        (typeof data.provider_reference === "string" ? data.provider_reference : null) ??
        (typeof data.third_party_reference === "string" ? data.third_party_reference : null) ??
        (typeof data.payment_reference === "string" ? data.payment_reference : null),
      raw: data,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Unexpected server error",
      },
      { status: 500 },
    );
  }
}
