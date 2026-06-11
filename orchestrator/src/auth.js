// Bearer token validation for incoming requests.
//
// Checks that the Authorization header carries a JWT that:
//   1. is not expired (exp claim)
//   2. was issued to an allowed application (appid claim for Azure AD v1
//      tokens, azp for v2 tokens)
//
// Allowed app IDs come from AUTH_APP_ID (comma-separated for more than one).
// When AUTH_APP_ID is not set, validation is disabled so local/dev flows
// keep working without tokens.
//
// NOTE: the token payload is decoded but the RS256 signature is NOT
// verified against the issuer's JWKS keys. Expiry/appid checks stop stale
// or wrong-app tokens, not forged ones.

const CLOCK_SKEW_S = Number(process.env.AUTH_CLOCK_SKEW_S) || 30;

function getAllowedAppIds() {
  const raw = process.env.AUTH_APP_ID || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

// Returns null when the request is allowed, or { status, body } to reject.
function validateBearerToken(req, allowedAppIds) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      status: 401,
      body: { error: "Unauthorized", message: "Missing Bearer token in Authorization header" },
    };
  }

  const payload = decodeJwtPayload(match[1]);
  if (!payload) {
    return {
      status: 401,
      body: { error: "Unauthorized", message: "Malformed token" },
    };
  }

  const nowS = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S <= nowS) {
    return {
      status: 401,
      body: { error: "Unauthorized", message: "Token expired" },
    };
  }

  const appId = String(payload.appid || payload.azp || "").toLowerCase();
  if (!appId || !allowedAppIds.includes(appId)) {
    return {
      status: 403,
      body: { error: "Forbidden", message: "Token application is not allowed" },
    };
  }

  return null;
}

// Express middleware. Skips validation entirely when AUTH_APP_ID is unset.
function authMiddleware() {
  const allowedAppIds = getAllowedAppIds();
  if (allowedAppIds.length === 0) {
    console.warn("AUTH_APP_ID not set - bearer token validation is DISABLED");
    return (req, res, next) => next();
  }

  console.log(`Bearer token validation enabled for app id(s): ${allowedAppIds.join(", ")}`);
  return (req, res, next) => {
    const rejection = validateBearerToken(req, allowedAppIds);
    if (rejection) {
      return res.status(rejection.status).json(rejection.body);
    }
    next();
  };
}

module.exports = { authMiddleware, validateBearerToken, decodeJwtPayload, getAllowedAppIds };
