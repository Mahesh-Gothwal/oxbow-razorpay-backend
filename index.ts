import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ── CORS ──
const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.some((allowed) => origin!.startsWith(allowed!))) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ── Razorpay ──
let razorpay: Razorpay | null = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} else {
  console.warn("⚠️ Razorpay keys not set");
}

// ── Check Resend API key ──
if (process.env.RESEND_API_KEY) {
  console.log("✅ Resend email ready");
} else {
  console.warn("⚠️ RESEND_API_KEY not set — emails won't send");
}

// ── In-memory store ──
const verifiedPayments = new Set<string>();

// ── Health check ──
app.get("/", (_req, res) => res.json({ status: "ok", service: "oxbow-razorpay" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ── Create Order ──
app.post("/api/create-order", async (req, res) => {
  if (!razorpay) return res.status(500).json({ error: "Razorpay not configured" });
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: { product: "Oxbow Creatives Digital Product" },
    });
    res.json({ id: order.id, amount: order.amount, currency: order.currency });
  } catch (error) {
    console.error("Order creation failed:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ── Verify Payment + Send Email ──
app.post("/api/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      buyer_email,
      buyer_name,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ verified: false, error: "Missing fields" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ verified: false, error: "Invalid signature" });
    }

    verifiedPayments.add(razorpay_payment_id);
    console.log(`✅ Payment verified: ${razorpay_payment_id} | ${buyer_email}`);

    // Send email (non-blocking)
    if (buyer_email) {
      sendDownloadEmail(buyer_email, buyer_name || "Customer", razorpay_payment_id)
        .then(() => console.log(`📧 Email sent to ${buyer_email}`))
        .catch((err) => console.error(`📧 Email failed:`, err));
    }

    res.json({ verified: true, payment_id: razorpay_payment_id });
  } catch (error) {
    console.error("Verification failed:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ═══════════════════════════════════════════════
// SEND EMAIL VIA RESEND (HTTP API — no SMTP needed)
// ═══════════════════════════════════════════════
async function sendDownloadEmail(email: string, name: string, paymentId: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ RESEND_API_KEY not set, skipping email");
    return;
  }

  const downloadUrl = process.env.DOWNLOAD_URL || "https://oxbowcreatives.com/secure-downloads/sections.zip";
  const brandName = "Oxbow Creatives";
  const productName = "Ultimate SaaS UI Kit";
  const fromEmail = process.env.FROM_EMAIL || "onboarding@resend.dev";

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">

    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="color:#ffdf29;font-size:24px;margin:0;">${brandName}</h1>
    </div>

    <div style="background:#111111;border:1px solid #1e1e1e;border-radius:16px;padding:32px 24px;text-align:center;">
      <div style="width:56px;height:56px;border-radius:50%;background:rgba(34,197,94,0.15);margin:0 auto 20px;line-height:56px;font-size:28px;">✅</div>
      <h2 style="color:#ffffff;font-size:22px;margin:0 0 8px;">Payment Successful!</h2>
      <p style="color:#9ca3af;font-size:14px;margin:0 0 24px;">
        Hi ${name}, thank you for purchasing <strong style="color:#ffffff;">${productName}</strong>.
      </p>
      <a href="${downloadUrl}"
         style="display:inline-block;background:#ffdf29;color:#0a0a0a;font-weight:700;font-size:16px;padding:14px 32px;border-radius:12px;text-decoration:none;">
        ⬇ Download Your Files
      </a>
      <p style="color:#9ca3af;font-size:12px;margin:16px 0 0;">
        This link will always work. Save this email for future access.
      </p>
    </div>

    <div style="background:#111111;border:1px solid #1e1e1e;border-radius:12px;padding:20px 24px;margin-top:16px;">
      <h3 style="color:#ffffff;font-size:14px;margin:0 0 12px;">Order Details</h3>
      <table style="width:100%;font-size:13px;">
        <tr><td style="color:#9ca3af;padding:4px 0;">Product</td><td style="color:#ffffff;text-align:right;padding:4px 0;">${productName}</td></tr>
        <tr><td style="color:#9ca3af;padding:4px 0;">Payment ID</td><td style="color:#ffffff;text-align:right;padding:4px 0;font-family:monospace;font-size:11px;">${paymentId}</td></tr>
        <tr><td style="color:#9ca3af;padding:4px 0;">Access</td><td style="color:#22c55e;text-align:right;padding:4px 0;font-weight:600;">Lifetime</td></tr>
      </table>
    </div>

    <div style="text-align:center;margin-top:24px;">
      <p style="color:#4b5563;font-size:11px;margin:12px 0 0;">
        © ${new Date().getFullYear()} ${brandName}. All rights reserved.
      </p>
    </div>
  </div>
</body>
</html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${brandName} <${fromEmail}>`,
      to: [email],
      subject: `Your download is ready — ${productName}`,
      html: htmlBody,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Resend API error ${response.status}: ${errorData}`);
  }

  const result = await response.json();
  return result;
}

// ── Webhook (backup email) ──
app.post("/api/razorpay-webhook", (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: "Webhook secret not configured" });

  const signature = req.headers["x-razorpay-signature"] as string;
  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex");

  if (signature !== expectedSignature) {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const event = req.body.event;
  const payload = req.body.payload;

  if (event === "payment.captured") {
    console.log("💰 Webhook: payment captured:", payload.payment.entity.id);
    verifiedPayments.add(payload.payment.entity.id);
    if (payload.payment.entity.email) {
      sendDownloadEmail(
        payload.payment.entity.email,
        payload.payment.entity.notes?.buyer_name || "Customer",
        payload.payment.entity.id
      ).catch((err) => console.error("Webhook email failed:", err));
    }
  }

  res.json({ status: "ok" });
});

// ── Start ──
const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
