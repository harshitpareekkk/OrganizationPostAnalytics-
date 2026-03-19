import { Storage } from "@mondaycom/apps-sdk";
import { logger } from "../utils/logger.js";
import { MESSAGES } from "../constants/messages.constant.js";
import { StatusCodes } from "../constants/statusCodes.constants.js";

const SHARED = { shared: true };
const INDEX_KEY = "linkedin_post_index";
const postKey = (postId) => `post_${postId}`;

// Safe JSON helpers
const toStorage = (value) => JSON.stringify(value);
const fromStorage = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
};

// Index helpers
const readIndex = async (storage) => {
  try {
    const res = await storage.get(INDEX_KEY, SHARED);
    if (!res || !res.success || res.value === null || res.value === undefined) {
      return { ids: [], version: null };
    }
    const ids = fromStorage(res.value);
    return {
      ids: Array.isArray(ids) ? ids : [],
      version: res.version || null,
    };
  } catch {
    return { ids: [], version: null };
  }
};

const writeIndex = async (storage, ids, previousVersion) => {
  const opts = { ...SHARED };
  if (previousVersion) opts.previousVersion = previousVersion;
  await storage.set(INDEX_KEY, toStorage(ids), opts);
};

// Public API
export const getStoredPost = async (token, postId) => {
  try {
    logger.info(`[storage] GET post ${postId}: starting retrieval`);
    const storage = new Storage(token);

    logger.info(`[storage] GET post ${postId}: executing storage.get()`);
    const res = await storage.get(postKey(postId), SHARED);

    if (!res || !res.success || res.value === null || res.value === undefined) {
      logger.info(`[storage] GET post ${postId}: ✗ not found in storage`);
      return {
        success: false,
        statusCode: StatusCodes.NOT_FOUND,
        error: MESSAGES.NOT_FOUND,
      };
    }

    const post = fromStorage(res.value);
    if (!post) {
      logger.warn(`[storage] GET post ${postId}: ✗ JSON parse failed`);
      return {
        success: false,
        statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
        error: MESSAGES.INTERNAL_SERVER_ERROR,
      };
    }

    logger.info(
      `[storage] GET post ${postId}: ✓ found and parsed successfully`,
    );
    return { success: true, statusCode: StatusCodes.OK, data: post };
  } catch (err) {
    logger.error(`[storage] GET post ${postId}: ✗ Operation failed`);
    logger.error(`[storage] ├─ Error message: ${err.message}`);
    logger.error(`[storage] ├─ Error code: ${err.code || "unknown"}`);
    logger.error(`[storage] ├─ Error status: ${err.status || "unknown"}`);
    logger.error(`[storage] └─ Stack: ${err.stack}`);

    // Check if it's an authorization error
    if (
      err.message?.includes("401") ||
      err.message?.includes("unauthorized") ||
      err.status === 401
    ) {
      logger.error(
        `[storage] ✗ AUTHORIZATION ERROR: Token may be invalid or expired`,
      );
      return {
        success: false,
        statusCode: StatusCodes.UNAUTHORIZED,
        error: "Storage authorization failed - token invalid or expired",
      };
    }

    return {
      success: false,
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    };
  }
};

export const savePostToStorage = async (token, postObj) => {
  const { postId } = postObj;
  try {
    logger.info(`[storage] SAVE post ${postId}: starting storage save`);
    const storage = new Storage(token);

    // 1. Save the post as a JSON string
    logger.info(
      `[storage] SAVE post ${postId}: writing post object to storage`,
    );
    const setRes = await storage.set(
      postKey(postId),
      toStorage(postObj),
      SHARED,
    );
    if (!setRes.success) {
      logger.error(
        `[storage] SAVE post ${postId}: ✗ storage.set failed with error: ${setRes.error}`,
      );
      return {
        success: false,
        statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
        error: MESSAGES.INTERNAL_SERVER_ERROR,
      };
    }
    logger.info(`[storage] SAVE post ${postId}: ✓ post written to storage`);

    // 2. Update the index
    logger.info(`[storage] SAVE post ${postId}: updating index`);
    const { ids, version } = await readIndex(storage);
    if (!ids.includes(postId)) ids.push(postId);
    await writeIndex(storage, ids, version);
    logger.info(`[storage] SAVE post ${postId}: ✓ index updated`);

    logger.info(`[storage] SAVE post ${postId}: ✓ SUCCESS`);
    return { success: true, statusCode: StatusCodes.CREATED };
  } catch (err) {
    logger.error(`[storage] SAVE post ${postId}: ✗ Operation failed`);
    logger.error(`[storage] ├─ Error message: ${err.message}`);
    logger.error(`[storage] ├─ Error code: ${err.code || "unknown"}`);
    logger.error(`[storage] └─ Stack: ${err.stack}`);

    if (err.message?.includes("401") || err.status === 401) {
      logger.error(`[storage] ✗ AUTHORIZATION ERROR: Token invalid or expired`);
      return {
        success: false,
        statusCode: StatusCodes.UNAUTHORIZED,
        error: "Storage authorization failed - token invalid or expired",
      };
    }

    return {
      success: false,
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    };
  }
};

