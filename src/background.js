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
  features: null, // last-seen features from any GraphQL request (mid-tier fallback)
  // Following-specific request contract, most reliable first:
  followingFeatures: null, // {name: value} captured from a real Following request
  followingFieldToggles: null, // {name: value} captured from a real Following request
  followingFeatureNames: null, // [names] discovered from the JS bundle (values default to true)
  followingFieldToggleNames: null, // [names] discovered from the JS bundle (values default to false)
  // Followers-specific request contract (same tiers as Following). Optional — the
  // scan cross-checks against the followers list when it can, but never blocks on it.
  followersFeatures: null,
  followersFieldToggles: null,
  followersFeatureNames: null,
  followersFieldToggleNames: null,
  followersBundleFetchTried: false, // one-shot guard for the heavy Followers bundle lookup
  followersDiscovery: null, // in-flight Followers discovery promise, so a scan can await it
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

      // A real Following/Followers request carries the exact features +
      // fieldToggles (names AND values) that X expects. This is the most
      // reliable source of the request contract.
      const featuresParam = url.searchParams.get("features");
      const togglesParam = url.searchParams.get("fieldToggles");
      if (followMatch[2] === "Following") {
        if (featuresParam) {
          try { state.followingFeatures = JSON.parse(featuresParam); } catch (e) { /* ignore */ }
        }
        if (togglesParam) {
          try { state.followingFieldToggles = JSON.parse(togglesParam); } catch (e) { /* ignore */ }
        }
      } else if (followMatch[2] === "Followers") {
        if (featuresParam) {
          try { state.followersFeatures = JSON.parse(featuresParam); } catch (e) { /* ignore */ }
        }
        if (togglesParam) {
          try { state.followersFieldToggles = JSON.parse(togglesParam); } catch (e) { /* ignore */ }
        }
      }
    }

    // Capture feature flags from any GraphQL request (mid-tier fallback)
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

