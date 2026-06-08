"""Infrastructure: JWT verification from the platform binding contract.

JWT_ISSUER_URI / JWT_JWK_SET_URI / AUTH0_AUDIENCE arrive via envFrom
"<identity-component>-conn" when the OAM webservice sets
`identity: <component-name>` (auth0-idp). Unbound = no auth required —
the service runs open, identical to the db/cache fallbacks.
"""
from typing import Any, Optional

from fastapi import HTTPException, Request

from .config import Settings


class NullVerifier:
    """No identity bound — requests pass through unauthenticated."""

    def verify(self, request: Request) -> Optional[dict[str, Any]]:
        return None


class JwtVerifier:
    """Verifies RS256 Bearer tokens against the bound IdP's JWKS."""

    def __init__(self, settings: Settings):
        import jwt  # lazy: only needed when identity is bound
        self._jwt = jwt
        self._jwks = jwt.PyJWKClient(settings.jwt_jwk_set_uri, cache_keys=True)
        self._issuer = settings.jwt_issuer_uri
        self._audience = settings.auth0_audience

    def verify(self, request: Request) -> dict[str, Any]:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="missing bearer token")
        token = auth.removeprefix("Bearer ")
        try:
            key = self._jwks.get_signing_key_from_jwt(token).key
            return self._jwt.decode(
                token, key, algorithms=["RS256"],
                issuer=self._issuer,
                audience=self._audience or None,
                options={"verify_aud": bool(self._audience)},
            )
        except Exception as e:  # noqa: BLE001 - any token failure is a 401, detail aids debugging
            raise HTTPException(status_code=401, detail=f"invalid token: {e}") from e


def get_verifier(settings: Settings):
    if settings.jwt_issuer_uri and settings.jwt_jwk_set_uri:
        try:
            return JwtVerifier(settings)
        except Exception:
            return NullVerifier()
    return NullVerifier()
