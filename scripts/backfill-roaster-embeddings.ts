#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/**
 * Backfill embeddings for all existing coffee roasters.
 * Uses the generate-roaster-embedding edge function.
 * 
 * Usage:
 *   export SUPABASE_URL=https://your-project.supabase.co
 *   export SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
 *   deno run --allow-net --allow-env scripts/backfill-roaster-embeddings.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required");
  Deno.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});

const BATCH_SIZE = 10;
const DELAY_MS = 500; // Delay between requests to avoid rate limiting

interface Roaster {
  id: number;
  roaster_name: string;
  aliases: string | null;
}

interface EmbeddingResult {
  success: boolean;
  roaster_id: number;
  embedding_dimensions?: number;
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRoastersNeedingEmbeddings(batchSize: number): Promise<Roaster[]> {
  const { data, error } = await supabase.rpc("get_roasters_needing_embeddings", {
    batch_size: batchSize,
  });

  if (error) {
    console.error(`Error fetching roasters: ${error.message}`);
    return [];
  }

  return (data || []) as Roaster[];
}

async function generateEmbedding(roaster: Roaster): Promise<boolean> {
  const payload = {
    roaster_id: roaster.id,
    roaster_name: roaster.roaster_name,
    aliases: roaster.aliases,
  };

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/generate-roaster-embedding`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (response.status === 200) {
      const result = await response.json() as EmbeddingResult;
      if (result.success) {
        console.log(`  ✓ Generated embedding for roaster ${roaster.id}: ${roaster.roaster_name}`);
        return true;
      } else {
        console.log(`  ✗ Failed for roaster ${roaster.id}: ${result.error}`);
        return false;
      }
    } else {
      const text = await response.text();
      console.log(`  ✗ HTTP error for roaster ${roaster.id}: ${response.status} ${text}`);
      return false;
    }
  } catch (error) {
    console.log(`  ✗ Exception for roaster ${roaster.id}: ${error}`);
    return false;
  }
}

async function recordBackfillResult(roasterId: number, success: boolean, errorMessage?: string): Promise<void> {
  const { error } = await supabase.rpc("record_embedding_backfill", {
    p_roaster_id: roasterId,
    p_success: success,
    p_error_message: errorMessage || null,
  });

  if (error) {
    console.log(`  Warning: Failed to record backfill result: ${error.message}`);
  }
}

async function getStats(): Promise<{ total: number; withEmbeddings: number }> {
  const { data, error } = await supabase
    .from("coffee_roasters")
    .select("id, name_embedding");

  if (error || !data) {
    return { total: 0, withEmbeddings: 0 };
  }

  const total = data.length;
  const withEmbeddings = data.filter((r) => r.name_embedding !== null).length;

  return { total, withEmbeddings };
}

async function main() {
  console.log("=" .repeat(60));
  console.log("Roaster Embedding Backfill Script");
  console.log("=" .repeat(60));

  // Get initial stats
  let stats = await getStats();
  console.log(`\nInitial state:`);
  console.log(`  Total roasters: ${stats.total}`);
  console.log(`  With embeddings: ${stats.withEmbeddings}`);
  console.log(`  Remaining: ${stats.total - stats.withEmbeddings}`);
  console.log();

  let processed = 0;
  let successCount = 0;
  let errorCount = 0;

  while (true) {
    // Get batch of roasters needing embeddings
    const roasters = await getRoastersNeedingEmbeddings(BATCH_SIZE);

    if (roasters.length === 0) {
      console.log("\nNo more roasters need embeddings!");
      break;
    }

    console.log(`\nProcessing batch of ${roasters.length} roasters...`);

    for (const roaster of roasters) {
      const success = await generateEmbedding(roaster);

      if (success) {
        successCount++;
        await recordBackfillResult(roaster.id, true);
      } else {
        errorCount++;
        await recordBackfillResult(roaster.id, false, "Failed to generate embedding");
      }

      processed++;

      // Small delay to avoid rate limiting
      await sleep(DELAY_MS);
    }

    // Show progress every batch
    stats = await getStats();
    const percent = stats.total > 0 ? (100 * stats.withEmbeddings / stats.total).toFixed(1) : "0.0";
    console.log(`\nProgress: ${stats.withEmbeddings}/${stats.total} (${percent}%)`);
  }

  // Final stats
  console.log("\n" + "=".repeat(60));
  console.log("Backfill Complete!");
  console.log("=".repeat(60));
  console.log(`Total processed: ${processed}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${errorCount}`);

  stats = await getStats();
  const finalPercent = stats.total > 0 ? (100 * stats.withEmbeddings / stats.total).toFixed(1) : "0.0";
  console.log(`\nFinal state:`);
  console.log(`  Total roasters: ${stats.total}`);
  console.log(`  With embeddings: ${stats.withEmbeddings}`);
  console.log(`  Completion: ${finalPercent}%`);
}

// Run main
main().catch((error) => {
  console.error("Fatal error:", error);
  Deno.exit(1);
});