/**
 * Update analytics for an existing post.
 */
export const updatePostInStorage = async (token, postId, updatedPostObj) => {
  try {
    logger.info(`[storage] UPDATE post ${postId}: starting update`);
    const storage = new Storage(token);

    // Get current version for optimistic locking
    let previousVersion = null;
    try {
      logger.info(
        `[storage] UPDATE post ${postId}: fetching current version for lock`,
      );
      const cur = await storage.get(postKey(postId), SHARED);
      previousVersion = cur?.version || null;
    } catch {
      logger.info(
        `[storage] UPDATE post ${postId}: no current version (key may not exist)`,
      );
      /* key not found, write fresh */
    }

    const opts = { ...SHARED };
    if (previousVersion) opts.previousVersion = previousVersion;

    logger.info(`[storage] UPDATE post ${postId}: writing updated object`);
    const setRes = await storage.set(
      postKey(postId),
      toStorage(updatedPostObj),
      opts,
    );

    if (!setRes.success) {
      logger.warn(
        `[storage] UPDATE post ${postId}: version conflict, retrying without lock`,
      );
      await storage.set(postKey(postId), toStorage(updatedPostObj), SHARED);
    }

    logger.info(`[storage] UPDATE post ${postId}: ✓ SUCCESS`);
    return { success: true, statusCode: StatusCodes.OK };
  } catch (err) {
    logger.error(`[storage] UPDATE post ${postId}: ✗ Operation failed`);
    logger.error(`[storage] ├─ Error message: ${err.message}`);
    logger.error(`[storage] ├─ Error code: ${err.code || "unknown"}`);
    logger.error(`[storage] └─ Stack: ${err.stack}`);

    if (err.message?.includes("401") || err.status === 401) {
      logger.error(`[storage] ✗ AUTHORIZATION ERROR: Token invalid or expired`);
      return {
        success: false,
        statusCode: StatusCodes.UNAUTHORIZED,
        error: "Storage authorization failed - token invalid or expired",
      };
    }

    return {
      success: false,
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    };
  }
};

/**
 * Get ALL stored posts as an array.
 */
export const getAllStoredPosts = async (token) => {
  try {
    const storage = new Storage(token);
    const { ids } = await readIndex(storage);
    logger.info(`[storage] GET all posts: found ${ids.length} posts in index`);

    if (ids.length === 0) {
      return { success: true, statusCode: StatusCodes.OK, data: [] };
    }

    const posts = [];
    for (const postId of ids) {
      try {
        const res = await storage.get(postKey(postId), SHARED);
        if (
          res &&
          res.success &&
          res.value !== null &&
          res.value !== undefined
        ) {
          const post = fromStorage(res.value);
          if (post) posts.push(post);
        }
      } catch (err) {
        logger.warn(`[storage] GET all posts: skipping missing post ${postId}`);
      }
    }

    logger.info(`[storage] GET all posts: retrieved ${posts.length} posts`);
    return { success: true, statusCode: StatusCodes.OK, data: posts };
  } catch (err) {
    logger.error(`[storage] GET all posts failed: ${err.message}`);
    return {
      success: false,
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    };
  }
};

/**
 * Delete a single post and remove it from the index.
 */
