// X Unfollow — Content Script
// Runs on x.com pages to discover queryIds from loaded JS bundles

(async function () {
  // Find all script tags pointing to X's JS bundles
  const scripts = document.querySelectorAll('script[src*="abs.twimg.com/responsive-web/client-web"]');
  if (scripts.length === 0) return;

  const queryIds = {};

  for (const script of scripts) {
    if (queryIds.Following && queryIds.Followers) break;

    try {
      const resp = await fetch(script.src);
      const js = await resp.text();

      for (const opName of ["Following", "Followers"]) {
        if (queryIds[opName]) continue;

        const patterns = [
          new RegExp(`queryId:"([^"]+)",operationName:"${opName}"`),
          new RegExp(`queryId:"([^"]+)"[^}]*operationName:"${opName}"`),
          new RegExp(`"${opName}"[^}]*queryId:"([^"]+)"`),
        ];

        for (const pattern of patterns) {
          const match = js.match(pattern);
          if (match) {
            queryIds[opName] = match[1];
            break;
          }
        }
      }
    } catch (e) {
      // Skip failed fetches
    }
  }

  if (queryIds.Following || queryIds.Followers) {
    browser.runtime.sendMessage({ type: "discovered-queryIds", queryIds });
  }
})();
