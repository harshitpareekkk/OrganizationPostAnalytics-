import axios from "axios";
import jwt from "jsonwebtoken";
import {
  fetchLastThreeMonthsPosts,
  fetchPostStats,
  extractPostDetails,
} from "../services/linkedin.service.js";
import {
  getStoredPost,
  savePostToStorage,
  updatePostInStorage,
} from "../services/monday.storage.service.js";
import {
  fetchBoardColumns,
  createBoardItem,
  updateBoardItem,
  findBoardItemByPostId,
  testMondayAccess,
} from "../services/monday.board.service.js";
import { hasMetricsChanged } from "../utils/diff.util.js";
import { logger } from "../utils/logger.js";
import { StatusCodes } from "../constants/statusCodes.constants.js";
import { MESSAGES } from "../constants/messages.constant.js";

// ─── Helper: Generate signed JWT token for Monday callback ───────────────────
const getAuthToken = () => {
  const signingSecret = process.env.MONDAY_SIGNING_SECRET;
  const appId = Number(process.env.MONDAY_APP_ID);

  if (isNaN(appId)) {
    logger.error("[sync] MONDAY_APP_ID must be set to a numeric value in .env");
    throw new Error("Invalid MONDAY_APP_ID");
  }

  return jwt.sign({ appId }, signingSecret);
};

// ─── Reusable callback sender ─────────────────────────────────────────────────
const sendCallback = async (callbackUrl, success) => {
  if (!callbackUrl) {
    logger.warn(`[sync] No callback URL — skipping Monday callback`);
    return;
  }
  try {
    const authToken = getAuthToken();
    await axios.post(
      callbackUrl,
      { success, outputFields: {} },
      {
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
          Authorization: authToken,
        },
      },
    );
    logger.info(`[sync] └─ Callback sent: ✓ (success=${success})`);
  } catch (callbackErr) {
    logger.warn(`[sync] └─ Callback error (non-fatal): ${callbackErr.message}`);
  }
};

