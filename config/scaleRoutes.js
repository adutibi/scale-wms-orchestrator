// Shared Scale API route contracts — single source of truth for both the
// orchestrator (auto-routing) and the worker (request dispatch).
//
// To add a new Scale API endpoint:
//   1. Add an entry here (name, method, pathPattern, routingKey)
//   2. Add the SQL query in worker-service/src/queries.js
//   3. Add a mapper in worker-service/src/mappers/ and a handler dispatch
//      in worker-service/src/index.js keyed by the route name

const SCALE_ROUTES = [
  {
    name: "ShipmentHeadersApi.Get",
    method: "GET",
    pathPattern: /\/ilsintegrationservices\/scaleapi\/ShipmentHeadersApi\/Get\/?$/i,
    routingKey: "worker",
  },
];

function matchScaleRoute(method, path) {
  const m = String(method || "").toUpperCase();
  const p = String(path || "");
  return SCALE_ROUTES.find((r) => r.method === m && r.pathPattern.test(p)) || null;
}

module.exports = { SCALE_ROUTES, matchScaleRoute };
