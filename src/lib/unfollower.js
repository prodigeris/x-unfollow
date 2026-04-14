// Unfollow orchestration — delays, cap, progress, cancellation

const SPEED_PRESETS = {
  slow:   { min: 5000, max: 12000, label: "Slow (5–12s)" },
  medium: { min: 2000, max: 6000,  label: "Medium (2–6s)" },
  fast:   { min: 500,  max: 1500,  label: "Fast (0.5–1.5s)" },
};

/**
 * Run the unfollow process on a list of user IDs.
 *
 * @param {object} params
 * @param {string[]} params.userIds - IDs to unfollow
 * @param {object} params.whitelist - Current whitelist object
 * @param {object} params.tokens - { bearer, csrf }
 * @param {number} params.sessionCap - Max unfollows per session
 * @param {function} params.onProgress - Called with { completed, total, currentUser, result }
 * @param {function} params.isCancelled - Returns true if unfollow should stop
 * @param {function} params.refreshCsrf - Async function to refresh CSRF token
 * @param {object} params.userMap - Map of userId -> user object for display names
 * @returns {object} { results: { success: [], failed: [], skipped: [] }, error: string|null }
 */
async function runUnfollow({
  userIds,
  whitelist,
  tokens,
  sessionCap,
  speed = "slow",
  onProgress,
  isCancelled,
  refreshCsrf,
  userMap,
}) {
  const results = { success: [], failed: [], skipped: [] };
  let error = null;

  // Filter out whitelisted accounts (R14 defense in depth)
  const toUnfollow = [];
  for (const id of userIds) {
    if (isWhitelisted(whitelist, id)) {
      results.skipped.push({ id, reason: "whitelisted", screenName: userMap[id]?.screenName });
    } else {
      toUnfollow.push(id);
    }
  }

  // Apply session cap
  const capped = toUnfollow.slice(0, sessionCap);
  if (toUnfollow.length > sessionCap) {
    for (let i = sessionCap; i < toUnfollow.length; i++) {
      results.skipped.push({
        id: toUnfollow[i],
        reason: "session_cap",
        screenName: userMap[toUnfollow[i]]?.screenName,
      });
    }
  }

  const total = capped.length;

  for (let i = 0; i < capped.length; i++) {
    if (isCancelled()) {
      error = "Unfollow cancelled";
      // Mark remaining as skipped
      for (let j = i; j < capped.length; j++) {
        results.skipped.push({
          id: capped[j],
          reason: "cancelled",
          screenName: userMap[capped[j]]?.screenName,
        });
      }
      break;
    }

    const userId = capped[i];
    const screenName = userMap[userId]?.screenName || userId;

    onProgress({
      completed: i,
      total,
      currentUser: screenName,
    });

    let retries = 0;
    const maxRetries = 3;
    let success = false;

    while (retries <= maxRetries) {
      try {
        const result = await unfollowUser(userId, tokens);
        if (result.success) {
          results.success.push({ id: userId, screenName });
          success = true;
          break;
        } else {
          // Non-success but not an exception — treat as failed
          results.failed.push({ id: userId, screenName, status: result.status });
          success = true; // Don't retry
          break;
        }
      } catch (err) {
        if (err.type === "rate_limit") {
          retries++;
          if (retries > maxRetries) {
            results.failed.push({ id: userId, screenName, reason: "rate_limit" });
            success = true;
            break;
          }
          // Exponential backoff: 30s, 60s, 120s
          const backoffMs = 30000 * Math.pow(2, retries - 1);
          console.warn(`X Unfollow: rate limited, backing off ${backoffMs / 1000}s (retry ${retries}/${maxRetries})`);
          await unfollowDelay(backoffMs);
          continue;
        }

        if (err.type === "auth_error") {
          // Try refreshing CSRF
          const newCsrf = await refreshCsrf();
          if (newCsrf) {
            tokens.csrf = newCsrf;
            retries++;
            continue;
          }
          error = "Authentication error — try refreshing x.com";
          results.failed.push({ id: userId, screenName, reason: "auth_error" });
          success = true;
          break;
        }

        // Other error — log and move on
        results.failed.push({ id: userId, screenName, reason: err.message || "unknown" });
        success = true;
        break;
      }
    }

    onProgress({
      completed: i + 1,
      total,
      currentUser: screenName,
      lastResult: results.success.includes(results.success[results.success.length - 1]) ? "success" : "failed",
    });

    // Randomized delay based on speed setting
    if (i < capped.length - 1 && !isCancelled()) {
      const preset = SPEED_PRESETS[speed] || SPEED_PRESETS.slow;
      const delayMs = Math.random() * (preset.max - preset.min) + preset.min;
      await unfollowDelay(delayMs);
    }
  }

  return { results, error };
}

function unfollowDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
