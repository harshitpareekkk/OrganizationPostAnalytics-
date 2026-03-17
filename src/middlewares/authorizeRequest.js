import jwt from "jsonwebtoken";
import { logger } from "../utils/logger.js";
import { MESSAGES } from "../constants/messages.constant.js";
import { StatusCodes } from "../constants/statusCodes.constants.js";

export const authorizeRequest = async (req, res, next) => {
  try {
    let { authorization } = req.headers;

    // Also support ?token= query param
    if (!authorization && req.query?.token) {
      authorization = req.query.token;
    }

    if (!authorization || typeof authorization !== "string") {
      logger.error("[Auth] No authorization header");
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: MESSAGES.UNAUTHORIZED,
      });
    }

    // Strip "Bearer " prefix if present
    if (authorization.startsWith("Bearer ")) {
      authorization = authorization.slice(7);
    }

    // Get signing secret from env
    const signingSecret = process.env.MONDAY_SIGNING_SECRET;

    // Try to verify as JWT first (for /sync endpoint from Monday automation)
    if (signingSecret) {
      try {
        const decoded = jwt.verify(authorization, signingSecret);
        // JWT verification successful
        req.session = {
          accountId: decoded.accountId,
          userId: decoded.userId,
          backToUrl: decoded.backToUrl,
          shortLivedToken: decoded.shortLivedToken,
        };
        logger.info(`[Auth] JWT verified | accountId=${decoded.accountId}`);
        return next();
      } catch (jwtErr) {
        // JWT verification failed, try as raw Bearer token
        logger.info(
          `[Auth] JWT verification failed: ${jwtErr.message}, treating as raw Bearer token`,
        );
      }
    }

    // If JWT verification failed or no signing secret, accept as raw Bearer token (for storage endpoints)
    req.session = {
      token: authorization,
    };
    logger.info(`[Auth] Raw Bearer token accepted`);
    next();
  } catch (err) {
    logger.error(`[Auth] Authentication failed: ${err.message}`);
    return res.status(StatusCodes.UNAUTHORIZED).json({
      success: false,
      error: MESSAGES.UNAUTHORIZED,
    });
  }
};
