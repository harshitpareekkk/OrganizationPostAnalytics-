// ─────────────────────────────────────────────────────────────────────────────
// linkedin.post.service.js
//
// Pure LinkedIn API layer — no Express, no req/res, just API calls.
//
// API versions used:
//   Text post    → /rest/posts        (LinkedIn-Version: 202503) ← new API
//   Article post → /v2/ugcPosts       (X-Restli-Protocol-Version) ← old UGC (working)
//   Image post   → /v2/ugcPosts       (X-Restli-Protocol-Version) ← old UGC (working)
//   Video post   → /rest/videos       (LinkedIn-Version: 202503) ← NEW — fixes 400 error
//
// WHY video was broken:
//   Old flow used /v2/assets → returned urn:li:digitalmediaAsset:...
//   LinkedIn's ugcPosts API rejects this asset ID for videos with 400.
//   Fix: use /rest/videos → returns urn:li:video:... which is accepted.
//
// isDraft:
//   true  → lifecycleState: "DRAFT"     → saved privately, nobody sees it ✅
//   false → lifecycleState: "PUBLISHED" → goes live to all followers ⚠️
//
// Default for ALL post functions:
//   isDraft    = true         ← SAFE — always draft unless explicitly false
//   visibility = "LOGGED_IN" ← SAFE — only logged-in LinkedIn members

import axios from "axios";
import { API_ENDPOINTS } from "../constants/api.constants.js";
import {
  getLinkedInUGCHeaders,
  getLinkedInRESTHeaders,
} from "../constants/headers.constants.js";
import {
  POST_DEFAULTS,
  LINKEDIN_VISIBILITY,
  LINKEDIN_POST_STATE,
  POST_TYPES,
} from "../constants/app.constants.js";

const LI_BASE_V2 = API_ENDPOINTS.LINKEDIN.BASE_V2;
const LI_BASE_REST = API_ENDPOINTS.LINKEDIN.BASE_REST;

// Header builders — now delegated to constants
const ugcHeaders = (token) => getLinkedInUGCHeaders(token);
const restHeaders = (token) => getLinkedInRESTHeaders(token);

// ─────────────────────────────────────────────────────────────────────────────
// getOrganizations
//
// Fetches all org pages the authenticated user has ADMINISTRATOR role on.
//
// Scope:   r_organization_admin
// Returns: Array of raw LinkedIn organizationAcl elements
//   Each element has: organization (urn), role, state
// ─────────────────────────────────────────────────────────────────────────────
export const getOrganizations = async (token) => {
  const response = await axios.get(`${LI_BASE_V2}/organizationAcls`, {
    headers: ugcHeaders(token),
    params: {
      q: "roleAssignee",
      role: "ADMINISTRATOR",
      state: "APPROVED",
    },
  });

  return response.data.elements || [];
};

// ─────────────────────────────────────────────────────────────────────────────
// createTextPost
// Creates a plain-text post on an org page using the new /rest/posts API.
//
// isDraft = true  → lifecycleState: DRAFT      → nobody sees it
// isDraft = false → lifecycleState: PUBLISHED  → all followers see it
//
// Scope:   w_organization_social
// Returns: { postId, postUrn, isDraft, visibility }
// ─────────────────────────────────────────────────────────────────────────────
export const createTextPost = async (
  token,
  organizationId,
  text,
  visibility = LINKEDIN_VISIBILITY.LOGGED_IN,
  isDraft = POST_DEFAULTS.IS_DRAFT,
) => {
  const body = {
    author: `urn:li:organization:${organizationId}`,
    commentary: text,
    visibility: visibility,
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: isDraft
      ? LINKEDIN_POST_STATE.DRAFT
      : LINKEDIN_POST_STATE.PUBLISHED,
    isReshareDisabledByAuthor: false,
  };

  const response = await axios.post(`${LI_BASE_REST}/posts`, body, {
    headers: restHeaders(token),
  });

  // New REST API returns the post URN in the x-restli-id header
  const postUrn = response.headers["x-restli-id"] || response.data?.id || "";

  return {
    postId: postUrn,
    postUrn,
    isDraft,
    visibility,
  };
};