// Listen for the operation contract discovered by the content script
// (queryId + featureSwitches + fieldToggles pulled from X's JS bundle).
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "discovered-operations") {
    for (const [opName, op] of Object.entries(message.operations || {})) {
      if (!op) continue;

      if (op.queryId && !state.queryIds[opName]) {
        state.queryIds[opName] = op.queryId;
        console.log(`X Unfollow: discovered ${opName} queryId from content script:`, op.queryId);
      }

      if (opName === "Following") {
        if (Array.isArray(op.features) && op.features.length && !state.followingFeatureNames) {
          state.followingFeatureNames = op.features;
          console.log(`X Unfollow: discovered ${op.features.length} Following feature switches from bundle`);
        }
        if (Array.isArray(op.fieldToggles) && op.fieldToggles.length && !state.followingFieldToggleNames) {
          state.followingFieldToggleNames = op.fieldToggles;
        }
      } else if (opName === "Followers") {
        if (Array.isArray(op.features) && op.features.length && !state.followersFeatureNames) {
          state.followersFeatureNames = op.features;
        }
        if (Array.isArray(op.fieldToggles) && op.fieldToggles.length && !state.followersFieldToggleNames) {
          state.followersFieldToggleNames = op.fieldToggles;
        }
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

  // Discover any operation contract we're still missing. Following is required;
  // Followers is best-effort (it powers the follower count and unknown resolution).
  if (state.queryIds.Following && state.queryIds.Followers) {
    return true;
  }

  if (!state.queryIds.Following) {
    // Following is required — keep trying to discover it on each readiness check.
    await discoverOperationsFromBundles();
  } else if (!state.queryIds.Followers && !state.followersBundleFetchTried) {
    // Following is set but Followers isn't (e.g. its code-split chunk wasn't
    // loaded on the page content.js saw). The bundle fetch is heavy, so run it
    // just once and don't block readiness on it — content.js and webRequest also
    // fill Followers in passively once the user touches a followers page.
    state.followersBundleFetchTried = true;
    state.followersDiscovery = discoverOperationsFromBundles();
  }

  return !!(state.queryIds.Following && state.features);
}

// Fetch X's home HTML, find its JS bundle URLs, and extract the Following /
// Followers operation contracts (queryId + feature/fieldToggle names) from any
// bundle that still needs discovering.
async function discoverOperationsFromBundles() {
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

          const op = extractOperationContract(js, opName);
          if (op && op.queryId) {
            state.queryIds[opName] = op.queryId;
            console.log(`X Unfollow: discovered ${opName} queryId from fetch:`, op.queryId);

            if (opName === "Following") {
              if (op.features.length && !state.followingFeatureNames) {
                state.followingFeatureNames = op.features;
              }
              if (op.fieldToggles.length && !state.followingFieldToggleNames) {
                state.followingFieldToggleNames = op.fieldToggles;
              }
            } else if (opName === "Followers") {
              if (op.features.length && !state.followersFeatureNames) {
                state.followersFeatureNames = op.features;
              }
              if (op.fieldToggles.length && !state.followersFieldToggleNames) {
                state.followersFieldToggleNames = op.fieldToggles;
              }
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
}

// Last-resort backstop: the feature switches X's `Following` operation required
// as of 2026-08 (captured from the live client bundle). X rejects a request with
// HTTP 400 ("The following features cannot be null: ...") when a required switch
// is absent — it validates presence, not value — so we send every one.
// Prefer the live-captured / bundle-discovered contract over this static list.
const DEFAULT_FOLLOWING_FEATURES = [
  "rweb_video_screen_enabled",
  "rweb_cashtags_enabled",
  "profile_label_improvements_pcf_label_in_post_enabled",
  "responsive_web_profile_redirect_enabled",
  "rweb_tipjar_consumption_enabled",
  "verified_phone_label_enabled",
  "creator_subscriptions_tweet_preview_api_enabled",
  "responsive_web_graphql_timeline_navigation_enabled",
  "premium_content_api_read_enabled",
  "communities_web_enable_tweet_community_results_fetch",
  "c9s_tweet_anatomy_moderator_badge_enabled",
  "responsive_web_grok_analyze_button_fetch_trends_enabled",
  "responsive_web_grok_analyze_post_followups_enabled",
  "rweb_cashtags_composer_attachment_enabled",
  "responsive_web_jetfuel_frame",
  "responsive_web_grok_share_attachment_enabled",
  "responsive_web_grok_annotations_enabled",
  "articles_preview_enabled",
  "responsive_web_edit_tweet_api_enabled",
  "rweb_conversational_replies_downvote_enabled",
  "graphql_is_translatable_rweb_tweet_is_translatable_enabled",
  "view_counts_everywhere_api_enabled",
  "longform_notetweets_consumption_enabled",
  "responsive_web_twitter_article_tweet_consumption_enabled",
  "content_disclosure_indicator_enabled",
  "content_disclosure_ai_generated_indicator_enabled",
  "responsive_web_grok_show_grok_translated_post",
  "responsive_web_grok_analysis_button_from_backend",
  "post_ctas_fetch_enabled",
  "freedom_of_speech_not_reach_fetch_enabled",
  "standardized_nudges_misinfo",
  "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled",
  "longform_notetweets_rich_text_read_enabled",
  "longform_notetweets_inline_media_enabled",
  "responsive_web_grok_image_annotation_enabled",
  "responsive_web_grok_imagine_annotation_enabled",
  "responsive_web_grok_community_note_auto_translation_is_enabled",
  "responsive_web_enhance_cards_enabled",
];

// fieldToggles X's `Following` operation required as of 2026-08. Same presence
// rule as features; none of these gate the relationship_perspectives.followed_by
// field we read, so their values are safe to leave off.
const DEFAULT_FOLLOWING_FIELD_TOGGLES = [
  "withPayments",
  "withAuxiliaryUserLabels",
  "withArticleRichContentState",
  "withArticlePlainText",
  "withArticleSummaryText",
  "withArticleVoiceOver",
  "withGrokAnalyze",
  "withDisallowedReplyControls",
];

function namesToObject(names, value) {
  const obj = {};
  for (const name of names) obj[name] = value;
  return obj;
}

function getDefaultFeatures() {
  return namesToObject(DEFAULT_FOLLOWING_FEATURES, true);
}

function getDefaultFieldToggles() {
  return namesToObject(DEFAULT_FOLLOWING_FIELD_TOGGLES, false);
}

// Resolve the features to send with a Following request, most reliable first:
//   1. exact features (names + values) from a real Following request we observed
//   2. feature names read from X's JS bundle (values default to true)
//   3. features seen on any other GraphQL request
//   4. static backstop captured from a recent X client
function resolveFollowingFeatures() {
  if (state.followingFeatures) return state.followingFeatures;
  if (state.followingFeatureNames && state.followingFeatureNames.length) {
    return namesToObject(state.followingFeatureNames, true);
  }
  if (state.features) return state.features;
  return getDefaultFeatures();
}

// Resolve the fieldToggles to send with a Following request, most reliable first.
function resolveFollowingFieldToggles() {
  if (state.followingFieldToggles) return state.followingFieldToggles;
  if (state.followingFieldToggleNames && state.followingFieldToggleNames.length) {
    return namesToObject(state.followingFieldToggleNames, false);
  }
  return getDefaultFieldToggles();
}

// Followers uses the same feature/fieldToggle requirements as Following, so we
// fall back to the resolved Following contract when we haven't observed a real
// Followers request or bundle entry.
function resolveFollowersFeatures() {
  if (state.followersFeatures) return state.followersFeatures;
  if (state.followersFeatureNames && state.followersFeatureNames.length) {
    return namesToObject(state.followersFeatureNames, true);
  }
  return resolveFollowingFeatures();
}

function resolveFollowersFieldToggles() {
  if (state.followersFieldToggles) return state.followersFieldToggles;
  if (state.followersFieldToggleNames && state.followersFieldToggleNames.length) {
    return namesToObject(state.followersFieldToggleNames, false);
  }
  return resolveFollowingFieldToggles();
}

// Extract { queryId, features, fieldToggles } for a GraphQL operation from a
// bundle. Mirrors the extractor in content.js (background page has no DOM access
// to share it). X registers each operation as:
//   {queryId:"...",operationName:"Following",operationType:"query",metadata:{featureSwitches:[...],fieldToggles:[...]}}
function extractOperationContract(js, opName) {
  const marker = `operationName:"${opName}"`;
  let from = 0;

  while (true) {
    const idx = js.indexOf(marker, from);
    if (idx === -1) return null;
    from = idx + marker.length;

    const before = js.slice(Math.max(0, idx - 80), idx);
    const qm = before.match(/queryId:"([^"]+)",\s*$/);
    let queryId = qm ? qm[1] : null;

    const after = js.slice(idx, idx + 3000);
    if (!queryId) {
      const am = after.slice(0, 200).match(/queryId:"([^"]+)"/);
      if (am) queryId = am[1];
    }

    if (queryId) {
      return {
        queryId,
        features: extractStringArray(after, "featureSwitches") || [],
        fieldToggles: extractStringArray(after, "fieldToggles") || [],
      };
    }
  }
}

function extractStringArray(segment, key) {
  const i = segment.indexOf(key + ":[");
  if (i === -1) return null;
  const start = i + key.length + 2;
  const end = segment.indexOf("]", start);
  if (end === -1) return null;
  return [...segment.slice(start, end).matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
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

          // If a one-shot Followers discovery is still in flight, wait for it so
          // the very first scan can include the follower count instead of "—".
          if (!state.queryIds.Followers && state.followersDiscovery) {
            try {
              await state.followersDiscovery;
            } catch (e) {
              /* best-effort */
            }
          }

          try {
            const result = await runScan({
              queryId: state.queryIds.Following,
              userId: state.userId,
              features: resolveFollowingFeatures(),
              fieldToggles: resolveFollowingFieldToggles(),
              followers: state.queryIds.Followers
                ? {
                    queryId: state.queryIds.Followers,
                    features: resolveFollowersFeatures(),
                    fieldToggles: resolveFollowersFieldToggles(),
                  }
                : null,
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
