import axios from "axios";
import { logger } from "../utils/logger.js";

const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_REST_BASE = "https://api.linkedin.com/rest";
const LINKEDIN_V2_BASE = "https://api.linkedin.com/v2";
const MONDAY_API_URL = "https://api.monday.com/v2";

// ─────────────────────────────────────────────────────────────────────────────
// Build LinkedIn OAuth Authorization URL
// ─────────────────────────────────────────────────────────────────────────────
export const buildLinkedInAuthUrl = (clientId, redirectUri, state) => {
  const scopes = [
    "r_organization_social",
    "w_organization_social",
    "r_organization_admin",
    "rw_organization_admin",
    "r_ads",
    "r_ads_reporting",
    "openid",
    "profile",
    "email",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
  });

  const url = `${LINKEDIN_AUTH_URL}?${params.toString()}`;
  logger.info(`[linkedin-auth] Built LinkedIn auth URL`);
  return url;
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch LinkedIn member profile (name, email, sub)
// ─────────────────────────────────────────────────────────────────────────────
export const fetchLinkedInProfile = async (accessToken) => {
  logger.info(`[linkedin-auth] Fetching LinkedIn member profile`);

  try {
    const res = await axios.get(`${LINKEDIN_V2_BASE}/userinfo`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": "202503",
      },
      timeout: 10000,
    });

    logger.info(
      `[linkedin-auth] ✓ Profile fetched: ${res.data.name} (${res.data.sub})`,
    );
    return res.data;
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Failed to fetch profile: ${err.message}`);
    logger.error(
      `[linkedin-auth] Response: ${JSON.stringify(err.response?.data)}`,
    );
    throw new Error(`Failed to fetch LinkedIn profile: ${err.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch ALL org pages the authenticated user administrates
// ─────────────────────────────────────────────────────────────────────────────
export const fetchAdminOrganizations = async (accessToken) => {
  logger.info(`[linkedin-auth] Fetching all org pages user is admin of`);

  try {
    const aclRes = await axios.get(
      `${LINKEDIN_REST_BASE}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "LinkedIn-Version": "202503",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        timeout: 15000,
      },
    );

    const aclElements = aclRes.data?.elements || [];
    logger.info(`[linkedin-auth] ✓ Found ${aclElements.length} org(s)`);

    if (aclElements.length === 0) return [];

    const orgDetails = await Promise.all(
      aclElements.map(async (acl) => {
        const urn = acl.organization || acl.organizationUrn || "";
        const orgId = urn.replace("urn:li:organization:", "");

        try {
          const orgRes = await axios.get(
            `${LINKEDIN_REST_BASE}/organizations/${orgId}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "LinkedIn-Version": "202503",
                "X-Restli-Protocol-Version": "2.0.0",
              },
              timeout: 10000,
            },
          );

          const org = orgRes.data;
          return {
            id: orgId,
            urn,
            name:
              org.localizedName ||
              org.name?.localized?.en_US ||
              `Organization ${orgId}`,
            vanityName: org.vanityName || "",
          };
        } catch (orgErr) {
          logger.warn(
            `[linkedin-auth] Could not fetch details for org ${orgId}: ${orgErr.message}`,
          );
          return {
            id: orgId,
            urn,
            name: `Organization ${orgId}`,
            vanityName: "",
          };
        }
      }),
    );

    logger.info(
      `[linkedin-auth] ✓ Org details ready for ${orgDetails.length} organization(s):`,
    );
    orgDetails.forEach((o) => logger.info(`  → ${o.name} (${o.id})`));

    return orgDetails;
  } catch (err) {
    logger.error(
      `[linkedin-auth] ✗ Failed to fetch organizations: ${err.message}`,
    );
    logger.error(
      `[linkedin-auth] Response: ${JSON.stringify(err.response?.data)}`,
    );
    throw new Error(`Failed to fetch LinkedIn organizations: ${err.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Create Monday workspace + 2 boards for one LinkedIn org page
//
// ── THE FIX: mondayAccountId parameter + Account-Id header ──
//
// PROBLEM:
//   Previously used MONDAY_API_KEY (developer's personal token) → boards
//   created in the DEVELOPER's Monday account, not the installing tenant's.
//
// SOLUTION:
//   Use MONDAY_APP_TOKEN (app-level token from Developer Center) PLUS
//   the "Account-Id" header set to the TENANT's accountId.
//
//   Monday's API routes the request to the correct tenant when it sees:
//     Authorization: <MONDAY_APP_TOKEN>   ← identifies the app
//     Account-Id: <mondayAccountId>        ← identifies which tenant to act in
//
// HOW TO GET MONDAY_APP_TOKEN:
//   Monday Developer Center → Your App → General settings
//   → scroll down → "App token" section → copy → add to .env as MONDAY_APP_TOKEN
//
// Parameters:
//   mondayToken    {string}  MONDAY_APP_TOKEN from env
//   org            {object}  LinkedIn org page { id, name, urn, vanityName }
//   mondayAccountId {string} The TENANT accountId (from JWT in /provider-id)
// ─────────────────────────────────────────────────────────────────────────────
export const createWorkspaceAndBoards = async (
  mondayToken,
  org,
  mondayAccountId,
) => {
  logger.info(
    `[linkedin-auth] Creating workspace + boards for org: ${org.name} (${org.id})`,
  );
  logger.info(
    `[linkedin-auth] Target Monday account: ${mondayAccountId || "NOT SET — boards will go to developer account!"}`,
  );

  if (!mondayToken) {
    throw new Error(
      "mondayToken (MONDAY_APP_TOKEN) is required for board creation",
    );
  }

  if (!mondayAccountId) {
    logger.warn(
      `[linkedin-auth] ⚠ mondayAccountId not provided — boards may go to wrong account!`,
    );
  }

  // Build headers — Account-Id routes the request to the correct tenant
  const headers = {
    Authorization: mondayToken,
    "Content-Type": "application/json",
    "API-Version": "2024-01",
  };

  // ← THE KEY FIX: include Account-Id header so Monday creates in tenant account
  if (mondayAccountId) {
    headers["Account-Id"] = String(mondayAccountId);
  }

  const mondayClient = axios.create({
    baseURL: MONDAY_API_URL,
    headers,
    timeout: 30000,
  });

  const gql = async (query, variables = {}) => {
    const res = await mondayClient.post("", { query, variables });
    if (res.data.errors?.length) {
      throw new Error(`Monday GraphQL error: ${res.data.errors[0].message}`);
    }
    return res.data.data;
  };

  // ── Create workspace ───────────────────────────────────────────────────────
  const workspaceName = `${org.name} — LinkedIn`;

  const workspaceResult = await gql(
    `mutation CreateWorkspace($name: String!, $kind: WorkspaceKind!) {
      create_workspace(name: $name, kind: $kind) { id name }
    }`,
    { name: workspaceName, kind: "open" },
  );

  const workspaceId = workspaceResult.create_workspace.id;
  logger.info(
    `[linkedin-auth] ✓ Workspace: "${workspaceName}" (ID: ${workspaceId}) in account ${mondayAccountId}`,
  );

  // ── Create "LinkedIn Post Planner" board ───────────────────────────────────
  const plannerResult = await gql(
    `mutation CreateBoard($name: String!, $kind: BoardKind!, $workspaceId: ID!) {
      create_board(board_name: $name, board_kind: $kind, workspace_id: $workspaceId) { id name }
    }`,
    { name: "LinkedIn Post Planner", kind: "public", workspaceId },
  );

  const plannerBoardId = plannerResult.create_board.id;
  logger.info(`[linkedin-auth] ✓ Post Planner board (ID: ${plannerBoardId})`);

  const plannerColumns = [
    { title: "Post Owner", type: "people" },
    {
      title: "Post Type",
      type: "dropdown",
      defaults: JSON.stringify({
        settings_str: JSON.stringify({
          labels: [
            { id: 1, name: "Text" },
            { id: 2, name: "Article" },
            { id: 3, name: "Image" },
            { id: 4, name: "Video" },
          ],
        }),
      }),
    },
    { title: "Caption", type: "long_text" },
    { title: "Post Description", type: "long_text" },
    { title: "Article URL", type: "link" },
    { title: "Media Files", type: "file" },
    { title: "Posting Date", type: "date" },
    {
      title: "Approval Status",
      type: "status",
      defaults: JSON.stringify({
        settings_str: JSON.stringify({
          labels: {
            5: "Draft",
            6: "In Review",
            12: "Changes Required",
            2: "Approved",
          },
          done_colors: [2],
        }),
      }),
    },
    {
      title: "Trigger Status",
      type: "status",
      defaults: JSON.stringify({
        settings_str: JSON.stringify({
          labels: { 5: "Ready", 2: "Done", 12: "Failed", 11: "Not Ready" },
          done_colors: [2],
        }),
      }),
    },
    { title: "LinkedIn Org", type: "text" },
    { title: "Org ID", type: "text" },
    { title: "LinkedIn Post URN", type: "text" },
    { title: "Post URL", type: "link" },
  ];

  for (const col of plannerColumns) {
    try {
      await gql(
        `mutation AddCol($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
          create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) { id }
        }`,
        {
          boardId: plannerBoardId,
          title: col.title,
          type: col.type,
          defaults: col.defaults || null,
        },
      );
      logger.info(`[linkedin-auth]   ✓ Column: "${col.title}"`);
    } catch (colErr) {
      logger.warn(
        `[linkedin-auth]   ⚠  Column "${col.title}": ${colErr.message}`,
      );
    }
  }

  // Create groups
  const additionalGroups = ["In Review", "Changes Required", "Approved"];
  for (const groupTitle of additionalGroups) {
    try {
      await gql(
        `mutation CreateGroup($boardId: ID!, $groupName: String!) {
          create_group(board_id: $boardId, group_name: $groupName) { id }
        }`,
        { boardId: plannerBoardId, groupName: groupTitle },
      );
    } catch (groupErr) {
      logger.warn(
        `[linkedin-auth]   ⚠  Group "${groupTitle}": ${groupErr.message}`,
      );
    }
  }

  // Rename default group to "Draft"
  try {
    const groupsResult = await gql(
      `query GetGroups($boardId: ID!) { boards(ids: [$boardId]) { groups { id title } } }`,
      { boardId: plannerBoardId },
    );
    const defaultGroup = groupsResult.boards[0]?.groups?.[0];
    if (defaultGroup) {
      await gql(
        `mutation RenameGroup($boardId: ID!, $groupId: String!, $title: String!) {
          update_group(board_id: $boardId, group_id: $groupId, group_attribute: title, new_value: $title) { id }
        }`,
        { boardId: plannerBoardId, groupId: defaultGroup.id, title: "Draft" },
      );
      logger.info(`[linkedin-auth]   ✓ Default group renamed to "Draft"`);
    }
  } catch (renameErr) {
    logger.warn(`[linkedin-auth]   ⚠  Group rename: ${renameErr.message}`);
  }

  logger.info(`[linkedin-auth] ✓ Post Planner board setup complete`);

  // ── Create "LinkedIn Post Data Storage" board ──────────────────────────────
  const storageResult = await gql(
    `mutation CreateBoard($name: String!, $kind: BoardKind!, $workspaceId: ID!) {
      create_board(board_name: $name, board_kind: $kind, workspace_id: $workspaceId) { id name }
    }`,
    { name: "LinkedIn Post Data Storage", kind: "public", workspaceId },
  );

  const storageBoardId = storageResult.create_board.id;
  logger.info(
    `[linkedin-auth] ✓ Post Data Storage board (ID: ${storageBoardId})`,
  );

  const storageColumns = [
    { title: "Post ID", type: "text" },
    { title: "Posted By", type: "text" },
    { title: "Post URL", type: "link" },
    { title: "Post Type", type: "text" },
    { title: "Post Date", type: "date" },
    { title: "Post Description", type: "long_text" },
    { title: "Impressions", type: "numbers" },
    { title: "Unique Impressions", type: "numbers" },
    { title: "Likes", type: "numbers" },
    { title: "Comments", type: "numbers" },
    { title: "Shares", type: "numbers" },
    { title: "Clicks", type: "numbers" },
    { title: "Engagement Rate", type: "numbers" },
    { title: "CTR", type: "numbers" },
    { title: "Total Engagement", type: "numbers" },
    { title: "LinkedIn Org ID", type: "text" },
    { title: "LinkedIn Org Name", type: "text" },
    { title: "Creation Log", type: "creation_log" },
  ];

  for (const col of storageColumns) {
    try {
      await gql(
        `mutation AddCol($boardId: ID!, $title: String!, $type: ColumnType!) {
          create_column(board_id: $boardId, title: $title, column_type: $type) { id }
        }`,
        { boardId: storageBoardId, title: col.title, type: col.type },
      );
      logger.info(`[linkedin-auth]   ✓ Storage column: "${col.title}"`);
    } catch (colErr) {
      logger.warn(
        `[linkedin-auth]   ⚠  Storage column "${col.title}": ${colErr.message}`,
      );
    }
  }

  logger.info(`[linkedin-auth] ✓ Post Data Storage board setup complete`);

  return {
    workspaceId,
    workspaceName,
    plannerBoardId,
    storageBoardId,
    orgId: org.id,
    orgName: org.name,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Store LinkedIn installation in Monday SecureStorage
//
// Also uses MONDAY_APP_TOKEN + Account-Id header so storage is scoped
// to the TENANT account, not the developer's account.
// ─────────────────────────────────────────────────────────────────────────────
export const storeLinkedInInstallation = async (
  mondayToken,
  mondayAccountId,
  payload,
) => {
  logger.info(
    `[linkedin-auth] Storing installation for Monday account: ${mondayAccountId}`,
  );

  try {
    const headers = {
      Authorization: mondayToken,
      "Content-Type": "application/json",
      "API-Version": "2024-01",
    };

    // Account-Id routes storage to the correct tenant
    if (mondayAccountId) {
      headers["Account-Id"] = String(mondayAccountId);
    }

    const mondayClient = axios.create({
      baseURL: MONDAY_API_URL,
      headers,
      timeout: 15000,
    });

    const storageKey = `linkedin_installation_${mondayAccountId}`;
    const storageValue = JSON.stringify(payload);

    const res = await mondayClient.post("", {
      query: `
        mutation SetStorage($key: String!, $value: String!) {
          set_storage(key: $key, value: $value) { key value }
        }
      `,
      variables: { key: storageKey, value: storageValue },
    });

    if (res.data.errors?.length) {
      throw new Error(res.data.errors[0].message);
    }

    logger.info(
      `[linkedin-auth] ✓ Installation stored in tenant account: ${mondayAccountId}`,
    );
    return true;
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Storage failed: ${err.message}`);
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Retrieve LinkedIn installation from Monday SecureStorage
// ─────────────────────────────────────────────────────────────────────────────
export const getLinkedInInstallation = async (mondayToken, mondayAccountId) => {
  try {
    const mondayClient = axios.create({
      baseURL: MONDAY_API_URL,
      headers: {
        Authorization: mondayToken,
        "Content-Type": "application/json",
        "API-Version": "2024-01",
      },
      timeout: 15000,
    });

    const storageKey = `linkedin_installation_${mondayAccountId}`;

    const res = await mondayClient.post("", {
      query: `
        query GetStorage($key: String!) {
          get_storage(key: $key) { key value }
        }
      `,
      variables: { key: storageKey },
    });

    const raw = res.data?.data?.get_storage?.value;
    if (!raw) return null;

    return JSON.parse(raw);
  } catch (err) {
    logger.error(`[linkedin-auth] ✗ Storage read failed: ${err.message}`);
    return null;
  }
};