export const deleteStoredPost = async (token, postId) => {
  try {
    const storage = new Storage(token);

    await storage.delete(postKey(postId), SHARED).catch(() => {});

    const { ids, version } = await readIndex(storage);
    const newIds = ids.filter((id) => id !== postId);
    await writeIndex(storage, newIds, version);

    logger.info(`[storage] DELETE post ${postId}: success`);
    return { success: true, statusCode: StatusCodes.OK };
  } catch (err) {
    logger.error(`[storage] DELETE post ${postId} failed: ${err.message}`);
    return {
      success: false,
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    };
  }
};

/**
 * Delete ALL posts and clear the index.
 */
export const deleteAllStoredPosts = async (token) => {
  try {
    const storage = new Storage(token);
    const { ids } = await readIndex(storage);

    logger.info(`[storage] DELETE all posts: deleting ${ids.length} posts`);
    for (const postId of ids) {
      await storage.delete(postKey(postId), SHARED).catch(() => {});
    }
    await storage.delete(INDEX_KEY, SHARED).catch(() => {});

    logger.info(`[storage] DELETE all posts: success`);
    return { success: true, statusCode: StatusCodes.OK, deleted: ids.length };
  } catch (err) {
    logger.error(`[storage] DELETE all posts failed: ${err.message}`);
    return {
      success: false,
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    };
  }
};

// Helper to extract token from request (set by authorizeRequest middleware)
const getToken = (req) => {
  // For JWT requests: shortLivedToken from Monday automation
  if (req.session?.shortLivedToken) {
    return req.session.shortLivedToken;
  }
  // For raw Bearer token requests
  if (req.session?.token) {
    return req.session.token;
  }
  // Fallback to .env
  return process.env.MONDAY_API_KEY;
};

// Helper to format post for response
const formatPost = (post) => ({
  postId: post.postId,
  boardItemId: post.boardItemId || null,
  details: {
    text: post.details?.text || "",
    postType: post.details?.postType || "",
    postUrl: post.details?.postUrl || "",
    owner: post.details?.owner || "",
    createdAt: post.details?.createdAt || "",
  },
  analytics: {
    likeCount: post.analytics?.likeCount ?? 0,
    commentCount: post.analytics?.commentCount ?? 0,
    impressionCount: post.analytics?.impressionCount ?? 0,
    uniqueImpressionsCount: post.analytics?.uniqueImpressionsCount ?? 0,
    shareCount: post.analytics?.shareCount ?? 0,
    clickCount: post.analytics?.clickCount ?? 0,
    engagement: post.analytics?.engagement ?? 0,
    ctr: post.analytics?.ctr ?? 0,
  },
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
});

// ─── Route Handlers ───────────────────────────────────────────────────────

export const getAllStoredPostsHandler = async (req, res) => {
  try {
    const token = getToken(req);
    const result = await getAllStoredPosts(token);

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    const entries = result.data.map(formatPost);
    return res.status(result.statusCode).json({
      success: true,
      total: entries.length,
      entries,
    });
  } catch (err) {
    logger.error(`[storage] GET all posts handler failed: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
};

export const getStoredPostHandler = async (req, res) => {
  try {
    const { postId } = req.params;
    const token = getToken(req);
    const result = await getStoredPost(token, postId);

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    return res.status(result.statusCode).json({
      success: true,
      post: formatPost(result.data),
    });
  } catch (err) {
    logger.error(`[storage] GET post handler failed: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
};

export const deleteAllStoredPostsHandler = async (req, res) => {
  try {
    const token = getToken(req);
    const result = await deleteAllStoredPosts(token);

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }
    logger.info(
      `[storage] DELETE all posts handler: deleted ${result.deleted} posts`,
    );
    return res.status(result.statusCode).json({
      success: true,
      deleted: result.deleted,
    });
  } catch (err) {
    logger.error(`[storage] DELETE all posts handler failed: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
};

export const deleteStoredPostHandler = async (req, res) => {
  try {
    const { postId } = req.params;
    const token = getToken(req);
    const result = await deleteStoredPost(token, postId);

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    return res.status(result.statusCode).json({
      success: true,
      message: `Post ${postId} deleted successfully`,
    });
  } catch (err) {
    logger.error(`[storage] DELETE post handler failed: ${err.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
};
