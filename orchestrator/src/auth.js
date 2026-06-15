// Bearer token validation for incoming requests.
//
// Checks that the Authorization header carries a JWT that is not expired
// (exp claim). The token payload is decoded but the RS256 signature is NOT
// verified against the issuer's JWKS keys.

const CLOCK_SKEW_S = Number(process.env.AUTH_CLOCK_SKEW_S) || 30;

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
function validateBearerToken(req) {
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

  return null;
}

// Express middleware. Skips validation entirely when AUTH_APP_ID is unset.
function authMiddleware() {
  if (!process.env.AUTH_APP_ID) {
    console.warn("AUTH_APP_ID not set - bearer token validation is DISABLED");
    return (req, res, next) => next();
  }

  console.log("Bearer token validation enabled (app id check disabled)");
  return (req, res, next) => {
    const rejection = validateBearerToken(req);
    if (rejection) {
      return res.status(rejection.status).json(rejection.body);
    }
    next();
  };
}

module.exports = { authMiddleware, validateBearerToken, decodeJwtPayload };
