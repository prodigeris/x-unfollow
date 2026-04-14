// X Unfollow — Background Script
// Central hub: token capture, API calls, state machine, message router

// Well-known public bearer token embedded in X's frontend JS. Identifies the web app, not the user.
const PUBLIC_BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// --- State ---

const state = {
  tokens: {
    bearer: PUBLIC_BEARER,
    csrf: null,
  },
  queryIds: {
    Following: null,
    Followers: null,
  },
  features: null,
  userId: null,
  scanStatus: "idle", // idle | scanning | unfollowing | cancelled
  lastScanUsers: [],
  dashboardPort: null,
};

// --- Token & QueryId Capture via webRequest (passive, ongoing) ---

browser.webRequest.onSendHeaders.addListener(
  (details) => {
    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (name === "authorization" && header.value.startsWith("Bearer ")) {
        state.tokens.bearer = header.value;
      }
      if (name === "x-csrf-token") {
        state.tokens.csrf = header.value;
      }
    }
  },
  { urls: ["*://x.com/i/api/*", "*://twitter.com/i/api/*"] },
  ["requestHeaders"]
);

// Capture queryId and features from ANY GraphQL request (not just Following)
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = new URL(details.url);

    // Capture Following/Followers queryId specifically
    const followMatch = url.pathname.match(/\/i\/api\/graphql\/([^/]+)\/(Following|Followers)/);
    if (followMatch) {
      state.queryIds[followMatch[2]] = followMatch[1];
    }

    // Capture feature flags from any GraphQL request (they're shared across operations)
    if (!state.features && url.pathname.includes("/i/api/graphql/")) {
      const featuresParam = url.searchParams.get("features");
      if (featuresParam) {
        try {
          state.features = JSON.parse(featuresParam);
        } catch (e) {
          // ignore
        }
      }
    }
  },
  { urls: ["*://x.com/i/api/graphql/*", "*://twitter.com/i/api/graphql/*"] }
);

// Listen for queryIds discovered by the content script
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "discovered-queryIds") {
    for (const [opName, queryId] of Object.entries(message.queryIds)) {
      if (queryId && !state.queryIds[opName]) {
        state.queryIds[opName] = queryId;
        console.log(`X Unfollow: discovered ${opName} queryId from content script:`, queryId);
      }
    }
  }
});

// --- UserId Extraction ---

async function getUserId() {
  if (state.userId) return state.userId;

  try {
    const cookie = await browser.cookies.get({ url: "https://x.com", name: "twid" });
    if (cookie && cookie.value) {
      const decoded = decodeURIComponent(cookie.value);
      const match = decoded.match(/u=(\d+)/);
      if (match) {
        state.userId = match[1];
        return state.userId;
      }
    }
  } catch (e) {
    console.warn("X Unfollow: failed to get userId from cookie", e);
  }
  return null;
}

// Read CSRF from ct0 cookie
async function getCsrfToken() {
  try {
    const cookie = await browser.cookies.get({ url: "https://x.com", name: "ct0" });
    if (cookie && cookie.value) {
      state.tokens.csrf = cookie.value;
      return state.tokens.csrf;
    }
  } catch (e) {
    console.warn("X Unfollow: failed to get CSRF from cookie", e);
  }
  return state.tokens.csrf || null;
}

// --- Auto-Bootstrap: discover queryId and features ---

async function autoBootstrap() {
  // Ensure we have CSRF and userId from cookies
  await getCsrfToken();
  await getUserId();

  if (!state.tokens.csrf || !state.userId) {
    return false; // Not logged in
  }

  // Use default features if we don't have any yet
  if (!state.features) {
    state.features = getDefaultFeatures();
  }

  // If we already have queryId from JS bundle interception, we're good
  if (state.queryIds.Following) {
    return true;
  }

  // Fallback: try fetching X's main page HTML to find JS bundle URLs
  // and then fetch those bundles to extract queryIds
  try {
    const pageResp = await fetch("https://x.com/home", {
      credentials: "include",
      headers: {
        Authorization: state.tokens.bearer,
        "X-Csrf-Token": state.tokens.csrf,
      },
    });
    const html = await pageResp.text();

    // Find JS bundle URLs from various patterns X uses
    const urlPatterns = [
      /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\.js)"/g,
      /href="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\.js)"/g,
      /"(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"]*\.js)"/g,
    ];

    const scriptUrls = new Set();
    for (const pattern of urlPatterns) {
      for (const m of html.matchAll(pattern)) {
        scriptUrls.add(m[1]);
      }
    }

    for (const url of [...scriptUrls].slice(0, 15)) {
      try {
        const jsResp = await fetch(url);
        const js = await jsResp.text();

        for (const opName of ["Following", "Followers"]) {
          if (state.queryIds[opName]) continue;

          const patterns = [
            new RegExp(`queryId:"([^"]+)",operationName:"${opName}"`),
            new RegExp(`queryId:"([^"]+)"[^}]*operationName:"${opName}"`),
            new RegExp(`"${opName}"[^}]*queryId:"([^"]+)"`),
          ];

          for (const pattern of patterns) {
            const match = js.match(pattern);
            if (match) {
              state.queryIds[opName] = match[1];
              console.log(`X Unfollow: discovered ${opName} queryId from fetch:`, match[1]);
              break;
            }
          }
        }

        if (state.queryIds.Following && state.queryIds.Followers) break;
      } catch (e) {
        // Skip this bundle
      }
    }
  } catch (e) {
    console.warn("X Unfollow: auto-bootstrap fetch failed", e);
  }

  return !!(state.queryIds.Following && state.features);
}

