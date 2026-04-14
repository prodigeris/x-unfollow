// Scan orchestration — paginates the Following list and identifies non-followers

async function runScan({ queryId, userId, features, tokens, onProgress, isCancelled }) {
  const allUsers = [];
  const seenIds = new Set();
  let cursor = null;
  let lastCursor = null;
  let page = 0;
  let partial = false;
  let error = null;

  onProgress({ collected: 0, nonFollowers: 0, page: 0 });

  while (true) {
    if (isCancelled()) {
      partial = true;
      error = "Scan cancelled by user";
      break;
    }

    page++;

    try {
      const result = await fetchFollowingPage(queryId, userId, features, tokens, cursor);

      let newCount = 0;
      for (const user of result.users) {
        if (!seenIds.has(user.id)) {
          seenIds.add(user.id);
          allUsers.push(user);
          newCount++;
        }
      }

      cursor = result.nextCursor;

      const { nonFollowers } = classifyUsers(allUsers);
      onProgress({ collected: allUsers.length, nonFollowers: nonFollowers.length, page });

      if (!cursor || cursor === lastCursor || newCount === 0) break;
      lastCursor = cursor;

      await delay(1000);
    } catch (err) {
      if (err.type === "rate_limit") {
        const backoffMs = 30000 * Math.pow(2, Math.min(page % 3, 2));
        console.warn(`X Unfollow: rate limited, backing off ${backoffMs / 1000}s`);
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

      console.error("X Unfollow: scan error", err);
      partial = true;
      error = err.message || "An unexpected error occurred during scanning";
      break;
    }
  }

  const { nonFollowers, unknowns } = classifyUsers(allUsers);
  console.log(`X Unfollow: scan complete — ${nonFollowers.length} non-followers, ${unknowns.length} unknown, ${allUsers.length - nonFollowers.length - unknowns.length} follow back`);

  return { nonFollowers, unknowns, total: allUsers.length, partial, error };
}

function classifyUsers(users) {
  const nonFollowers = [];
  const unknowns = [];
  let followBackCount = 0;

  for (const user of users) {
    if (user.followedBy === false) {
      nonFollowers.push(user);
    } else if (user.followedBy === undefined || user.followedBy === null) {
      unknowns.push(user);
    } else {
      followBackCount++;
    }
  }

  return { nonFollowers, unknowns };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
