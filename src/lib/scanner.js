// Scan orchestration — paginates the Following list (authoritative for who
// follows you back) and, as a cross-check, the Followers list. Reports how many
// of each list were retrieved so a silent zero can't masquerade as success.

async function runScan({ queryId, userId, features, fieldToggles, followers, tokens, onProgress, isCancelled }) {
  onProgress({ phase: "following", followingCollected: 0, followersCollected: 0, page: 0 });

  // --- Phase 1: Following list (authoritative — carries followed_by) ---
  const followingResult = await paginateList({
    label: "following",
    fetchPage: (cursor) => fetchFollowingPage(queryId, userId, features, fieldToggles, tokens, cursor),
    tokens,
    isCancelled,
    onPage: (collected, page) =>
      onProgress({ phase: "following", followingCollected: collected, followersCollected: 0, page }),
  });

  const allUsers = followingResult.users;
  let partial = followingResult.partial;
  let error = followingResult.error;

  // --- Phase 2: Followers list (for the count + to resolve unknowns) ---
  // Non-fatal: if we can't fetch it, the Following results still stand.
  let followersCount = null;
  let followersComplete = false;
  let followerIds = null;

  if (followers && followers.queryId && !isCancelled()) {
    const followersResult = await paginateList({
      label: "followers",
      fetchPage: (cursor) =>
        fetchFollowersPage(followers.queryId, userId, followers.features, followers.fieldToggles, tokens, cursor),
      tokens,
      isCancelled,
      onPage: (collected, page) =>
        onProgress({ phase: "followers", followingCollected: allUsers.length, followersCollected: collected, page }),
    });

    followerIds = new Set(followersResult.users.map((u) => u.id));
    followersCount = followersResult.users.length;
    // Only a fully-retrieved followers list can authoritatively resolve unknowns.
    // A partial/failed followers phase does NOT taint the Following results
    // (those already carry followed_by) — it just leaves followersComplete false.
    followersComplete = !followersResult.partial;
  }

  // --- Classify ---
  const { nonFollowers, unknowns, followBack } = classifyUsers(allUsers, {
    followerIds: followersComplete ? followerIds : null,
  });

  console.log(
    `X Unfollow: scan complete — ${allUsers.length} following, ${followersCount === null ? "?" : followersCount} followers, ` +
      `${nonFollowers.length} non-followers, ${followBack} follow back, ${unknowns.length} unknown`
  );

  return {
    nonFollowers,
    unknowns,
    total: allUsers.length,
    followBack,
    followersCount,
    followersComplete,
    partial,
    error,
  };
}

// Paginate a Following/Followers list with rate-limit + auth handling.
// Returns { users, partial, error }.
async function paginateList({ label, fetchPage, tokens, isCancelled, onPage }) {
  const users = [];
  const seenIds = new Set();
  let cursor = null;
  let lastCursor = null;
  let page = 0;
  let partial = false;
  let error = null;

  while (true) {
    if (isCancelled()) {
      partial = true;
      error = "Scan cancelled by user";
      break;
    }

    page++;

    try {
      const result = await fetchPage(cursor);

      let newCount = 0;
      for (const user of result.users) {
        if (!seenIds.has(user.id)) {
          seenIds.add(user.id);
          users.push(user);
          newCount++;
        }
      }

      cursor = result.nextCursor;
      onPage(users.length, page);

      if (!cursor || cursor === lastCursor || newCount === 0) break;
      lastCursor = cursor;

      await delay(1000);
    } catch (err) {
      if (err.type === "rate_limit") {
        const backoffMs = 30000 * Math.pow(2, Math.min(page % 3, 2));
        console.warn(`X Unfollow: rate limited on ${label}, backing off ${backoffMs / 1000}s`);
        await delay(backoffMs);
        continue;
      }

      if (err.type === "auth_error") {
        const newCsrf = await getCsrfToken();
        if (newCsrf && newCsrf !== tokens.csrf) {
          tokens.csrf = newCsrf;
          continue;
        }
        partial = true;
        error = "Authentication error — try refreshing x.com";
        break;
      }

      console.error(`X Unfollow: ${label} scan error`, err);
      partial = true;
      error = err.message || "An unexpected error occurred during scanning";
      break;
    }
  }

  return { users, partial, error };
}

// Classify following accounts. When a complete followers set is supplied, it is
// used to resolve accounts whose followed_by flag was missing from the API.
function classifyUsers(users, { followerIds } = {}) {
  const nonFollowers = [];
  const unknowns = [];
  let followBack = 0;

  for (const user of users) {
    let followsBack = user.followedBy;

    if ((followsBack === undefined || followsBack === null) && followerIds) {
      followsBack = followerIds.has(user.id);
    }

    if (followsBack === false) {
      nonFollowers.push(user);
    } else if (followsBack === undefined || followsBack === null) {
      unknowns.push(user);
    } else {
      followBack++;
    }
  }

  return { nonFollowers, unknowns, followBack };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
