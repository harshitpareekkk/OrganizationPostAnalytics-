// ─────────────────────────────────────────────────────────────────────────────
// linkedinPost.controller.js
//
// Express controllers for LinkedIn org-page posting.
//
// Exports:
//   uploadMedia        → multer middleware (attach to POST /create route)
//   getMyOrganizations → GET  — returns org pages the user administrates
//   createPost         → POST — single entry point for all 4 post types
//
// Post types via req.body.postType:
//   "text"    → plain text post                   (application/json)
//   "article" → text + link preview card          (application/json)
//   "image"   → text + 1-9 images                 (multipart/form-data)
//   "video"   → text + 1 video                    (multipart/form-data)
//
// isDraft (req.body.isDraft):
//   true  (default) → DRAFT    — nobody sees it ✅
//   false           → PUBLISHED — all followers see it ⚠️
//
// visibility (req.body.visibility):
//   "LOGGED_IN"   (default) → only logged-in LinkedIn members ✅
//   "PUBLIC"                → everyone + Google indexed ⚠️
//   "CONNECTIONS"           → only 1st degree connections
//
// Token source: req.session.token
// ─────────────────────────────────────────────────────────────────────────────

import multer from "multer";
import {
  getOrganizations,
  createTextPost,
  createArticlePost,
  registerImageUpload,
  uploadFileBinary,
  createImagePost,
  createMultiImagePost,
  initializeVideoUpload, // ← NEW: replaces registerVideoUpload
  uploadVideoChunks, // ← NEW: replaces uploadFileBinary for video
  finalizeVideoUpload, // ← NEW: confirms upload complete + triggers transcode
  waitForVideoReady, // ← NEW: replaces waitForAssetReady (polls /rest/videos)
  createVideoPost, // ← UPDATED: now uses /rest/posts API
} from "../services/linkedin.post.service.js";
import { logger } from "../utils/logger.js";
import { StatusCodes } from "../constants/statusCodes.constants.js";
import { MESSAGES } from "../constants/messages.constant.js";
import { QUERY_PARAMS } from "../constants/api.constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Multer — single instance, field name "media", accepts images + videos
//
// Size ceiling : 200 MB (video max)
// Per-type limits enforced in the controller after we know postType:
//   image → max 5 MB per file
//   video → only 1 file allowed, no extra size limit beyond multer ceiling
// ─────────────────────────────────────────────────────────────────────────────
export const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: QUERY_PARAMS.MULTER.MAX_FILE_SIZE, // 200 MB hard ceiling
    files: QUERY_PARAMS.MULTER.MAX_FILES, // max 9 files (9 images or 1 video)
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "video/mp4",
      "video/quicktime",
      "video/mpeg",
    ];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(
        new Error(
          "Unsupported file type. Allowed: JPEG, PNG, GIF | MP4, MOV, MPEG",
        ),
        false,
      );
    }
    cb(null, true);
  },
});

// Internal helper — extract Bearer token from session

