#!/usr/bin/env python3
"""
Backfill embeddings for all existing coffee roasters.
Processes roasters in batches and calls the generate-roaster-embedding edge function.
"""

import os
import sys
import time
import json
import requests
from typing import Optional
from urllib.parse import urljoin

# Configuration
SUPABASE_URL = os.environ.get("SUPABASE_URL")
if not SUPABASE_URL:
    print("Error: SUPABASE_URL environment variable is required", file=sys.stderr)
    sys.exit(1)
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
BATCH_SIZE = 10
DELAY_BETWEEN_REQUESTS = 0.5  # seconds to avoid rate limiting
EDGE_FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/generate-roaster-embedding"


def get_roasters_needing_embeddings(batch_size: int = BATCH_SIZE) -> list[dict]:
    """Fetch roasters that need embeddings from the database."""
    url = f"{SUPABASE_URL}/rest/v1/rpc/get_roasters_needing_embeddings"
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }

    response = requests.post(
        url,
        headers=headers,
        json={"batch_size": batch_size},
    )

    if not response.ok:
        print(f"Error fetching roasters: {response.status_code} {response.text}")
        return []

    return response.json()


def generate_embedding(roaster: dict) -> bool:
    """Call the edge function to generate an embedding for a roaster."""
    payload = {
        "roaster_id": roaster["id"],
    }

    try:
        response = requests.post(
            EDGE_FUNCTION_URL,
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30,
        )

        if response.status_code == 200:
            result = response.json()
            if result.get("success"):
                print(f"  ✓ Generated embedding for roaster {roaster['id']}: {roaster['roaster_name']}")
                return True
            else:
                print(f"  ✗ Failed for roaster {roaster['id']}: {result.get('error')}")
                return False
        else:
            print(f"  ✗ HTTP error for roaster {roaster['id']}: {response.status_code} {response.text}")
            return False

    except requests.exceptions.Timeout:
        print(f"  ✗ Timeout for roaster {roaster['id']}")
        return False
    except Exception as e:
        print(f"  ✗ Exception for roaster {roaster['id']}: {e}")
        return False


def record_backfill_result(roaster_id: int, success: bool, error_message: Optional[str] = None):
    """Record the result of the embedding generation attempt."""
    url = f"{SUPABASE_URL}/rest/v1/rpc/record_embedding_backfill"
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }

    response = requests.post(
        url,
        headers=headers,
        json={
            "p_roaster_id": roaster_id,
            "p_success": success,
            "p_error_message": error_message,
        },
    )

    if not response.ok:
        print(f"  Warning: Failed to record backfill result: {response.text}")


def get_stats() -> dict:
    """Get current backfill statistics."""
    url = f"{SUPABASE_URL}/rest/v1/coffee_roasters"
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }

    # Count total and with embeddings
    response = requests.get(
        f"{url}?select=id,name_embedding",
        headers=headers,
    )

    if not response.ok:
        return {"total": 0, "with_embeddings": 0}

    data = response.json()
    total = len(data)
    with_embeddings = sum(1 for r in data if r.get("name_embedding") is not None)

    return {"total": total, "with_embeddings": with_embeddings}


def main():
    """Main backfill loop."""
    print("=" * 60)
    print("Roaster Embedding Backfill Script")
    print("=" * 60)

    if not SUPABASE_SERVICE_ROLE_KEY:
        print("Error: SUPABASE_SERVICE_ROLE_KEY environment variable is required")
        sys.exit(1)

    # Get initial stats
    stats = get_stats()
    print(f"\nInitial state:")
    print(f"  Total roasters: {stats['total']}")
    print(f"  With embeddings: {stats['with_embeddings']}")
    print(f"  Remaining: {stats['total'] - stats['with_embeddings']}")
    print()

    processed = 0
    success_count = 0
    error_count = 0

    while True:
        # Get batch of roasters needing embeddings
        roasters = get_roasters_needing_embeddings(BATCH_SIZE)

        if not roasters:
            print("\nNo more roasters need embeddings!")
            break

        print(f"\nProcessing batch of {len(roasters)} roasters...")

        for roaster in roasters:
            success = generate_embedding(roaster)

            if success:
                success_count += 1
                record_backfill_result(roaster["id"], True)
            else:
                error_count += 1
                record_backfill_result(roaster["id"], False, "Failed to generate embedding")

            processed += 1

            # Small delay to avoid rate limiting
            time.sleep(DELAY_BETWEEN_REQUESTS)

        # Show progress every batch
        stats = get_stats()
        print(f"\nProgress: {stats['with_embeddings']}/{stats['total']} ({100*stats['with_embeddings']/stats['total']:.1f}%)")

    # Final stats
    print("\n" + "=" * 60)
    print("Backfill Complete!")
    print("=" * 60)
    print(f"Total processed: {processed}")
    print(f"Successful: {success_count}")
    print(f"Failed: {error_count}")

    stats = get_stats()
    print(f"\nFinal state:")
    print(f"  Total roasters: {stats['total']}")
    print(f"  With embeddings: {stats['with_embeddings']}")
    print(f"  Completion: {100*stats['with_embeddings']/stats['total']:.1f}%")


if __name__ == "__main__":
    main()
