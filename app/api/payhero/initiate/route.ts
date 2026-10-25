import { NextResponse } from "next/server";

export const runtime = "nodejs";

const PAYHERO_BASE_URL = process.env.PAYHERO_BASE_URL || "https://backend.payhero.co.ke";
// PayHero credentials
const PAYHERO_AUTH_TOKEN =
  process.env.PAYHERO_AUTH_TOKEN ||
  "Basic MldRbklMTkRMYUk3czhubXh1YTI6dEU0SnZkSnZncEp4M0lCQTdpYU90NTFSaDBnR0RTcElYQWRTamU0aw==";
const PAYHERO_CHANNEL_ID = Number(process.env.PAYHERO_CHANNEL_ID) || 14277;

function normalizePhoneNumber(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const cleaned = String(phone).replace(/\D/g, "");

  // If already in international format
  if (cleaned.startsWith("254") && cleaned.length === 12) {
    return cleaned;
  }

  // If starts with a leading zero (e.g., 0712345678)
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    return `254${cleaned.slice(1)}`;
  }

  // If local Kenya format without leading zero (e.g., 712345678)
  if ((cleaned.startsWith("7") || cleaned.startsWith("1")) && cleaned.length === 9) {
    return `254${cleaned}`;
  }

  // +25407XXXXXXXX typed → stripped = 25407XXXXXXXX (13 digits) — remove the extra 0
  if (cleaned.startsWith("2540") && cleaned.length === 13) {
    return `254${cleaned.slice(4)}`;
  }

  // 11-digit 254 prefix — pass through
  if (cleaned.startsWith("254") && cleaned.length === 11) {
    return cleaned;
  }

  return null;
}

function getAuthHeader(): string {
  return PAYHERO_AUTH_TOKEN;
}

function extractReference(data: Record<string, unknown>): string | null {
  const direct =
    data.reference ??
    data.Reference ??
    data.checkoutId ??
    data.checkoutRequestId ??
    data.CheckoutRequestID;
  if (typeof direct === "string" && direct.trim()) return direct;

  const nested = data.data;
  if (nested && typeof nested === "object") {
    const nestedObj = nested as Record<string, unknown>;
    const nestedRef =
      nestedObj.reference ??
      nestedObj.Reference ??
      nestedObj.checkoutId ??
      nestedObj.checkoutRequestId ??
      nestedObj.CheckoutRequestID;
    if (typeof nestedRef === "string" && nestedRef.trim()) return nestedRef;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

    const rawPhone =
      (typeof body?.phone === "string" ? body.phone : undefined) ??
      (typeof body?.phoneNumber === "string" ? body.phoneNumber : undefined) ??
      (typeof body?.phone_number === "string" ? body.phone_number : undefined) ??
      (typeof body?.msisdn === "string" ? body.msisdn : undefined);

    const normalizedPhone = normalizePhoneNumber(rawPhone);
    if (!normalizedPhone) {
      return NextResponse.json({ success: false, message: "Invalid phone number format" }, { status: 400 });
    }

    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: "Invalid amount" }, { status: 400 });
    }

    const channelId = PAYHERO_CHANNEL_ID;
    const referencePrefix =
      typeof body?.referencePrefix === "string" ? body.referencePrefix : "SUPERPORTAL";
    const externalReference =
      typeof body?.reference === "string" && body.reference.trim()
        ? body.reference
        : `${referencePrefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const payload = {
      amount: Math.round(amount),
      phone_number: normalizedPhone,
      channel_id: channelId,
      provider: "m-pesa",
      external_reference: externalReference,
      customer_name: typeof body?.customer_name === "string" ? body.customer_name : undefined,
      description: typeof body?.description === "string" ? body.description : "onboarding fee",
    };

    const payheroRes = await fetch(`${PAYHERO_BASE_URL}/api/v2/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: getAuthHeader(),
      },
      body: JSON.stringify(payload),
    });

    const data = (await payheroRes.json().catch(() => null)) as Record<string, unknown> | null;

    if (!payheroRes.ok || !data) {
      return NextResponse.json(
        {
          success: false,
          message:
            (typeof data?.message === "string" ? data.message : null) ??
            (typeof data?.error === "string" ? data.error : null) ??
            "Payment initiation failed",
          raw: data,
        },
        { status: payheroRes.status || 502 },
      );
    }

    const checkoutId = extractReference(data);
    const success =
      data.success === true ||
      String(data.status ?? "").toLowerCase() === "success" ||
      Boolean(checkoutId);

    if (!success || !checkoutId) {
      return NextResponse.json(
        {
          success: false,
          message:
            (typeof data.message === "string" ? data.message : null) ?? "Payment initiation failed",
          raw: data,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      checkoutId,
      checkoutRequestId: checkoutId,
      reference: externalReference,
      normalizedPhone,
      message: typeof data.message === "string" ? data.message : "STK push initiated",
      raw: data,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unexpected server error",
      },
      { status: 500 },
    );
  }
}
