import jwt from "jsonwebtoken";
import { logger } from "../utils/logger.js";
import { MESSAGES } from "../constants/messages.constant.js";
import { StatusCodes } from "../constants/statusCodes.constants.js";

export const authorizeRequest = async (req, res, next) => {
  try {
    logger.info(`[Auth] ▶ Authorization middleware initiated`);
    logger.info(`[Auth] Request path: ${req.path}`);
    logger.info(`[Auth] Request method: ${req.method}`);

    let { authorization } = req.headers;

    logger.info(`[Auth] Step 1: Extract authorization credential`);
    logger.info(
      `[Auth] ├─ Authorization header: ${authorization ? "✓ Present" : "✗ Missing"}`,
    );

    // Also support ?token= query param
    if (!authorization && req.query?.token) {
      logger.info(`[Auth] ├─ Attempting to use ?token= query parameter`);
      authorization = req.query.token;
    }

    if (!authorization || typeof authorization !== "string") {
      logger.error(`[Auth] ✗ CRITICAL: No authorization credential found`);
      logger.error(
        `[Auth] ├─ Authorization header: ${req.headers.authorization ? "present" : "missing"}`,
      );
      logger.error(
        `[Auth] ├─ Query token: ${req.query?.token ? "present" : "missing"}`,
      );
      logger.error(
        `[Auth] └─ Headers received: ${Object.keys(req.headers).join(", ")}`,
      );

      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: MESSAGES.UNAUTHORIZED,
      });
    }

    logger.info(`[Auth] └─ Credential length: ${authorization.length} chars`);

    // Strip "Bearer " prefix if present
    if (authorization.startsWith("Bearer ")) {
      logger.info(`[Auth] Step 2: Strip Bearer prefix`);
      authorization = authorization.slice(7);
      logger.info(
        `[Auth] └─ Token extracted (new length: ${authorization.length} chars)`,
      );
    }

    // Get signing secret from env
    const signingSecret = process.env.MONDAY_SIGNING_SECRET;

    // Try to verify as JWT first (for /sync endpoint from Monday automation)
    if (signingSecret) {
      logger.info(`[Auth] Step 3: Attempt JWT verification`);
      logger.info(`[Auth] ├─ Signing secret configured: ✓ Yes`);
      try {
        logger.info(`[Auth] ├─ Verifying token as JWT...`);
        const decoded = jwt.verify(authorization, signingSecret);
        // JWT verification successful
        req.session = {
          accountId: decoded.accountId,
          userId: decoded.userId,
          backToUrl: decoded.backToUrl,
          shortLivedToken: decoded.shortLivedToken,
        };
        logger.info(`[Auth] └─ JWT verification: ✓ PASSED`);
        logger.info(`[Auth] ├─ Account ID: ${decoded.accountId || "unknown"}`);
        logger.info(`[Auth] ├─ User ID: ${decoded.userId || "unknown"}`);
        logger.info(
          `[Auth] └─ backToUrl: ${decoded.backToUrl ? "✓ Present" : "✗ Missing"}`,
        );
        logger.info(`[Auth] ▶ Authorization successful (JWT)`);
        return next();
      } catch (jwtErr) {
        // JWT verification failed, try as raw Bearer token
        logger.warn(`[Auth] ├─ JWT verification failed: ${jwtErr.message}`);
        logger.warn(`[Auth] └─ Falling back to raw Bearer token`);
      }
    } else {
      logger.warn(`[Auth] Step 3: JWT verification`);
      logger.warn(
        `[Auth] └─ Signing secret NOT configured - JWT verification skipped`,
      );
    }

    // If JWT verification failed or no signing secret, accept as raw Bearer token (for storage endpoints)
    logger.info(`[Auth] Step 4: Accept raw Bearer token`);
    req.session = {
      token: authorization,
    };
    logger.info(`[Auth] └─ Raw Bearer token accepted: ✓`);
    logger.info(`[Auth] ▶ Authorization successful (Bearer token)`);
    next();
  } catch (err) {
    logger.error(
      `[Auth] ═════════════════════════════════════════════════════════`,
    );
    logger.error(`[Auth] ✗ AUTHORIZATION FAILED`);
    logger.error(`[Auth] Error: ${err.message}`);
    logger.error(`[Auth] Stack: ${err.stack}`);
    logger.error(
      `[Auth] ═════════════════════════════════════════════════════════`,
    );

    return res.status(StatusCodes.UNAUTHORIZED).json({
      success: false,
      error: MESSAGES.UNAUTHORIZED,
    });
  }
};