const getToken = (req, res) => {
  const token = req.session?.token;
  if (!token) {
    logger.error(`[post-controller] No token found in session`);
    res.status(StatusCodes.UNAUTHORIZED).json({
      success: false,
      error: MESSAGES.UNAUTHORIZED,
    });
    return null;
  }
  return token;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — normalize isDraft to boolean
//
// JSON body  : isDraft arrives as boolean true/false
// Form-data  : isDraft arrives as string  "true"/"false"
// Default    : true (draft) — safe unless explicitly set to false
// ─────────────────────────────────────────────────────────────────────────────
const parseBool = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === "")
    return defaultValue;
  if (typeof value === "boolean") return value;
  return value === "true";
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/post/organizations
//
// Returns all LinkedIn org pages the authenticated user administrates.
// Call this FIRST to get organizationId before calling POST /create.
//
// Response shape:
//   {
//     success: true,
//     data: [{ id, urn, role, state }]
//   }
//   id ← copy this as organizationId in all post requests
//
// Required scope: r_organization_admin
// ─────────────────────────────────────────────────────────────────────────────
export const getMyOrganizations = async (req, res) => {
  try {
    const token = getToken(req, res);
    if (!token) return;

    logger.info(`[post-controller] Fetching organizations`);

    const orgs = await getOrganizations(token);

    const formatted = orgs.map((o) => {
      const urn = o.organization || o.organizationUrn || "";
      const id = urn.replace("urn:li:organization:", "");
      return { id, urn, role: o.role, state: o.state };
    });

    logger.info(
      `[post-controller] ✓ Returning ${formatted.length} organization(s)`,
    );

    return res.status(StatusCodes.OK).json({
      success: true,
      message: MESSAGES.OK,
      data: formatted,
    });
  } catch (err) {
    logger.error(`[post-controller] getMyOrganizations: ${err.message}`);
    return res
      .status(err.response?.status || StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/post/create
//
// Single controller for all 4 LinkedIn post types.
// "postType" in the request body selects the flow.
//
// ┌──────────────┬──────────────────────┬─────────────────────────────────────┐
// │  postType    │  Content-Type        │  Required body fields               │
// ├──────────────┼──────────────────────┼─────────────────────────────────────┤
// │  "text"      │  application/json    │  organizationId, text               │
// │  "article"   │  application/json    │  organizationId, text, articleUrl   │
// │  "image"     │  multipart/form-data │  organizationId, text, media(files) │
// │  "video"     │  multipart/form-data │  organizationId, text, media(file)  │
// └──────────────┴──────────────────────┴─────────────────────────────────────┘
//
// isDraft + visibility combinations:
//   isDraft:true  + visibility:"LOGGED_IN" → DRAFT, nobody sees it    ✅ TEST
//   isDraft:false + visibility:"LOGGED_IN" → Live, logged-in only     🔵 SAFE
//   isDraft:false + visibility:"PUBLIC"    → Live, everyone sees it   ⚠️ PROD
//
// Required scope: w_organization_social
// ─────────────────────────────────────────────────────────────────────────────
export const createPost = async (req, res) => {
  const token = getToken(req, res);
  if (!token) return;

  const {
    postType,
    organizationId,
    text,
    visibility = "LOGGED_IN", // safe default
    isDraft: isDraftRaw, // normalized below
    // article only
    articleUrl,
    title,
    description,
    // image only
    imageTitle,
    // video only — NOTE: videoTitle/videoDescription removed
    // The new LinkedIn /rest/videos API does not accept title/description
    // at post-creation time. They are set separately via the Videos API if needed.
  } = req.body;

  const isDraft = parseBool(isDraftRaw, true); // default: true (draft)

  // ── Common validation ─────────────────────────────────────────────────────
  if (!postType) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error:
        'postType is required. Must be: "text" | "article" | "image" | "video"',
    });
  }
  if (!organizationId) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error:
        "organizationId is required. Call GET /api/post/organizations first.",
    });
  }
  if (!text) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: "text is required for all post types",
    });
  }

  logger.info(
    `[post-controller] 🚀 createPost → postType:${postType} | org:${organizationId} | isDraft:${isDraft} | visibility:${visibility}`,
  );

  try {
    let result;

    switch (postType) {
      // ──────────────────────────────────────────────────────────────────────
      // TEXT POST
      // 1 API call → /rest/posts
      // ──────────────────────────────────────────────────────────────────────
      case "text": {
        logger.info(`[post-controller] → TEXT flow`);

        result = await createTextPost(
          token,
          organizationId,
          text,
          visibility,
          isDraft,
        );
        break;
      }

      // ──────────────────────────────────────────────────────────────────────
      // ARTICLE POST
      // 1 API call → /v2/ugcPosts (LinkedIn auto-fetches OG tags from URL)
      // ──────────────────────────────────────────────────────────────────────
      case "article": {
        logger.info(`[post-controller] → ARTICLE flow`);

        if (!articleUrl) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            success: false,
            error: "articleUrl is required for article posts",
          });
        }

        result = await createArticlePost(
          token,
          organizationId,
          text,
          articleUrl,
          title || "",
          description || "",
          visibility,
          isDraft,
        );
        break;
      }

      // ──────────────────────────────────────────────────────────────────────
      // IMAGE POST (single or multiple — up to 9)
      //
      // Per image:
      //   Step 1 — registerImageUpload  → get uploadUrl + assetUrn
      //   Step 2 — uploadFileBinary     → PUT image to LinkedIn CDN
      // Then:
      //   1 image  → createImagePost      → /v2/ugcPosts
      //   2-9 imgs → createMultiImagePost → /v2/ugcPosts with array
      // ──────────────────────────────────────────────────────────────────────
      case "image": {
        logger.info(`[post-controller] → IMAGE flow`);

        if (!req.files || req.files.length === 0) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            success: false,
            error:
              'At least one image file is required. Use field name "media".',
          });
        }

        const imageTypes = ["image/jpeg", "image/png", "image/gif"];
        const IMAGE_LIMIT = 5 * 1024 * 1024; // 5 MB per image
        const assetUrns = [];

        for (const file of req.files) {
          if (!imageTypes.includes(file.mimetype)) {
            return res.status(StatusCodes.BAD_REQUEST).json({
              success: false,
              error: `Invalid image type: ${file.mimetype}. Allowed: JPEG, PNG, GIF`,
            });
          }
          if (file.size > IMAGE_LIMIT) {
            return res.status(StatusCodes.BAD_REQUEST).json({
              success: false,
              error: `Image too large: ${(file.size / 1024 / 1024).toFixed(2)} MB. Max: 5 MB`,
            });
          }

          // Step 1 — register upload slot
          const { uploadUrl, assetUrn } = await registerImageUpload(
            token,
            organizationId,
          );

          // Step 2 — push image bytes to LinkedIn CDN
          await uploadFileBinary(uploadUrl, file.buffer, file.mimetype);

          assetUrns.push(assetUrn);
          logger.info(`[post-controller] Image uploaded with URN: ${assetUrn}`);
        }

        // Single image or multi-image
        if (assetUrns.length === 1) {
          result = await createImagePost(
            token,
            organizationId,
            text,
            assetUrns[0],
            imageTitle || "",
            visibility,
            isDraft,
          );
        } else {
          result = await createMultiImagePost(
            token,
            organizationId,
            text,
            assetUrns,
            visibility,
            isDraft,
          );
        }

        result.assetUrns = assetUrns;
        break;
      }

      // ──────────────────────────────────────────────────────────────────────
      // VIDEO POST — FIXED with new /rest/videos API
      //
      // Old broken flow:
      //   /v2/assets?action=registerUpload → urn:li:digitalmediaAsset:...
      //   /v2/ugcPosts with that URN → 400 "Invalid asset id" ❌
      //
      // New correct flow (5 steps):
      //   Step 1 — initializeVideoUpload → get uploadInstructions + videoUrn
      //            videoUrn is urn:li:video:... (not digitalmediaAsset)
      //   Step 2 — uploadVideoChunks     → PUT chunks, collect ETags
      //   Step 3 — finalizeVideoUpload   → confirm upload, trigger transcoding
      //   Step 4 — waitForVideoReady     → poll /rest/videos until AVAILABLE
      //   Step 5 — createVideoPost       → /rest/posts with content.media.id
      // ──────────────────────────────────────────────────────────────────────
      case "video": {
        logger.info(`[post-controller] → VIDEO flow`);

        if (!req.files || req.files.length === 0) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            success: false,
            error: 'A video file is required. Use field name "media".',
          });
        }

        if (req.files.length > 1) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            success: false,
            error: "LinkedIn supports only ONE video per post",
          });
        }

        const file = req.files[0];
        const videoTypes = ["video/mp4", "video/quicktime", "video/mpeg"];

        if (!videoTypes.includes(file.mimetype)) {
          return res.status(StatusCodes.BAD_REQUEST).json({
            success: false,
            error: `Invalid video type: ${file.mimetype}. Allowed: MP4, MOV, MPEG`,
          });
        }

        // Step 1 — initialize upload → get chunk URLs + videoUrn + uploadToken
        logger.info(
          `[post-controller] Step 1 → initializeVideoUpload (${(file.size / 1024 / 1024).toFixed(2)} MB)`,
        );
        const { uploadInstructions, videoUrn, uploadToken } =
          await initializeVideoUpload(token, organizationId, file.size);

        logger.info(`[post-controller] videoUrn: ${videoUrn}`);

        // Step 2 — upload video in chunks, collect ETags
        logger.info(
          `[post-controller] Step 2 → uploading ${uploadInstructions.length} chunk(s)`,
        );
        const uploadedPartIds = await uploadVideoChunks(
          uploadInstructions,
          file.buffer,
        );

        logger.info(
          `[post-controller] ✓ Chunks uploaded, ETags: ${JSON.stringify(uploadedPartIds)}`,
        );

        // Step 3 — finalize upload (triggers LinkedIn transcoding)
        logger.info(`[post-controller] Step 3 → finalizeVideoUpload`);
        await finalizeVideoUpload(
          token,
          videoUrn,
          uploadToken,
          uploadedPartIds,
        );

        // Step 4 — wait for LinkedIn to finish transcoding (max 2 minutes)
        logger.info(
          `[post-controller] Step 4 → waitForVideoReady (polling every 5s, max 2 min)`,
        );
        await waitForVideoReady(token, videoUrn, 120000);
        logger.info(`[post-controller] Video AVAILABLE and ready to post`);

        // Step 5 — create the post referencing the video URN
        logger.info(`[post-controller] Step 5 → createVideoPost`);
        result = await createVideoPost(
          token,
          organizationId,
          text,
          videoUrn,
          visibility,
          isDraft,
        );

        result.videoUrn = videoUrn;
        break;
      }

      // ──────────────────────────────────────────────────────────────────────
      // UNKNOWN postType
      // ──────────────────────────────────────────────────────────────────────
      default: {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          error: `Unknown postType "${postType}". Must be: "text" | "article" | "image" | "video"`,
        });
      }
    }

    // ── Success ───────────────────────────────────────────────────────────────
    const typeLabel = postType.charAt(0).toUpperCase() + postType.slice(1);
    const stateLabel = isDraft ? "saved as DRAFT" : "published LIVE";

    logger.info(
      `[post-controller] ✅ ${typeLabel} post ${stateLabel} → ${result.postUrn}`,
    );

    return res.status(StatusCodes.OK).json({
      success: true,
      message: `${typeLabel} post ${stateLabel} on LinkedIn`,
      data: result,
    });
  } catch (err) {
    logger.error(
      `[post-controller] ✗ createPost failed (postType:${postType}): ${err.message}`,
    );
    logger.error(
      `[post-controller] LinkedIn API response: ${JSON.stringify(err.response?.data)}`,
    );

    return res
      .status(err.response?.status || StatusCodes.INTERNAL_SERVER_ERROR)
      .json({
        success: false,
        error: err.response?.data?.message || err.message,
      });
  }
};
