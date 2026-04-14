---
date: 2026-04-14
topic: x-unfollow-firefox-extension
---

# X Unfollow — Firefox Extension

## Problem Frame

X (Twitter) doesn't provide a built-in way to see who doesn't follow you back or to bulk-unfollow them. Manually checking each account is tedious when following hundreds or thousands of people. This extension lets you clean up your following list by identifying non-followers and unfollowing them in a controlled, reviewable way.

## Requirements

**Scanning**
- R1. Collect the authenticated user's following list and followers list from X's web UI
- R2. Compare the two lists to produce a "non-followers" list — accounts you follow that don't follow you back
- R3. Show a progress indicator while scanning (follower/following counts can be large)
- R4. Allow canceling a scan mid-run
- R5. Warn the user if a scan appears incomplete or encounters errors (e.g., failed to load all entries)

**Review UI (full-page tab)**
- R6. Open a dedicated browser tab showing the non-followers list
- R7. Each entry shows the account's avatar, display name, handle, and a checkbox (checked by default)
- R8. User can deselect individual accounts to keep following them
- R9. Provide a "Select All / Deselect All" toggle
- R10. Show summary stats: total following, total followers, non-followers count, selected-for-unfollow count

**Whitelist**
- R11. User can add accounts to a persistent whitelist (stored in extension local storage)
- R12. Whitelisted accounts appear in the non-followers list but are unchecked by default and visually marked
- R13. Whitelist persists across scans and browser sessions
- R14. The unfollow process must skip whitelisted accounts regardless of checkbox state (defense in depth)

**Unfollowing**
- R15. "Unfollow Selected" button triggers unfollowing of all checked, non-whitelisted accounts
- R16. Add randomized delays between unfollow actions to mimic human behavior (e.g., 2-8 seconds per action)
- R17. Enforce a configurable per-session unfollow cap (default ~200) with a warning when approaching the limit, to reduce risk of daily aggregate rate-limit triggers
- R18. Show per-action progress during unfollowing (X of Y unfollowed, updated after each action)
- R19. Allow canceling the unfollow process mid-run
- R20. Report results at the end: successful unfollows, failures, and skipped accounts

**Extension basics**
- R21. Firefox Manifest V2 with minimal required permissions
- R22. Extension icon in toolbar that opens the full-page tab on click
- R23. No external API calls — all data comes from X's authenticated web session

## Success Criteria

- User can identify all non-followers from their X account in one scan
- User can review, whitelist, and selectively unfollow non-followers without leaving the browser
- Rate-limiting delays and session caps keep unfollow activity within safe thresholds for normal use

## Scope Boundaries

- No X API key integration — uses the user's existing authenticated session only
- No data export (CSV, etc.) — may be added later but not in v1
- No scheduled/automatic scans — user-initiated only
- No cross-browser support — Firefox only
- Not intended for Firefox Add-ons store distribution — personal use + GitHub

## Key Decisions

- **Session data over official API**: X's API is paywalled and rate-limited; using the authenticated session is free and sufficient for personal use
- **Full-page tab over popup**: The non-followers list can be long; a full tab provides enough room for comfortable review
- **Review-first flow**: Never auto-unfollow; always show the list and require explicit confirmation before any unfollows happen
- **Manifest V2**: Simpler, fully supported in Firefox, sufficient for this use case
- **Randomized delays + session cap**: 2-8 second random delays between actions, plus a per-session cap (~200), to avoid triggering X's abuse detection at both per-action and daily aggregate levels

## Dependencies / Assumptions

- The user is logged into X in Firefox when using the extension
- X's following/followers data can be collected from the web UI (either via DOM scraping or by intercepting X's internal API responses)
- X's unfollow action can be triggered programmatically (either via DOM interaction or API replay)
- Avatar images from `pbs.twimg.com` can be loaded in the extension tab (may require CSP configuration in the manifest)

## Outstanding Questions

### Deferred to Planning
- [Affects R1][Critical, needs research] X uses virtualized infinite-scroll lists on following/followers pages — only ~15-20 entries exist in the DOM at a time. The planner must decide between two scraping architectures: (a) scroll-and-collect from DOM nodes, or (b) intercept X's internal GraphQL API responses for structured JSON data. This is the central technical decision and should be resolved first, as it affects permissions, content script design, error handling, and the communication pattern between content script and extension tab.
- [Affects R15, R16][Needs research] X's unfollow requires a two-step interaction (click "Following" button, then confirm in dialog). Alternatively, the extension could replay the underlying GraphQL mutation directly. The planner should decide which approach based on reliability and error handling tradeoffs.
- [Affects R16][Needs research] What are X's current rate-limiting thresholds for unfollow actions? The 2-8s delay range and ~200 session cap may need adjustment based on testing.
- [Affects R6, R7][Technical] Avatar images loaded from `pbs.twimg.com` in an extension page (`moz-extension://` origin) may need a CSP `img-src` directive in the manifest.
- [Affects R1 through R6][Technical] The content script (running on X's pages) and the extension tab need a communication pattern for passing scraped data and sending unfollow commands. Options include message passing, `browser.storage.local`, or a background script broker.

## Next Steps

-> `/ce:plan` for structured implementation planning
