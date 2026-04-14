// X API call helpers

const API_BASE = "https://x.com/i/api";

/**
 * Make an authenticated GraphQL GET request to X's API.
 */
async function graphqlGet(queryId, operationName, variables, features, tokens) {
  return graphqlGetWithToggles(queryId, operationName, variables, features, null, tokens);
}

/**
 * Make an authenticated GraphQL GET request with optional fieldToggles.
 */
async function graphqlGetWithToggles(queryId, operationName, variables, features, fieldToggles, tokens) {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  });
  if (fieldToggles) {
    params.set("fieldToggles", JSON.stringify(fieldToggles));
  }

  const url = `${API_BASE}/graphql/${queryId}/${operationName}?${params}`;

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      Authorization: tokens.bearer,
      "X-Csrf-Token": tokens.csrf,
      "Content-Type": "application/json",
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Auth-Type": "OAuth2Session",
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    console.error("X Unfollow: failed to parse API response", response.status, text.slice(0, 200));
    throw { type: "parse_error", message: "Invalid JSON response from API", status: response.status };
  }
  return { status: response.status, data };
}

/**
 * Fetch a page of the Following list.
 * Returns { users: [...], nextCursor: string|null, totalCount: number|null }
 */
async function fetchFollowingPage(queryId, userId, features, tokens, cursor = null) {
  const variables = {
    userId,
    count: 100,
    includePromotedContent: false,
  };
  if (cursor) {
    variables.cursor = cursor;
  }

  // fieldToggles enables relationship fields like followed_by
  const fieldToggles = {
    withAudienceExpansion: true,
  };

  const { status, data } = await graphqlGetWithToggles(queryId, "Following", variables, features, fieldToggles, tokens);

  if (status === 429) {
    throw { type: "rate_limit", status };
  }
  if (status === 403) {
    throw { type: "auth_error", status };
  }
  if (status !== 200) {
    throw { type: "api_error", status, data };
  }

  // Check for API-level errors
  if (data.errors && data.errors.length > 0) {
    const rateError = data.errors.find((e) => e.code === 88);
    if (rateError) {
      throw { type: "rate_limit", status: 200, data };
    }
    throw { type: "api_error", status: 200, data };
  }

  return parseFollowingResponse(data);
}

/**
 * Fetch a page of the Followers list (same structure as Following).
 */
async function fetchFollowersPage(queryId, userId, features, tokens, cursor = null) {
  const variables = {
    userId,
    count: 100,
    includePromotedContent: false,
  };
  if (cursor) {
    variables.cursor = cursor;
  }

  const { status, data } = await graphqlGet(queryId, "Followers", variables, features, tokens);

  if (status === 429) {
    throw { type: "rate_limit", status };
  }
  if (status === 403) {
    throw { type: "auth_error", status };
  }
  if (status !== 200) {
    throw { type: "api_error", status, data };
  }

  if (data.errors && data.errors.length > 0) {
    const rateError = data.errors.find((e) => e.code === 88);
    if (rateError) {
      throw { type: "rate_limit", status: 200, data };
    }
    throw { type: "api_error", status: 200, data };
  }

  return parseFollowingResponse(data); // Same response format
}

/**
 * Parse the Following/Followers GraphQL response, handling known path variants.
 */
function parseFollowingResponse(data) {
  // Try known response paths
  const timeline =
    data?.data?.user?.result?.timeline?.timeline ||
    data?.data?.user?.result?.timeline_v2?.timeline;

  if (!timeline) {
    throw { type: "parse_error", message: "Could not find timeline in response", data };
  }

  const instructions = timeline.instructions || [];
  const users = [];
  let nextCursor = null;

  for (const instruction of instructions) {
    // Skip non-entry instructions (TimelineClearCache, etc.)
    if (instruction.type !== "TimelineAddEntries" && !instruction.entries) {
      continue;
    }

    const entries = instruction.entries || [];
    for (const entry of entries) {
      // Cursor entries
      if (entry.entryId?.startsWith("cursor-bottom-")) {
        nextCursor = entry.content?.value || null;
        continue;
      }
      if (entry.entryId?.startsWith("cursor-top-")) {
        continue;
      }

      // User entries
      const userResult = entry.content?.itemContent?.user_results?.result;
      if (!userResult) continue;

      const legacy = userResult.legacy;
      if (!legacy) continue;

      // X API structure (2025+):
      //   core.name, core.screen_name
      //   avatar.image_url
      //   relationship_perspectives.followed_by
      const core = userResult.core || {};
      const relPersp = userResult.relationship_perspectives || {};

      users.push({
        id: userResult.rest_id,
        screenName: core.screen_name || legacy.screen_name || "",
        name: core.name || legacy.name || "",
        avatar: userResult.avatar?.image_url || legacy.profile_image_url_https || null,
        followedBy: relPersp.followed_by !== undefined ? relPersp.followed_by : legacy.followed_by,
      });
    }
  }

  return { users, nextCursor };
}

/**
 * Unfollow a user via the REST API.
 */
async function unfollowUser(userId, tokens) {
  const url = `${API_BASE}/1.1/friendships/destroy.json`;

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: tokens.bearer,
      "X-Csrf-Token": tokens.csrf,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Auth-Type": "OAuth2Session",
    },
    body: `user_id=${userId}`,
  });

  if (response.status === 429) {
    throw { type: "rate_limit", status: 429 };
  }
  if (response.status === 403) {
    throw { type: "auth_error", status: 403 };
  }

  return { success: response.ok, status: response.status };
}

/**
 * Check relationship status for a batch of user IDs (up to 100).
 * Returns a map of userId -> { followedBy: boolean }
 */
async function lookupFriendships(userIds, tokens) {
  const url = `${API_BASE}/1.1/friendships/lookup.json?user_id=${userIds.join(",")}`;

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      Authorization: tokens.bearer,
      "X-Csrf-Token": tokens.csrf,
      "Content-Type": "application/json",
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Auth-Type": "OAuth2Session",
    },
  });

  if (response.status === 429) {
    throw { type: "rate_limit", status: 429 };
  }
  if (response.status === 403) {
    throw { type: "auth_error", status: 403 };
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : [];
  } catch (e) {
    throw { type: "parse_error", message: "Invalid JSON from friendships/lookup", status: response.status };
  }

  if (response.status !== 200) {
    throw { type: "api_error", status: response.status, data };
  }

  const result = {};
  for (const entry of data) {
    const connections = entry.connections || [];
    result[entry.id_str] = {
      followedBy: connections.includes("followed_by"),
    };
  }
  return result;
}
