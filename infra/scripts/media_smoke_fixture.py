#!/usr/bin/env python3
"""Select a bounded-size random R2 smoke fixture using Cloudflare's REST API.

Only metadata is read. The bucket's originals/ prefix is never modified.
"""
import argparse
import json
import os
import re
import secrets
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

EXTENSIONS = {
    "image": {".jpg", ".jpeg", ".png", ".webp", ".avif"},
    "video": {".mp4", ".mov", ".m4v", ".webm"},
}
MAX_BYTES = {"image": 25 * 1024 * 1024, "video": 200 * 1024 * 1024}
KEY_RE = re.compile(r"^originals/[A-Za-z0-9_./ -]{1,490}$")


def valid_key(key, kind):
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        return False
    if any(part in {"", ".", ".."} for part in key.split("/")):
        return False
    return any(key.lower().endswith(ext) for ext in EXTENSIONS[kind])


def eligible(item, kind):
    key = item.get("key")
    size = item.get("size")
    if not valid_key(key, kind) or not isinstance(size, int) or not 0 < size <= MAX_BYTES[kind]:
        return False
    mime = ((item.get("http_metadata") or {}).get("contentType") or "").lower()
    return not mime or mime.startswith("image/" if kind == "image" else "video/") or mime == "application/octet-stream"


def choose(kind, account, bucket, token, *, max_pages=20, opener=urlopen):
    rng = secrets.SystemRandom()
    cursor = None
    seen = 0
    selected = None
    for _ in range(max_pages):
        query = {"prefix": "originals/", "per_page": 1000}
        if cursor:
            query["cursor"] = cursor
        url = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{bucket}/objects?{urlencode(query)}"
        request = Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        try:
            with opener(request, timeout=30) as response:
                payload = json.load(response)
        except HTTPError as error:
            raise RuntimeError(f"Cloudflare R2 list failed (HTTP {error.code}); check R2 Objects Read token scope") from None
        except URLError as error:
            raise RuntimeError(f"Cloudflare R2 list network error: {error.reason}") from None
        if not payload.get("success"):
            raise RuntimeError("Cloudflare R2 list failed; check account, bucket and R2 Objects Read permission")
        for item in payload.get("result") or []:
            if eligible(item, kind):
                seen += 1
                if rng.randrange(seen) == 0:
                    selected = item["key"]
        info = payload.get("result_info") or {}
        if not info.get("is_truncated"):
            break
        next_cursor = info.get("cursor")
        if not next_cursor or next_cursor == cursor:
            raise RuntimeError("Cloudflare returned a truncated listing without a usable cursor")
        cursor = next_cursor
    if selected is None:
        raise RuntimeError(f"No eligible {kind} under originals/ (checked up to {max_pages} pages)")
    return selected, seen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=("image", "video"), required=True)
    parser.add_argument("--key", default="")
    parser.add_argument("--bucket", default="photointel")
    args = parser.parse_args()
    if args.key:
        if not valid_key(args.key, args.kind):
            parser.error("Explicit key must be a safe originals/ path with matching media extension")
        selected = args.key
        print(f"Using explicit {args.kind} fixture", file=sys.stderr)
    else:
        token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        if not token or not re.fullmatch(r"[a-fA-F0-9]{32}", account):
            parser.error("Cloudflare API token or 32-character account ID missing")
        selected, count = choose(args.kind, account, args.bucket, token)
        print(f"Selected random {args.kind} fixture from {count} eligible objects", file=sys.stderr)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"{args.kind}_key={selected}\n")
    else:
        print(selected)


if __name__ == "__main__":
    main()
