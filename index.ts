// ─────────────────────────────────────────────────────────
// server/index.ts — Production Razorpay backend for Render
// ─────────────────────────────────────────────────────────

import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ── Parse JSON body (needed for webhook raw body verification too) ──
app.use(express.json());

// ── CORS — allow your GoDaddy frontend domain ──
const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  // Add your GoDaddy domain here if different from FRONTEND_URL
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, webhooks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.some((allowed) => origin.startsWith(allowed!))) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ── Initialize Razorpay ──
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// ── In-memory store (replace with a database in production!) ──
// For a simple single-product store, this works on Render's free tier.
// If Render restarts, this resets — use a DB (Supabase, PlanetScale, etc.)
// for persistence.
const verifiedPayments = new Set<string>();

// ── Health check (Render uses this to know your server is alive) ──
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "oxbow-razorpay" });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ─────────────────────────────────────────────
// ROUTE 1: Create Order
// ─────────────────────────────────────────────
app.post("/api/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const order = await razorpay.orders.create({
      amount: amount, // in paise (99900 = ₹999)
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: {
        product: "Oxbow Creatives Digital Product",
      },
    });

    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error("Order creation failed:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2: Verify Payment
// ─────────────────────────────────────────────
app.post("/api/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ verified: false, error: "Missing fields" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      verifiedPayments.add(razorpay_payment_id);
      console.log(`✅ Payment verified: ${razorpay_payment_id}`);
      res.json({ verified: true, payment_id: razorpay_payment_id });
    } else {
      console.warn(`❌ Invalid signature for: ${razorpay_payment_id}`);
      res.status(400).json({ verified: false, error: "Invalid signature" });
    }
  } catch (error) {
    console.error("Verification failed:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ─────────────────────────────────────────────
// ROUTE 3: Secure File Download
// ─────────────────────────────────────────────
app.post("/api/download", (req, res) => {
  const { payment_id } = req.body;

  if (!payment_id || !verifiedPayments.has(payment_id)) {
    return res.status(403).json({ error: "Payment not verified" });
  }

  const filePath = path.resolve(__dirname, "../downloads/sections.zip");

  res.download(filePath, "sections.zip", (err) => {
    if (err) {
      console.error("Download error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Download failed" });
      }
    }
  });
});

// ─────────────────────────────────────────────
// ROUTE 4: Razorpay Webhook
// ─────────────────────────────────────────────
app.post("/api/razorpay-webhook", (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

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

  switch (event) {
    case "payment.captured":
      console.log("💰 Payment captured:", payload.payment.entity.id);
      verifiedPayments.add(payload.payment.entity.id);
      break;
    case "payment.failed":
      console.log("❌ Payment failed:", payload.payment.entity.id);
      break;
  }

  res.json({ status: "ok" });
});

// ── Start server ──
const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Razorpay server running on port ${PORT}`);
});
