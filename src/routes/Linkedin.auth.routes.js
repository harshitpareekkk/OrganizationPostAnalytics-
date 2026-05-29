import express from "express";
import { authorizeRequest } from "../middlewares/authorizeRequest.js";
import {
  installController,
  callbackController,
  providerIdController,
  tokenController,
  webhookController,
  statusController,
  disconnectController,
  healthController,
} from "../controllers/linkedin.auth.controller.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES — No auth required
// Monday or LinkedIn calls these directly via browser redirect or server POST
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/linkedin-auth/health
// No auth — use in Postman to verify env vars are set correctly
router.get("/health", healthController);

// GET /api/linkedin-auth/install?token=<Monday JWT>
// ← Monday calls this when user clicks "Connect LinkedIn" in the automation block
// Set this URL in: Credential feature → Configure OAuth endpoint → Authorization URL
// e.g. https://basaltic-unbantering-karey.ngrok-free.dev/api/linkedin-auth/install
router.get("/install", installController);

// POST /api/linkedin-auth/token
// ← Monday calls this to exchange auth code for LinkedIn token
// SET THIS URL in: Credentials → Configure OAuth endpoint → Access token request URL
//   https://basaltic-unbantering-karey.ngrok-free.dev/api/linkedin-auth/token
// WHY: LinkedIn needs client_id+secret in POST body. Monday sends them as header.
//      This endpoint proxies correctly so LinkedIn accepts it.
router.post("/token", tokenController);

// POST /api/linkedin-auth/provider-id
// ← Monday calls this after it exchanges the LinkedIn auth code for a token
// Set this URL in: Credential feature → Extra details → Provider unique identifier request
// e.g. https://basaltic-unbantering-karey.ngrok-free.dev/api/linkedin-auth/provider-id
// This is where workspace + board creation happens
router.post("/provider-id", providerIdController);

// POST /api/linkedin-auth/webhook
// ← Monday calls this for all app lifecycle events (install, uninstall, subscription changes)
// Set this URL in: Developer Center → Webhooks → All Events URL
// e.g. https://basaltic-unbantering-karey.ngrok-free.dev/api/linkedin-auth/webhook
router.post("/webhook", webhookController);

// GET /api/linkedin-auth/callback
// NOT actively used — Monday handles code exchange via Credentials feature.
// Kept for backward compatibility only.
router.get("/callback", callbackController);

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED ROUTES — Require Monday JWT via Authorization header
// The authorizeRequest middleware verifies the JWT and sets req.session
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/linkedin-auth/status
// Returns current LinkedIn connection status + org pages + board IDs
// Call this from your automation block or frontend to check connection
router.get("/status", authorizeRequest, statusController);

// POST /api/linkedin-auth/disconnect
// Removes stored LinkedIn token for this Monday account (boards are preserved)
router.post("/disconnect", authorizeRequest, disconnectController);

export default router;