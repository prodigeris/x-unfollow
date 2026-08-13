// Scan orchestration — paginates the Following list (authoritative for who
// follows you back). The follower total is fetched separately by the background
// (one cheap profile call) and merged into the result, so we never paginate the
// followers list.

async function runScan({ queryId, userId, features, fieldToggles, tokens, onProgress, isCancelled }) {
  onProgress({ phase: "following", followingCollected: 0, page: 0 });

  const followingResult = await paginateList({
    label: "following",
    fetchPage: (cursor) => fetchFollowingPage(queryId, userId, features, fieldToggles, tokens, cursor),
    tokens,
    isCancelled,
    onPage: (collected, page) => onProgress({ phase: "following", followingCollected: collected, page }),
  });

  const allUsers = followingResult.users;
  const { nonFollowers, unknowns, followBack } = classifyUsers(allUsers);

  console.log(
    `X Unfollow: scan complete — ${allUsers.length} following, ` +
      `${nonFollowers.length} non-followers, ${followBack} follow back, ${unknowns.length} unknown`
  );

  return {
    nonFollowers,
    unknowns,
    total: allUsers.length,
    followBack,
    partial: followingResult.partial,
    error: followingResult.error,
  };
}

// Paginate a Following list with rate-limit + auth handling.
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

function classifyUsers(users) {
  const nonFollowers = [];
  const unknowns = [];
  let followBack = 0;

  for (const user of users) {
    if (user.followedBy === false) {
      nonFollowers.push(user);
    } else if (user.followedBy === undefined || user.followedBy === null) {
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
