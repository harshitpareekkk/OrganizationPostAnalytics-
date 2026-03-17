import axios from "axios";
import { logger } from "../utils/logger.js";

const BASE = "https://api.linkedin.com/v2";
const PAGE_SIZE = 50;
const authorCache = {};

const fetchAuthorName = async (token, authorUrn) => {
  if (!authorUrn) return "";
  if (authorCache[authorUrn]) return authorCache[authorUrn];

  try {
    const memberId = authorUrn.split(":").pop(); // "abc123"
    const res = await axios.get(`${BASE}/people/(id:${memberId})`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { projection: "(id,firstName,lastName)" },
    });

    const data = res.data || {};
    const first = data.firstName?.localized
      ? Object.values(data.firstName.localized)[0]
      : "";
    const last = data.lastName?.localized
      ? Object.values(data.lastName.localized)[0]
      : "";

    const name = `${first} ${last}`.trim() || authorUrn;
    authorCache[authorUrn] = name;
    logger.info(`[linkedin] Author resolved: ${authorUrn}`);
    return name;
  } catch (err) {
    // People API may return 403 if no profile access — gracefully fall back to URN
    logger.warn(
      `[linkedin] Could not fetch author for ${authorUrn}: ${err.message}`,
    );
    authorCache[authorUrn] = authorUrn;
    return authorUrn;
  }
};

// Extract post details
export const extractPostDetails = (post, resolvedAuthorName = "") => {
  const postId = post.id;

  return {
    postId,
    // FULL text — not .slice(), not truncated in any way
    text: post?.text?.text || "",
    postType: post?.content?.shareMediaCategory || "TEXT",
    // Real post URL for clicking through from Monday board
    postUrl: `https://www.linkedin.com/feed/update/urn:li:share:${postId}`,
    owner: post.owner || "",
    authorId: post.author || post.owner || "", // person URN who posted
    authorName: resolvedAuthorName || post.author || post.owner || "",
    createdAt: post?.created?.time
      ? new Date(post.created.time).toISOString()
      : null,
  };
};

// ─── Fetch last 3 months posts ────────────────────────────────────────────────

export const fetchLastThreeMonthsPosts = async () => {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORG_ID;

  const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  logger.info(`[linkedin] Fetching posts from last 90 days`);

  const collected = [];
  let start = 0;
  let pageCount = 0;
  let totalPosts = null;
  let stop = false;

  while (!stop) {
    pageCount++;
    const url = `${BASE}/shares?q=owners&owners=${orgId}&count=${PAGE_SIZE}&start=${start}`;
    logger.info(`[linkedin] Fetching page ${pageCount}`);

    let res;
    try {
      res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      logger.error(
        `[linkedin] Failed to fetch page ${pageCount}: ${err.message}`,
      );
      break;
    }

    const elements = res.data?.elements || [];

    if (pageCount === 1 && res.data?.paging?.total !== undefined) {
      totalPosts = res.data.paging.total;
      logger.info(`[linkedin] Total posts available: ${totalPosts}`);
    }

    logger.info(
      `[linkedin] Page ${pageCount}: fetched ${elements.length} posts`,
    );

    if (elements.length === 0) {
      break;
    }

    for (const post of elements) {
      const postTimeMs = post?.created?.time ?? 0;
      const postDate = postTimeMs
        ? new Date(postTimeMs).toISOString()
        : "no-date";

      if (postTimeMs > 0 && postTimeMs < cutoffMs) {
        logger.info(`[linkedin] Reached posts older than 90 days, stopping`);
        stop = true;
        break;
      }

      collected.push(post);
    }

    if (stop) break;

    start += PAGE_SIZE;
    if (totalPosts !== null && start >= totalPosts) {
      logger.info(`[linkedin] Reached end of available posts`);
      break;
    }
  }

  // ── Resolve all author names in bulk (one API call per unique author) ──
  logger.info(
    `[linkedin] Resolving author names for ${collected.length} posts`,
  );
  const uniqueAuthorUrns = [
    ...new Set(collected.map((p) => p.author || p.owner).filter(Boolean)),
  ];
  for (const urn of uniqueAuthorUrns) {
    await fetchAuthorName(token, urn);
  }

  logger.info(
    `[linkedin] Posts collection complete: ${collected.length} posts`,
  );

  // Attach resolved author name onto each post so extractPostDetails can use it
  return collected.map((post) => ({
    ...post,
    _resolvedAuthorName: authorCache[post.author || post.owner] || "",
  }));
};

// Fetch post analytics
export const fetchPostStats = async (postId) => {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORG_ID;

  const url =
    `${BASE}/organizationalEntityShareStatistics?q=organizationalEntity` +
    `&organizationalEntity=${orgId}&shares=urn:li:share:${postId}`;

  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const stats = res.data.elements?.[0]?.totalShareStatistics || {};

    const impressionCount = stats.impressionCount ?? 0;
    const clickCount = stats.clickCount ?? 0;

    // CTR as a percentage (2 decimal places)
    const ctr =
      impressionCount > 0
        ? parseFloat(((clickCount / impressionCount) * 100).toFixed(2))
        : 0;

    return {
      likeCount: stats.likeCount ?? 0,
      commentCount: stats.commentCount ?? 0,
      impressionCount,
      uniqueImpressionsCount: stats.uniqueImpressionsCount ?? 0,
      shareCount: stats.shareCount ?? 0,
      clickCount,
      engagement: parseFloat((stats.engagement ?? 0).toFixed(6)),
      ctr,
    };
  } catch (err) {
    logger.error(
      `[linkedin] Failed to fetch analytics for post ${postId}: ${err.message}`,
    );
    return {
      likeCount: 0,
      commentCount: 0,
      impressionCount: 0,
      uniqueImpressionsCount: 0,
      shareCount: 0,
      clickCount: 0,
      engagement: 0,
      ctr: 0,
    };
  }
};