// createArticlePost on linkedIn organization page
export const createArticlePost = async (
  token,
  organizationId,
  text,
  articleUrl,
  title = "",
  description = "",
  visibility = LINKEDIN_VISIBILITY.LOGGED_IN,
  isDraft = POST_DEFAULTS.IS_DRAFT,
) => {
  const media = {
    status: "READY",
    originalUrl: articleUrl,
  };

  // Only include title/description if provided — LinkedIn auto-fetches from URL
  if (title) media.title = { text: title };
  if (description) media.description = { text: description };

  const body = {
    author: `urn:li:organization:${organizationId}`,
    lifecycleState: isDraft
      ? LINKEDIN_POST_STATE.DRAFT
      : LINKEDIN_POST_STATE.PUBLISHED,
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: POST_TYPES.ARTICLE,
        media: [media],
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": visibility,
    },
  };

  const response = await axios.post(`${LI_BASE_V2}/ugcPosts`, body, {
    headers: ugcHeaders(token),
  });

  const postUrn = response.data.id || response.headers["x-restli-id"] || "";
  const postId = postUrn.replace("urn:li:ugcPost:", "");

  return {
    postId,
    postUrn,
    postUrl: `https://www.linkedin.com/feed/update/${postUrn}`,
    isDraft,
    visibility,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// registerImageUpload
//
// Step 1 of image post flow.
// Tells LinkedIn you're about to upload an image and gets back:
//   - uploadUrl  → PUT your image binary here
//   - assetUrn   → reference this in createImagePost
//
// Scope:   w_organization_social
// Returns: { uploadUrl, assetUrn }
// ─────────────────────────────────────────────────────────────────────────────
export const registerImageUpload = async (token, organizationId) => {
  const body = {
    registerUploadRequest: {
      owner: `urn:li:organization:${organizationId}`,
      recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
      serviceRelationships: [
        {
          identifier: "urn:li:userGeneratedContent",
          relationshipType: "OWNER",
        },
      ],
      supportedUploadMechanism: ["SYNCHRONOUS_UPLOAD"],
    },
  };

  const response = await axios.post(
    `${LI_BASE_V2}/assets?action=registerUpload`,
    body,
    { headers: ugcHeaders(token) },
  );

  const value = response.data.value;
  const uploadUrl =
    value.uploadMechanism[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ].uploadUrl;
  const assetUrn = value.asset;

  return { uploadUrl, assetUrn };
};

// ─────────────────────────────────────────────────────────────────────────────
// uploadFileBinary
//
// Step 2 for image post flow (and video chunk upload).
// PUTs the raw file buffer to LinkedIn's CDN using the uploadUrl.
// Returns the ETag from the response header (needed for video finalize step).
// ─────────────────────────────────────────────────────────────────────────────
export const uploadFileBinary = async (uploadUrl, fileBuffer, mimeType) => {
  const response = await axios.put(uploadUrl, fileBuffer, {
    headers: {
      "Content-Type": mimeType,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // Return ETag — needed for finalizeVideoUpload (image upload ignores this)
  return response.headers["etag"] || response.headers["ETag"] || "";
};

// ─────────────────────────────────────────────────────────────────────────────
// createImagePost
//
// Step 3 of image post flow.
// Creates the ugcPost body referencing the uploaded assetUrn.
//
// isDraft = true  → lifecycleState: DRAFT      → nobody sees it
// isDraft = false → lifecycleState: PUBLISHED  → all followers see it
//
// Scope:   w_organization_social
// Returns: { postId, postUrn, postUrl, isDraft, visibility }
// ─────────────────────────────────────────────────────────────────────────────
export const createImagePost = async (
  token,
  organizationId,
  text,
  assetUrn,
  imageTitle = "",
  visibility = LINKEDIN_VISIBILITY.LOGGED_IN,
  isDraft = POST_DEFAULTS.IS_DRAFT,
) => {
  const mediaEntry = {
    status: "READY",
    media: assetUrn,
  };
  if (imageTitle) mediaEntry.title = { text: imageTitle };

  const body = {
    author: `urn:li:organization:${organizationId}`,
    lifecycleState: isDraft
      ? LINKEDIN_POST_STATE.DRAFT
      : LINKEDIN_POST_STATE.PUBLISHED,
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: POST_TYPES.IMAGE,
        media: [mediaEntry],
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": visibility,
    },
  };

  const response = await axios.post(`${LI_BASE_V2}/ugcPosts`, body, {
    headers: ugcHeaders(token),
  });

  const postUrn = response.data.id || response.headers["x-restli-id"] || "";
  const postId = postUrn.replace("urn:li:ugcPost:", "");

  return {
    postId,
    postUrn,
    postUrl: `https://www.linkedin.com/feed/update/${postUrn}`,
    isDraft,
    visibility,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// createMultiImagePost
//
// Creates a post with multiple images (up to 9) on an org page.
// All images must be pre-uploaded — pass their assetUrns as an array.
//
// isDraft = true  → lifecycleState: DRAFT      → nobody sees it ✅
// isDraft = false → lifecycleState: PUBLISHED  → all followers see it ⚠️
//
// Scope:   w_organization_social
// Returns: { postId, postUrn, postUrl, isDraft, visibility }
// ─────────────────────────────────────────────────────────────────────────────
export const createMultiImagePost = async (
  token,
  organizationId,
  text,
  assetUrns,
  visibility = LINKEDIN_VISIBILITY.LOGGED_IN,
  isDraft = POST_DEFAULTS.IS_DRAFT,
) => {
  const media = assetUrns.map((urn) => ({
    status: "READY",
    media: urn,
  }));

  const body = {
    author: `urn:li:organization:${organizationId}`,
    lifecycleState: isDraft
      ? LINKEDIN_POST_STATE.DRAFT
      : LINKEDIN_POST_STATE.PUBLISHED,
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: POST_TYPES.IMAGE,
        media,
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": visibility,
    },
  };

  const response = await axios.post(`${LI_BASE_V2}/ugcPosts`, body, {
    headers: ugcHeaders(token),
  });

  const postUrn = response.data.id || response.headers["x-restli-id"] || "";

  return {
    postId: postUrn.replace("urn:li:ugcPost:", ""),
    postUrn,
    postUrl: `https://www.linkedin.com/feed/update/${postUrn}`,
    isDraft,
    visibility,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// VIDEO UPLOAD — NEW /rest/videos API
//
// WHY the old flow was broken:
//   Old: /v2/assets?action=registerUpload → urn:li:digitalmediaAsset:...
//        /v2/ugcPosts with that asset → LinkedIn returns 400 "Invalid asset id"
//
// New flow (4 steps):
//   1. initializeVideoUpload → /rest/videos?action=initializeUpload
//      → returns uploadInstructions (array of chunk URLs), videoUrn, uploadToken
//   2. uploadVideoChunks → PUT each chunk to its uploadUrl, collect ETags
//   3. finalizeVideoUpload → /rest/videos?action=finalizeUpload
//      → confirms upload complete with ETags
//   4. waitForVideoReady → GET /rest/videos/{urn} until status = AVAILABLE
//   5. createVideoPost → /rest/posts with content.media.id = videoUrn
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// initializeVideoUpload
//
// Step 1 of video post flow.
// Tells LinkedIn you're about to upload a video and gets back:
//   - uploadInstructions → array of { uploadUrl, firstByte, lastByte }
//   - videoUrn           → urn:li:video:... (use this in createVideoPost)
//   - uploadToken        → pass to finalizeVideoUpload
//
// Scope:   w_organization_social
// Returns: { uploadInstructions, videoUrn, uploadToken }
// ─────────────────────────────────────────────────────────────────────────────
export const initializeVideoUpload = async (
  token,
  organizationId,
  fileSizeBytes,
) => {
  const body = {
    initializeUploadRequest: {
      owner: `urn:li:organization:${organizationId}`,
      fileSizeBytes,
      uploadCaptions: false,
      uploadThumbnail: false,
    },
  };

  const response = await axios.post(
    `${LI_BASE_REST}/videos?action=initializeUpload`,
    body,
    { headers: restHeaders(token) },
  );

  const {
    uploadInstructions,
    video: videoUrn,
    uploadToken,
  } = response.data.value;

  return { uploadInstructions, videoUrn, uploadToken };
};

// ─────────────────────────────────────────────────────────────────────────────
// uploadVideoChunks
//
// Step 2 of video post flow.
// Uploads the video file in chunks (LinkedIn may split large files).
// For files under ~200MB there is usually just 1 instruction (1 chunk).
//
// Returns: uploadedPartIds — array of ETags, one per chunk
//          (required by finalizeVideoUpload)
// ─────────────────────────────────────────────────────────────────────────────
export const uploadVideoChunks = async (uploadInstructions, fileBuffer) => {
  const uploadedPartIds = [];

  for (const instruction of uploadInstructions) {
    const { uploadUrl, firstByte, lastByte } = instruction;

    // Slice the exact byte range for this chunk
    const chunk = fileBuffer.slice(firstByte, lastByte + 1);

    const response = await axios.put(uploadUrl, chunk, {
      headers: {
        "Content-Type": "application/octet-stream",
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    // LinkedIn returns an ETag for each chunk — collect them all
    const etag = response.headers["etag"] || response.headers["ETag"] || "";
    uploadedPartIds.push(etag);
  }

  return uploadedPartIds;
};

// ─────────────────────────────────────────────────────────────────────────────
// finalizeVideoUpload
//
// Step 3 of video post flow.
// Tells LinkedIn the upload is complete and passes the ETags from each chunk.
// LinkedIn will start transcoding the video after this call.
//
// Scope:   w_organization_social
// ─────────────────────────────────────────────────────────────────────────────
export const finalizeVideoUpload = async (
  token,
  videoUrn,
  uploadToken,
  uploadedPartIds,
) => {
  const body = {
    finalizeUploadRequest: {
      video: videoUrn,
      uploadToken,
      uploadedPartIds,
    },
  };

  await axios.post(`${LI_BASE_REST}/videos?action=finalizeUpload`, body, {
    headers: restHeaders(token),
  });
  // LinkedIn returns 200 with no body on success
};

// ─────────────────────────────────────────────────────────────────────────────
// waitForVideoReady
//
// Step 4 of video post flow.
// Polls /rest/videos/{urn} every 5 seconds until status becomes AVAILABLE.
// LinkedIn transcodes the video asynchronously after finalizeUpload.
//
// status values:
//   PROCESSING         → still transcoding, keep polling
//   AVAILABLE          → ready to reference in a post ✅
//   PROCESSING_FAILED  → transcoding failed, throw error ❌
//
// Throws if:
//   - Status becomes PROCESSING_FAILED
//   - Timeout exceeded (default: 2 minutes)
// ─────────────────────────────────────────────────────────────────────────────
export const waitForVideoReady = async (
  token,
  videoUrn,
  timeoutMs = 120000,
) => {
  const encodedUrn = encodeURIComponent(videoUrn);
  const pollInterval = 5000; // poll every 5 seconds
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await axios.get(`${LI_BASE_REST}/videos/${encodedUrn}`, {
      headers: restHeaders(token),
    });

    const status = response.data.status;

    if (status === "AVAILABLE") {
      return; // ✅ ready to post
    }

    if (status === "PROCESSING_FAILED") {
      throw new Error(`LinkedIn video transcoding failed for: ${videoUrn}`);
    }

    // Still PROCESSING — wait and try again
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timed out waiting for LinkedIn video to be ready: ${videoUrn}. ` +
      `Video may still be processing — check LinkedIn directly.`,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// createVideoPost
//
// Step 5 of video post flow.
// Creates a post referencing the processed video using the new /rest/posts API.
// Uses videoUrn (urn:li:video:...) — NOT the old urn:li:digitalmediaAsset:...
//
// isDraft = true  → lifecycleState: DRAFT      → nobody sees it ✅
// isDraft = false → lifecycleState: PUBLISHED  → all followers see it ⚠️
//
// Scope:   w_organization_social
// Returns: { postId, postUrn, isDraft, visibility }
// ─────────────────────────────────────────────────────────────────────────────
export const createVideoPost = async (
  token,
  organizationId,
  text,
  videoUrn, // must be urn:li:video:... (from initializeVideoUpload)
  visibility = LINKEDIN_VISIBILITY.LOGGED_IN,
  isDraft = POST_DEFAULTS.IS_DRAFT,
) => {
  const body = {
    author: `urn:li:organization:${organizationId}`,
    commentary: text,
    visibility: visibility,
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: {
      media: {
        id: videoUrn, // urn:li:video:... — this is what the new API expects
      },
    },
    lifecycleState: isDraft
      ? LINKEDIN_POST_STATE.DRAFT
      : LINKEDIN_POST_STATE.PUBLISHED,
    isReshareDisabledByAuthor: false,
  };

  const response = await axios.post(`${LI_BASE_REST}/posts`, body, {
    headers: restHeaders(token),
  });

  // New REST API returns post URN in x-restli-id header
  const postUrn = response.headers["x-restli-id"] || response.data?.id || "";

  return {
    postId: postUrn,
    postUrn,
    isDraft,
    visibility,
  };
};
