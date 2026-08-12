// X Unfollow — Content Script
// Runs on x.com pages to discover the GraphQL operation contract
// (queryId + featureSwitches + fieldToggles) from the loaded JS bundles.
// X validates these per-operation, so we mirror exactly what its own client sends.

(async function () {
  const scripts = document.querySelectorAll('script[src*="abs.twimg.com/responsive-web/client-web"]');
  if (scripts.length === 0) return;

  const operations = {}; // opName -> { queryId, features: [names], fieldToggles: [names] }

  for (const script of scripts) {
    if (operations.Following && operations.Followers) break;

    try {
      const resp = await fetch(script.src);
      const js = await resp.text();

      for (const opName of ["Following", "Followers"]) {
        if (operations[opName]) continue;
        const op = extractOperation(js, opName);
        if (op) operations[opName] = op;
      }
    } catch (e) {
      // Skip failed fetches
    }
  }

  if (Object.keys(operations).length > 0) {
    browser.runtime.sendMessage({ type: "discovered-operations", operations });
  }
})();

// Extract { queryId, features, fieldToggles } for a named GraphQL operation from a bundle.
// X registers each operation as:
//   {queryId:"...",operationName:"Following",operationType:"query",metadata:{featureSwitches:[...],fieldToggles:[...]}}
// The registry entry is the one that carries the metadata, so we scan every
// occurrence of the operation name until we find one with a queryId beside it.
function extractOperation(js, opName) {
  const marker = `operationName:"${opName}"`;
  let from = 0;

  while (true) {
    const idx = js.indexOf(marker, from);
    if (idx === -1) return null;
    from = idx + marker.length;

    // queryId sits immediately before operationName in the registry entry.
    const before = js.slice(Math.max(0, idx - 80), idx);
    const qm = before.match(/queryId:"([^"]+)",\s*$/);
    let queryId = qm ? qm[1] : null;

    // metadata (featureSwitches / fieldToggles) follows operationName.
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

// Pull an array of quoted identifiers for `key:[...]` out of a code segment.
function extractStringArray(segment, key) {
  const i = segment.indexOf(key + ":[");
  if (i === -1) return null;
  const start = i + key.length + 2;
  const end = segment.indexOf("]", start);
  if (end === -1) return null;
  return [...segment.slice(start, end).matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
}