function getDefaultFeatures() {
  // These feature flags are commonly required by X's GraphQL API.
  // They may need updating if X changes requirements.
  return {
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };
}

// --- Readiness Check ---

function getReadiness() {
  return {
    bearer: !!state.tokens.bearer,
    csrf: !!state.tokens.csrf,
    queryId: !!state.queryIds.Following,
    features: !!state.features,
    userId: !!state.userId,
    ready:
      !!state.tokens.bearer &&
      !!state.tokens.csrf &&
      !!state.queryIds.Following &&
      !!state.features &&
      !!state.userId,
  };
}

// --- Dashboard Port Management ---

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "dashboard") {
    if (state.dashboardPort) {
      port.postMessage({ type: "error", message: "Dashboard already open in another tab" });
      port.disconnect();
      return;
    }

    state.dashboardPort = port;

    port.onDisconnect.addListener(() => {
      state.dashboardPort = null;
      if (state.scanStatus === "scanning" || state.scanStatus === "unfollowing") {
        state.scanStatus = "cancelled";
      }
    });

    port.onMessage.addListener(async (message) => {
      const handlers = {
        "get-readiness": async () => {
          // Try auto-bootstrap first
          const bootstrapped = await autoBootstrap();
          return getReadiness();
        },
        "get-state": () => ({
          scanStatus: state.scanStatus,
        }),
        "start-scan": async () => {
          if (state.scanStatus === "scanning") return { error: "Scan already in progress" };

          // Final readiness check
          if (!state.queryIds.Following || !state.features || !state.userId || !state.tokens.csrf) {
            return { error: "Extension not ready. Browse x.com while logged in and try again.", nonFollowers: [], unknowns: [], total: 0, partial: true };
          }

          state.scanStatus = "scanning";
          try {
            const result = await runScan({
              queryId: state.queryIds.Following,
              userId: state.userId,
              features: state.features,
              tokens: { ...state.tokens },
              onProgress: (progress) => {
                if (state.dashboardPort) {
                  state.dashboardPort.postMessage({ type: "scan-progress", data: progress });
                }
              },
              isCancelled: () => state.scanStatus === "cancelled",
            });
            state.scanStatus = "idle";
            state.lastScanUsers = [...result.nonFollowers, ...result.unknowns];
            return result;
          } catch (err) {
            state.scanStatus = "idle";
            return { error: err.message || "Scan failed", nonFollowers: [], unknowns: [], total: 0, partial: true };
          }
        },
        "cancel-scan": () => {
          if (state.scanStatus === "scanning") {
            state.scanStatus = "cancelled";
          }
          return { ok: true };
        },
        "start-unfollow": async (msg) => {
          if (state.scanStatus === "unfollowing") return { error: "Unfollow already in progress" };

          state.scanStatus = "unfollowing";
          try {
            const wl = await getWhitelist();
            const cap = await getSessionCap();

            const userMap = {};
            if (state.lastScanUsers) {
              for (const user of state.lastScanUsers) {
                userMap[user.id] = user;
              }
            }

            const storedSpeed = await browser.storage.local.get("unfollowSpeed");
            const speed = storedSpeed.unfollowSpeed || "slow";

            const result = await runUnfollow({
              userIds: msg.userIds || [],
              whitelist: wl,
              tokens: { ...state.tokens },
              sessionCap: cap,
              speed,
              onProgress: (progress) => {
                if (state.dashboardPort) {
                  state.dashboardPort.postMessage({ type: "unfollow-progress", data: progress });
                }
              },
              isCancelled: () => state.scanStatus === "cancelled",
              refreshCsrf: getCsrfToken,
              userMap,
            });
            state.scanStatus = "idle";
            return result;
          } catch (err) {
            state.scanStatus = "idle";
            return {
              results: { success: [], failed: [], skipped: [] },
              error: err.message || "Unfollow failed",
            };
          }
        },
        "cancel-unfollow": () => {
          if (state.scanStatus === "unfollowing") {
            state.scanStatus = "cancelled";
          }
          return { ok: true };
        },
      };

      const handler = handlers[message.type];
      if (handler) {
        try {
          const result = await handler(message);
          port.postMessage({ type: message.type + "-response", data: result });
        } catch (err) {
          console.error("X Unfollow: handler error for", message.type, err);
          port.postMessage({ type: message.type + "-response", data: { error: String(err) } });
        }
      } else {
        console.warn("X Unfollow: no handler for", message.type);
      }
    });
  }
});

// --- Toolbar Icon ---

browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("dashboard.html") });
});
