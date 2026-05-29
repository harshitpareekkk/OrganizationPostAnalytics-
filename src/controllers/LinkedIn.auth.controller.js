import jwt from "jsonwebtoken";
import axios from "axios";
import { logger } from "../utils/logger.js";
import { StatusCodes } from "../constants/statusCodes.constants.js";
import { getConfig } from "../constants/env.constants.js";
import {
  buildLinkedInAuthUrl,
  fetchLinkedInProfile,
  fetchAdminOrganizations,
  createWorkspaceAndBoards,
  storeLinkedInInstallation,
  getLinkedInInstallation,
} from "../services/linkedin.auth.service.js";

const MONDAY_CREDENTIAL_REDIRECT_URI =
  "https://apps-credentials.monday.com/authorize/oauth2/redirect-uri";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/linkedin-auth/install
// Monday Credentials feature calls this as the Authorization URL.
// ─────────────────────────────────────────────────────────────────────────────
export const installController = async (req, res) => {
  try {
    logger.info(`[linkedin-auth] ── INSTALL ENDPOINT HIT ──`);
    logger.info(`[linkedin-auth] Query: ${JSON.stringify(req.query)}`);

    if (req.query.response_type === "code") {
      logger.info(`[linkedin-auth] ✓ Credentials flow detected`);

      const linkedInUrl = new URL(
        "https://www.linkedin.com/oauth/v2/authorization",
      );
      console.log(linkedInUrl);
      for (const [key, value] of Object.entries(req.query)) {
        linkedInUrl.searchParams.set(key, value);
      }

      logger.info(`[linkedin-auth] Redirecting to LinkedIn OAuth`);
      return res.redirect(linkedInUrl.toString());
    }

    const { token } = req.query;
    if (!token) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: "Missing required parameters",
      });
    }

    const config = getConfig();
    let decoded;
    try {
      decoded = jwt.verify(token, config.MONDAY_SIGNING_SECRET);
    } catch (jwtErr) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: "Invalid Monday token",
      });
    }

    const linkedInAuthUrl = buildLinkedInAuthUrl(
      config.LINKEDIN_CLIENT_ID,
      MONDAY_CREDENTIAL_REDIRECT_URI,
      token,
    );

    return res.redirect(linkedInAuthUrl);
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Install error: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/linkedin-auth/provider-id
//
// Monday calls this after LinkedIn token exchange.
//
// ── HOW BOARDS ARE CREATED IN THE TENANT ACCOUNT (not developer account) ──
//
// Monday's JWT (Authorization header) contains a shortLivedToken claim.
// This shortLivedToken IS a Monday API token already scoped to the TENANT's
// account — using it for API calls automatically routes to the correct account.
//
// Priority for board-creation token:
//   1. decoded.shortLivedToken  ← tenant-scoped, preferred
//   2. MONDAY_APP_TOKEN         ← app-level token from Developer Center + Account-Id
//   3. MONDAY_API_KEY           ← personal token, WRONG account (fallback only)
// ─────────────────────────────────────────────────────────────────────────────
export const providerIdController = async (req, res) => {
  try {
    logger.info(`\n${"═".repeat(60)}`);
    logger.info(`[linkedin-auth] ── PROVIDER-ID ENDPOINT HIT ──`);
    logger.info(`[linkedin-auth] Time: ${new Date().toISOString()}`);
    logger.info(
      `[linkedin-auth] Headers: ${JSON.stringify(req.headers, null, 2)}`,
    );
    logger.info(
      `[linkedin-auth] Raw body: ${JSON.stringify(req.body, null, 2)}`,
    );

    const config = getConfig();
    const body = req.body;
    const authHeader =
      req.headers.authorization || req.headers.Authorization || "";

    // ── Extract accountId + shortLivedToken from Monday JWT ────────────────
    let mondayAccountId = null;
    let mondayUserId = null;
    let mondayShortLivedToken = null;

    const rawJwt = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    if (rawJwt) {
      try {
        const decoded = jwt.verify(rawJwt, config.MONDAY_SIGNING_SECRET);
        mondayAccountId = decoded.accountId;
        mondayUserId = decoded.userId;
        // shortLivedToken is scoped to the TENANT's account — use it for
        // all Monday API calls so boards are created in the correct account.
        mondayShortLivedToken = decoded.shortLivedToken || null;
        logger.info(
          `[linkedin-auth] ✓ JWT verified | accountId: ${mondayAccountId} | userId: ${mondayUserId}`,
        );
        logger.info(
          `[linkedin-auth] shortLivedToken present: ${mondayShortLivedToken ? "✓" : "✗ MISSING"}`,
        );
        logger.info(
          `[linkedin-auth] JWT keys: ${Object.keys(decoded).join(", ")}`,
        );
      } catch (jwtErr) {
        logger.warn(`[linkedin-auth] JWT verify failed: ${jwtErr.message}`);
      }
    }

    // Fallback: accountId also in body root
    if (!mondayAccountId) {
      mondayAccountId = body?.accountId || body?.payload?.accountId || null;
    }
    if (!mondayUserId) {
      mondayUserId = body?.userId || body?.payload?.userId || null;
    }

    if (!mondayShortLivedToken) {
      logger.warn(
        `[linkedin-auth] shortLivedToken not found in JWT — board creation may fail`,
      );
    }

    logger.info(`[linkedin-auth] mondayAccountId: ${mondayAccountId}`);

    // ── Determine which Monday token to use for board creation ─────────────
    //
    // Token priority (both are tenant-scoped):
    //   1. shortLivedToken from the JWT — user OAuth token scoped to the tenant.
    //   2. MONDAY_APP_TOKEN (Developer Center → App Token) + Account-Id header.
    //
    // MONDAY_API_KEY is intentionally NOT used here — it is a personal developer
    // token always scoped to the developer's own account, never the tenant's.
    const mondayAppToken =
      config.MONDAY_APP_TOKEN || process.env.MONDAY_APP_TOKEN;

    const mondayTokenForBoards = mondayShortLivedToken || mondayAppToken;
    const tokenSource = mondayShortLivedToken
      ? "shortLivedToken (tenant-scoped JWT claim)"
      : "MONDAY_APP_TOKEN + Account-Id header";

    logger.info(
      `[linkedin-auth] Monday token for board creation: ${tokenSource}`,
    );

    if (!mondayTokenForBoards) {
      logger.error(
        `[linkedin-auth] ✗ No Monday token available for board creation!`,
      );
    }

    if (!mondayAccountId) {
      logger.error(
        `[linkedin-auth] ✗ mondayAccountId missing — cannot target correct tenant`,
      );
    } else {
      logger.info(
        `[linkedin-auth] ✓ Will create boards in tenant account: ${mondayAccountId}`,
      );
    }

    // ── Extract LinkedIn access token ──────────────────────────────────────
    let linkedInAccessToken = null;
    let tokenExpiresIn = 5183944; // ~60 days

    // Monday sends token as plain string at body.token
    if (typeof body?.token === "string" && body.token.length > 10) {
      linkedInAccessToken = body.token;
      logger.info(`[linkedin-auth] ✓ Token: plain string format`);
    } else if (body?.token?.access_token) {
      linkedInAccessToken = body.token.access_token;
      tokenExpiresIn = body.token.expires_in || tokenExpiresIn;
      logger.info(`[linkedin-auth] ✓ Token: nested object format`);
    } else if (body?.access_token) {
      linkedInAccessToken = body.access_token;
      tokenExpiresIn = body.expires_in || tokenExpiresIn;
      logger.info(`[linkedin-auth] ✓ Token: root access_token format`);
    } else if (body?.data?.token?.access_token) {
      linkedInAccessToken = body.data.token.access_token;
      logger.info(`[linkedin-auth] ✓ Token: data.token format`);
    }

    logger.info(
      `[linkedin-auth] LinkedIn token: ${linkedInAccessToken ? "✓ (" + linkedInAccessToken.substring(0, 20) + "...)" : "✗ MISSING"}`,
    );

    if (!linkedInAccessToken) {
      logger.error(`[linkedin-auth] ✗ Cannot extract LinkedIn access token`);
      return res.status(StatusCodes.OK).json({
        providerUniqueIdentifier: `error_no_token_${Date.now()}`,
        displayName: "Connection failed — no token received",
      });
    }

    // ── Step 1: Fetch LinkedIn profile (fast ~500ms) ───────────────────────
    logger.info(`[linkedin-auth] Fetching LinkedIn profile...`);

    let profile;
    try {
      profile = await fetchLinkedInProfile(linkedInAccessToken);
    } catch (profileErr) {
      logger.error(
        `[linkedin-auth] ✗ Profile fetch failed: ${profileErr.message}`,
      );
      const fallbackId = mondayAccountId
        ? `account_${mondayAccountId}`
        : `fallback_${Date.now()}`;
      return res.status(StatusCodes.OK).json({
        providerUniqueIdentifier: fallbackId,
        displayName: "LinkedIn Account",
      });
    }

    const providerUniqueIdentifier = profile.sub;
    const displayName = profile.name || profile.email || "LinkedIn Account";

    logger.info(
      `[linkedin-auth] ✓ Profile: ${profile.name} | sub: ${providerUniqueIdentifier}`,
    );

    // ── Step 2: Respond to Monday IMMEDIATELY ─────────────────────────────
    // Monday registers the credential and shows name in dropdown right away.
    logger.info(`[linkedin-auth] ✅ Responding to Monday:`);
    logger.info(
      `[linkedin-auth]    providerUniqueIdentifier: ${providerUniqueIdentifier}`,
    );
    logger.info(`[linkedin-auth]    displayName: ${displayName}`);

    res.status(StatusCodes.OK).json({
      providerUniqueIdentifier,
      displayName,
    });

    // ── Step 3: Background — create boards in TENANT account ──────────────
    // Runs AFTER Monday receives the response.
    // Uses mondayTokenForBoards (shortLivedToken preferred) → boards go to TENANT account.
    setImmediate(async () => {
      try {
        logger.info(`[linkedin-auth] [BG] ── Board creation starting ──`);
        logger.info(`[linkedin-auth] [BG] Tenant account: ${mondayAccountId}`);
        logger.info(`[linkedin-auth] [BG] Token source: ${tokenSource}`);

        if (!mondayTokenForBoards) {
          throw new Error(
            "No Monday token available for board creation — set MONDAY_APP_TOKEN in .env",
          );
        }

        if (!mondayAccountId) {
          throw new Error(
            "mondayAccountId missing — cannot target correct tenant account",
          );
        }

        // Fetch all org pages this LinkedIn user is admin of
        logger.info(`[linkedin-auth] [BG] Fetching LinkedIn org pages...`);
        const organizations =
          await fetchAdminOrganizations(linkedInAccessToken);
        logger.info(
          `[linkedin-auth] [BG] Found ${organizations.length} org(s)`,
        );

        const orgBoardMappings = [];

        for (const org of organizations) {
          try {
            logger.info(
              `[linkedin-auth] [BG] Creating workspace for: ${org.name} in account: ${mondayAccountId}`,
            );

            // createWorkspaceAndBoards sends:
            //   Authorization: mondayTokenForBoards  (tenant-scoped shortLivedToken)
            //   Account-Id: mondayAccountId          (still included as a safety measure)
            // Result: workspace + boards created in TENANT account
            const boardSetup = await createWorkspaceAndBoards(
              mondayTokenForBoards, // tenant-scoped token (shortLivedToken preferred)
              org,
              mondayAccountId, // tenant account ID
            );

            orgBoardMappings.push({
              orgId: org.id,
              orgName: org.name,
              orgUrn: org.urn,
              vanityName: org.vanityName || "",
              workspaceId: boardSetup.workspaceId,
              workspaceName: boardSetup.workspaceName,
              plannerBoardId: boardSetup.plannerBoardId,
              storageBoardId: boardSetup.storageBoardId,
            });

            logger.info(
              `[linkedin-auth] [BG] ✓ Workspace + boards created for: ${org.name}`,
            );
            logger.info(
              `[linkedin-auth] [BG]   workspaceId:    ${boardSetup.workspaceId}`,
            );
            logger.info(
              `[linkedin-auth] [BG]   plannerBoardId: ${boardSetup.plannerBoardId}`,
            );
            logger.info(
              `[linkedin-auth] [BG]   storageBoardId: ${boardSetup.storageBoardId}`,
            );
          } catch (orgErr) {
            logger.error(
              `[linkedin-auth] [BG] ✗ Failed for org ${org.name}: ${orgErr.message}`,
            );
            orgBoardMappings.push({
              orgId: org.id,
              orgName: org.name,
              orgUrn: org.urn,
              error: orgErr.message,
            });
          }
        }

        // Store installation in Monday SecureStorage — also in tenant account
        const installationPayload = {
          linkedInAccessToken,
          linkedInTokenExpiresAt: new Date(
            Date.now() + tokenExpiresIn * 1000,
          ).toISOString(),
          linkedInProfile: {
            sub: profile.sub,
            name: profile.name,
            email: profile.email,
            picture: profile.picture,
          },
          mondayAccountId,
          mondayUserId,
          organizations: orgBoardMappings,
          installedAt: new Date().toISOString(),
          flowVersion: "v5-api-key-plus-account-id",
        };

        await storeLinkedInInstallation(
          mondayTokenForBoards, // tenant-scoped token
          mondayAccountId,
          installationPayload,
        );

        const succeeded = orgBoardMappings.filter((o) => !o.error).length;
        logger.info(
          `[linkedin-auth] [BG] ✅ Setup complete for tenant: ${mondayAccountId}`,
        );
        logger.info(
          `[linkedin-auth] [BG] Orgs: ${succeeded}/${organizations.length} succeeded`,
        );
      } catch (bgErr) {
        logger.error(
          `[linkedin-auth] [BG] ✗ Background setup failed: ${bgErr.message}`,
        );
        logger.error(`[linkedin-auth] [BG] Stack: ${bgErr.stack}`);
      }
    });
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Provider-id error: ${err.message}`);
    logger.error(`[linkedin-auth] Stack: ${err.stack}`);

    if (!res.headersSent) {
      return res.status(StatusCodes.OK).json({
        providerUniqueIdentifier: `error_${Date.now()}`,
        displayName: "Connection error",
      });
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/linkedin-auth/token
//
// Token proxy — LinkedIn requires client credentials in POST body.
// Monday sends them as Basic Auth header. This endpoint converts and forwards.
// Set in Credentials → Access token request URL (and Refresh token URL)
// ─────────────────────────────────────────────────────────────────────────────
export const tokenController = async (req, res) => {
  try {
    logger.info("[linkedin-auth] ── TOKEN PROXY HIT ──");
    logger.info("[linkedin-auth] Content-Type: " + req.headers["content-type"]);

    let parsedBody = {};
    if (
      req.body &&
      typeof req.body === "object" &&
      Object.keys(req.body).length > 0
    ) {
      parsedBody = req.body;
    } else {
      await new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk.toString();
        });
        req.on("end", () => {
          try {
            parsedBody = Object.fromEntries(new URLSearchParams(raw));
            logger.info(
              "[linkedin-auth] Token body keys: " +
                Object.keys(parsedBody).join(", "),
            );
          } catch (e) {
            logger.warn("[linkedin-auth] Token body parse error: " + e.message);
          }
          resolve();
        });
      });
    }

    const code = parsedBody.code || req.query?.code || null;
    const grantType = parsedBody.grant_type || "authorization_code";
    const refreshToken = parsedBody.refresh_token || null;
    const redirectUri =
      parsedBody.redirect_uri || MONDAY_CREDENTIAL_REDIRECT_URI;

    logger.info("[linkedin-auth] grant_type: " + grantType);
    logger.info("[linkedin-auth] code present: " + !!code);
    logger.info("[linkedin-auth] redirect_uri: " + redirectUri);

    // Extract credentials from Basic Auth header
    let linkedInClientId = null;
    let linkedInClientSecret = null;

    const authHeader =
      req.headers.authorization || req.headers.Authorization || "";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(
        authHeader.replace("Basic ", ""),
        "base64",
      ).toString("utf8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx !== -1) {
        linkedInClientId = decoded.substring(0, colonIdx);
        linkedInClientSecret = decodeURIComponent(
          decoded.substring(colonIdx + 1),
        );
        logger.info(
          "[linkedin-auth] client_id from Basic auth: " + linkedInClientId,
        );
      }
    }

    // Fallback to env
    if (!linkedInClientId) {
      linkedInClientId = process.env.LINKEDIN_CLIENT_ID || null;
      linkedInClientSecret = process.env.LINKEDIN_CLIENT_SECRET || null;
      logger.info(
        "[linkedin-auth] client_id from env: " +
          (linkedInClientId || "MISSING"),
      );
    }

    if (!linkedInClientId || !linkedInClientSecret) {
      return res.status(500).json({ error: "missing_linkedin_credentials" });
    }

    const params = new URLSearchParams();
    params.append("grant_type", grantType);
    params.append("client_id", linkedInClientId);
    params.append("client_secret", linkedInClientSecret);

    if (grantType === "authorization_code" && code) {
      params.append("code", code);
      params.append("redirect_uri", redirectUri);
    } else if (grantType === "refresh_token" && refreshToken) {
      params.append("refresh_token", refreshToken);
    } else {
      logger.error("[linkedin-auth] Missing code or refresh_token");
      return res.status(400).json({ error: "missing_code_or_refresh_token" });
    }

    const linkedInResponse = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      },
    );

    logger.info(
      "[linkedin-auth] ✓ LinkedIn token exchange success. expires_in: " +
        linkedInResponse.data.expires_in,
    );
    return res.status(200).json(linkedInResponse.data);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error("[linkedin-auth] Token proxy error: " + err.message);
    logger.error("[linkedin-auth] LinkedIn response: " + JSON.stringify(data));
    return res
      .status(status || 500)
      .json(data || { error: "token_exchange_failed", message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/linkedin-auth/webhook
// ─────────────────────────────────────────────────────────────────────────────
export const webhookController = async (req, res) => {
  try {
    const event = req.body;
    logger.info(`[linkedin-auth] Webhook received: ${JSON.stringify(event)}`);

    const eventType = event?.type;
    const accountId = event?.data?.account_id;

    switch (eventType) {
      case "install":
        logger.info(`[linkedin-auth] App installed on account: ${accountId}`);
        break;
      case "uninstall":
        logger.info(
          `[linkedin-auth] App uninstalled from account: ${accountId}`,
        );
        break;
      default:
        logger.info(
          `[linkedin-auth] Webhook: ${eventType} for account: ${accountId}`,
        );
    }

    return res.status(StatusCodes.OK).json({ received: true });
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Webhook error: ${err.message}`);
    return res
      .status(StatusCodes.OK)
      .json({ received: true, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/linkedin-auth/callback
// ─────────────────────────────────────────────────────────────────────────────
export const callbackController = async (req, res) => {
  logger.warn(
    `[linkedin-auth] /callback called — not used in Credentials flow`,
  );
  return res.status(StatusCodes.OK).json({
    message: "Not used. Monday handles token exchange via Credentials feature.",
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/linkedin-auth/status
// ─────────────────────────────────────────────────────────────────────────────
export const statusController = async (req, res) => {
  try {
    const accountId = req.session?.accountId;
    const shortLivedToken = req.session?.shortLivedToken;

    if (!accountId || !shortLivedToken) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: "Missing Monday account context",
      });
    }

    const installation = await getLinkedInInstallation(
      shortLivedToken,
      accountId,
    );

    if (!installation) {
      return res.status(StatusCodes.OK).json({
        success: true,
        data: { connected: false },
      });
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      data: {
        connected: true,
        profile: installation.linkedInProfile,
        tokenExpiresAt: installation.linkedInTokenExpiresAt,
        organizations: installation.organizations?.map((o) => ({
          orgId: o.orgId,
          orgName: o.orgName,
          orgUrn: o.orgUrn,
          workspaceId: o.workspaceId,
          plannerBoardId: o.plannerBoardId,
          storageBoardId: o.storageBoardId,
          setupError: o.error || null,
        })),
        installedAt: installation.installedAt,
      },
    });
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Status error: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/linkedin-auth/disconnect
// ─────────────────────────────────────────────────────────────────────────────
export const disconnectController = async (req, res) => {
  try {
    const accountId = req.session?.accountId;
    const shortLivedToken = req.session?.shortLivedToken;

    if (!accountId || !shortLivedToken) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: "Missing Monday account context",
      });
    }

    await axios.post(
      "https://api.monday.com/v2",
      {
        query: `mutation DeleteStorage($key: String!) { delete_storage(key: $key) { key } }`,
        variables: { key: `linkedin_installation_${accountId}` },
      },
      {
        headers: {
          Authorization: shortLivedToken,
          "Content-Type": "application/json",
          "API-Version": "2024-01",
        },
      },
    );

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "LinkedIn disconnected. Boards preserved.",
    });
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Disconnect error: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/linkedin-auth/health
// ─────────────────────────────────────────────────────────────────────────────
export const healthController = (_req, res) => {
  const config = getConfig();
  const mondayApiKey = config.MONDAY_API_KEY || process.env.MONDAY_API_KEY;

  return res.status(StatusCodes.OK).json({
    success: true,
    message: "LinkedIn Auth operational",
    timestamp: new Date().toISOString(),
    boardCreationApproach:
      "MONDAY_API_KEY + Account-Id: <tenantAccountId> header → boards in TENANT account",
    config: {
      MONDAY_SIGNING_SECRET: config.MONDAY_SIGNING_SECRET
        ? "✓ SET"
        : "✗ MISSING",
      LINKEDIN_CLIENT_ID: config.LINKEDIN_CLIENT_ID ? "✓ SET" : "✗ MISSING",
      LINKEDIN_CLIENT_SECRET: config.LINKEDIN_CLIENT_SECRET
        ? "✓ SET"
        : "✗ MISSING",
      MONDAY_API_KEY: mondayApiKey ? "✓ SET" : "✗ MISSING",
    },
    endpoints: {
      install:
        "GET  /api/linkedin-auth/install     ← Credential Authorization URL",
      token:
        "POST /api/linkedin-auth/token       ← Credential Access token URL",
      providerId:
        "POST /api/linkedin-auth/provider-id ← Credential Provider ID URL",
      webhook: "POST /api/linkedin-auth/webhook     ← Webhooks All Events URL",
    },
  });
};