export const syncLinkedInPosts = async (req, res) => {
  let callbackUrl = null;

  try {
    logger.info(
      "═════════════════════════════════════════════════════════════",
    );
    logger.info("[sync] ▶ Starting LinkedIn posts synchronization");
    logger.info(`[sync] Request method: ${req.method}`);
    logger.info(`[sync] Request path: ${req.path}`);
    logger.info(
      "[sync] ─────────────────────────────────────────────────────────",
    );

    // ── SEAMLESS AUTH: Extract JWT from Authorization header ─────────────────
    // Monday sends a JWT in the Authorization header containing shortLivedToken
    // (valid for 5 minutes)
    logger.info(
      `[sync] Step 1: Extract and decode JWT from Authorization header`,
    );
    const signingSecret = process.env.MONDAY_SIGNING_SECRET;
    const authHeader = req.headers.authorization;

    logger.info(
      `[sync] ├─ Authorization header: ${authHeader ? "✓ Present" : "✗ MISSING"}`,
    );

    if (!authHeader) {
      logger.error(`[sync] ✗✗✗ AUTHORIZATION FAILED ✗✗✗`);
      logger.error(`[sync] ├─ No Authorization header in request`);
      logger.error(
        `[sync] ├─ Headers present: ${Object.keys(req.headers || {}).join(", ")}`,
      );
      logger.error(
        `[sync] └─ ACTION: Built-in triggers should send JWT in Authorization header`,
      );

      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: "Missing Authorization header from Monday",
        message:
          "Monday should send a JWT in the Authorization header containing the shortLivedToken",
      });
    }

    let decodedJwt;
    try {
      decodedJwt = jwt.verify(authHeader, signingSecret);
      logger.info(`[sync] └─ JWT decoded successfully ✓`);
    } catch (jwtErr) {
      logger.error(`[sync] ✗ JWT verification failed: ${jwtErr.message}`);
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: "Invalid JWT in Authorization header",
        message: "JWT verification failed",
      });
    }

    const shortLivedToken = decodedJwt.shortLivedToken;
    const accountId = decodedJwt.accountId;

    logger.info(`[sync] Step 2: Validate seamless authentication`);
    logger.info(
      `[sync] ├─ shortLivedToken: ${shortLivedToken ? "✓ Found" : "✗ MISSING"}`,
    );
    logger.info(`[sync] ├─ accountId: ${accountId ? "✓ Found" : "✗ MISSING"}`);

    if (!shortLivedToken || !accountId) {
      logger.error(`[sync] ✗✗✗ AUTHORIZATION FAILED ✗✗✗`);
      logger.error(`[sync] ├─ Missing required fields from JWT payload`);
      logger.error(
        `[sync] ├─ JWT payload keys: ${Object.keys(decodedJwt || {}).join(", ")}`,
      );
      logger.error(
        `[sync] └─ ACTION: Verify Monday trigger is sending valid JWT`,
      );

      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        error: "Missing shortLivedToken or accountId from JWT",
        message: "JWT payload must contain both shortLivedToken and accountId",
      });
    }

    logger.info(`[sync] └─ Token length: ${shortLivedToken.length} chars`);

    // Extract payload for callbackUrl and other data from request body
    const payload = req.body?.payload;
    callbackUrl = payload?.callbackUrl;
    logger.info(
      `[sync] ├─ Callback URL: ${callbackUrl ? "✓ Present" : "✗ Missing"}`,
    );

    // ── Respond 200 immediately so Monday does not timeout ────────────────────
    // Monday automation blocks expect a 200 ACK quickly.
    // Then we do the actual work and call callbackUrl when done.
    res.status(200).json({ success: true, message: "Sync acknowledged" });
    logger.info("[sync] ✓ Sent immediate 200 ACK to Monday");

    // ── All work below runs after the response is already sent ───────────────
    (async () => {
      try {
        // Use the seamless token from Monday (valid for 5 minutes)
        const mondayToken = shortLivedToken;
        logger.info(`[sync] ├─ Using seamless token from Monday payload`);
        logger.info(`[sync] └─ Account ID: ${accountId}`);

        // Board ID
        const boardId = String(
          payload?.inputFields?.boardId || process.env.MONDAY_BOARD_ID || "",
        );

        if (!boardId) {
          logger.error("[sync] ✗ CONFIGURATION ERROR: Missing boardId");
          await sendCallback(callbackUrl, false);
          return;
        }

        const boardSource = payload?.inputFields?.boardId
          ? "Monday automation inputFields"
          : ".env MONDAY_BOARD_ID";
        logger.info(`[sync] Step 3: Configure board access`);
        logger.info(`[sync] └─ Board ID: ${boardId} (from: ${boardSource})`);

        logger.info(`[sync] Step 4: Test Monday board access`);
        try {
          await testMondayAccess(mondayToken, boardId);
          logger.info(`[sync] └─ Board access test: ✓ PASSED`);
        } catch (err) {
          logger.error(`[sync] ✗ BOARD ACCESS FAILED: ${err.message}`);
          await sendCallback(callbackUrl, false);
          return;
        }

        logger.info(`[sync] Step 5: Fetch board structure`);
        let columns = [];
        let columnMap = {};
        try {
          ({ columns, columnMap } = await fetchBoardColumns(
            mondayToken,
            boardId,
          ));
          logger.info(`[sync] └─ Columns fetched: ✓ ${columns.length} columns`);
        } catch (err) {
          logger.error(`[sync] ✗ COLUMN FETCH FAILED: ${err.message}`);
          await sendCallback(callbackUrl, false);
          return;
        }

        logger.info("[sync] Step 6: Fetch LinkedIn posts");
        const posts = await fetchLastThreeMonthsPosts();
        logger.info(
          `[sync] └─ Posts fetched: ✓ ${posts.length} posts from 90 days`,
        );

        if (posts.length === 0) {
          logger.info("[sync] └─ No posts to sync, completing");
          await sendCallback(callbackUrl, true);
          return;
        }

        const results = [];

        logger.info(
          `[sync] Step 7: Process ${posts.length} posts sequentially`,
        );
        for (const post of posts) {
          const postId = post.id;
          logger.info(`[sync] ├─ Processing post: ${postId}`);

          const details = extractPostDetails(
            post,
            post._resolvedAuthorName || "",
          );

          // Storage check FIRST — before analytics fetch
          logger.info(`[sync] │  ├─ Check if post exists in storage`);
          const postCheckResult = await getStoredPost(mondayToken, postId);

          // Handle token validation error from service
          if (
            !postCheckResult.success &&
            postCheckResult.statusCode === StatusCodes.UNAUTHORIZED
          ) {
            logger.error(
              `[sync] │  ✗ TOKEN INVALID - Storage service returned 401`,
            );
            logger.error(`[sync] │  Details: ${postCheckResult.error}`);
            await sendCallback(callbackUrl, false);
            return;
          }

          const existingPost = postCheckResult.success
            ? postCheckResult.data
            : null;

          logger.info(
            `[sync] │  └─ Storage check: ${existingPost ? "Exists" : "New post"}`,
          );

          // Fetch analytics once per post
          const analytics = await fetchPostStats(postId);

          if (!existingPost) {
            logger.info(`[sync] │  └─ Action: CREATE new board item`);

            const postObj = {
              postId,
              details,
              analytics,
              boardItemId: null,
              boardId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };

            // (a) Save to Monday Storage
            logger.info(`[sync] │     ├─ Saving to Monday Storage...`);
            const saved = await savePostToStorage(mondayToken, postObj);
            if (!saved.success) {
              logger.error(
                `[sync] │     ✗ Storage save failed: ${saved.error}`,
              );
              results.push({
                postId,
                postedAt: details.createdAt,
                status: "SAVE_FAILED",
              });
              continue;
            }
            logger.info(`[sync] │     └─ Saved to storage: ✓`);

            // (b) Create board row (item_name = postId)
            logger.info(`[sync] │     ├─ Creating Monday board item...`);
            let boardItemId = null;
            try {
              boardItemId = await createBoardItem(
                mondayToken,
                postObj,
                columnMap,
                columns,
                boardId,
              );
              logger.info(
                `[sync] │     └─ Board item created: ✓ ${boardItemId}`,
              );
            } catch (err) {
              logger.error(
                `[sync] │     ✗ Board creation failed: ${err.message}`,
              );
            }

            // (c) Save boardItemId to storage so next sync can update directly
            if (boardItemId) {
              logger.info(
                `[sync] │     ├─ Updating storage with boardItemId...`,
              );
              const updateRes = await updatePostInStorage(mondayToken, postId, {
                ...postObj,
                boardItemId,
              });
              if (updateRes.success) {
                logger.info(`[sync] │     └─ Board item ID stored: ✓`);
              } else {
                logger.warn(
                  `[sync] │     ✗ Failed to store board item ID: ${updateRes.error}`,
                );
              }
            }

            results.push({
              postId,
              postedAt: details.createdAt,
              boardItemId: boardItemId || null,
              status: boardItemId ? "CREATED" : "CREATED_STORAGE_ONLY",
            });
          } else {
            const analyticsChanged = hasMetricsChanged(
              existingPost.analytics,
              analytics,
            );

            if (analyticsChanged) {
              logger.info(`[sync] │  └─ Action: UPDATE analytics`);

              const updatedPost = {
                ...existingPost,
                analytics,
                updatedAt: new Date().toISOString(),
              };

              // Update storage
              logger.info(`[sync] │     ├─ Updating storage...`);
              const updateRes = await updatePostInStorage(
                mondayToken,
                postId,
                updatedPost,
              );
              if (updateRes.success) {
                logger.info(`[sync] │     └─ Storage updated: ✓`);
              } else {
                logger.error(
                  `[sync] │     ✗ Storage update failed: ${updateRes.error}`,
                );
              }

              // Find board item ID
              let boardItemId = existingPost.boardItemId || null;
              if (!boardItemId) {
                logger.info(`[sync] │     ├─ Searching for board item...`);
                boardItemId = await findBoardItemByPostId(
                  mondayToken,
                  postId,
                  boardId,
                );
                if (boardItemId) {
                  logger.info(`[sync] │     └─ Found: ${boardItemId}`);
                  const updateRes = await updatePostInStorage(
                    mondayToken,
                    postId,
                    {
                      ...updatedPost,
                      boardItemId,
                    },
                  );
                  if (!updateRes.success) {
                    logger.warn(
                      `[sync] │     ✗ Failed to store found board item ID`,
                    );
                  }
                } else {
                  logger.info(`[sync] │     └─ Board item not found`);
                }
              }

              if (boardItemId) {
                try {
                  logger.info(`[sync] │     ├─ Updating board analytics...`);
                  await updateBoardItem(
                    mondayToken,
                    boardItemId,
                    analytics,
                    columnMap,
                    columns,
                    boardId,
                  );
                  logger.info(`[sync] │     └─ Board updated: ✓`);
                } catch (err) {
                  logger.error(
                    `[sync] │     ✗ Board update failed: ${err.message}`,
                  );
                }
              } else {
                // No board item found — create one now as recovery
                logger.warn(
                  `[sync] │  ✗ No board item found for post ${postId}, attempting recovery`,
                );
                try {
                  boardItemId = await createBoardItem(
                    mondayToken,
                    updatedPost,
                    columnMap,
                    columns,
                    boardId,
                  );
                  const updateRes = await updatePostInStorage(
                    mondayToken,
                    postId,
                    {
                      ...updatedPost,
                      boardItemId,
                    },
                  );
                  if (updateRes.success) {
                    logger.info(
                      `[sync] │  └─ Board item created successfully (recovery)`,
                    );
                  } else {
                    logger.warn(
                      `[sync] │  └─ Board item created but storage update failed`,
                    );
                  }
                } catch (err) {
                  logger.error(
                    `[sync] │  ✗ Recovery creation failed: ${err.message}`,
                  );
                }
              }

              // ── FIX 2: Original code pushed UPDATED twice (once inside the
              // boardItemId branch and once after). Removed the duplicate push.
              results.push({
                postId,
                postedAt: details.createdAt,
                boardItemId: boardItemId || null,
                status: "UPDATED",
              });
            } else {
              logger.info(`[sync] │  └─ Action: SKIP (no analytics changes)`);
              results.push({
                postId,
                postedAt: details.createdAt,
                boardItemId: existingPost.boardItemId || null,
                status: "UNCHANGED",
              });
            }
          }
        } // ← each post fully completes before next starts

        // Step 8: Compilation
        logger.info(`[sync] Step 8: Compilation complete`);
        const summary = {
          total: results.length,
          created: results.filter(
            (r) =>
              r.status === "CREATED" || r.status === "CREATED_STORAGE_ONLY",
          ).length,
          updated: results.filter((r) => r.status === "UPDATED").length,
          unchanged: results.filter((r) => r.status === "UNCHANGED").length,
          failed: results.filter((r) => r.status.includes("FAILED")).length,
        };

        logger.info(
          `[sync] └─ Created: ${summary.created}, Updated: ${summary.updated}, Unchanged: ${summary.unchanged}, Failed: ${summary.failed}`,
        );

        logger.info(
          "═════════════════════════════════════════════════════════════",
        );
        logger.info("[sync] ▶ Sync completed successfully");
        logger.info(
          "═════════════════════════════════════════════════════════════",
        );

        // Step 9: Send success callback to Monday
        await sendCallback(callbackUrl, true);
      } catch (innerErr) {
        logger.error(
          "═════════════════════════════════════════════════════════════",
        );
        logger.error("[sync] ✗✗✗ ASYNC SYNC JOB FAILED ✗✗✗");
        logger.error(`[sync] Error: ${innerErr.message}`);
        logger.error(`[sync] Stack: ${innerErr.stack}`);
        logger.error(
          "═════════════════════════════════════════════════════════════",
        );
        await sendCallback(callbackUrl, false);
      }
    })(); // fire-and-forget async IIFE
  } catch (err) {
    // This outer catch only fires if something goes wrong BEFORE res.status(200) is sent
    logger.error(
      "═════════════════════════════════════════════════════════════",
    );
    logger.error("[sync] ✗✗✗ OUTER SYNC FAILED (before ACK) ✗✗✗");
    logger.error(`[sync] Error: ${err.message}`);
    logger.error(`[sync] Stack: ${err.stack}`);
    logger.error(
      "═════════════════════════════════════════════════════════════",
    );

    if (!res.headersSent) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: MESSAGES.INTERNAL_SERVER_ERROR,
      });
    }

    await sendCallback(callbackUrl, false);
  }
};
