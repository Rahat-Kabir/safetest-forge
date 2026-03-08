import os


def require_token() -> str:
    token = os.environ.get("API_TOKEN")
    if not token:
        raise RuntimeError("Missing required environment variable: API_TOKEN")
    return token
