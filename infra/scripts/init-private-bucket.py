#!/usr/bin/env python3
"""Create local S3 storage without a vendor-specific client container."""

import os
import time

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


def main() -> None:
    client = boto3.client(
        "s3",
        endpoint_url=os.environ["STORAGE_ENDPOINT"],
        aws_access_key_id=os.environ["STORAGE_ACCESS_KEY"],
        aws_secret_access_key=os.environ["STORAGE_SECRET_KEY"],
        region_name=os.environ.get("STORAGE_REGION", "us-east-1"),
        config=Config(
            connect_timeout=2,
            read_timeout=2,
            retries={"mode": "standard", "total_max_attempts": 1},
            signature_version="s3v4",
            s3={"addressing_style": "path"},
        ),
    )
    bucket = os.environ["STORAGE_BUCKET"]
    deadline = time.monotonic() + 60
    for attempt in range(30):
        try:
            client.list_buckets()
            break
        except (BotoCoreError, ClientError):
            if attempt == 29 or time.monotonic() >= deadline:
                raise SystemExit(
                    "Local S3 storage unavailable after bounded readiness retries"
                ) from None
            time.sleep(2)
    try:
        client.head_bucket(Bucket=bucket)
    except ClientError as error:
        if str(error.response.get("Error", {}).get("Code")) not in {
            "404",
            "NoSuchBucket",
            "NotFound",
        }:
            raise SystemExit("Local bucket access denied") from None
        client.create_bucket(Bucket=bucket)
    # No public policies are permitted, including on a previously existing bucket.
    client.delete_bucket_policy(Bucket=bucket)
    print("Private local S3 bucket initialized")


if __name__ == "__main__":
    main()
