import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { corsHeaders } from "../_shared/cors.ts";
import { securityHeaders } from "../_shared/security-headers.ts";
import { checkUserRateLimit, checkIpRateLimit } from "../_shared/rate-limiter.ts";
import { NotificationAnalyticsRow, AnalyticsTotals } from "../_shared/types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
  db: { schema: "service" },
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!["GET", "POST"].includes(req.method)) {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Apply rate limiting for analytics requests
    const authHeader = req.headers.get("authorization");
    let userId = null;
    
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "");
      const { data } = await supabase.auth.getUser(token);
      userId = data?.user?.id || null;
    }
    
    // Use IP-based rate limiting for anonymous requests
    const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
    const rateLimitResult = userId
      ? await checkUserRateLimit(userId, 100) // 100 analytics requests per hour for authenticated users
      : await checkIpRateLimit(clientIp, 20); // 20 analytics requests per hour for anonymous
    
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({
        error: "Rate limit exceeded",
        message: userId
          ? "You can make a maximum of 100 analytics requests per hour"
          : "You can make a maximum of 20 analytics requests per hour without authentication",
        retryAfter: rateLimitResult.retryAfter
      }), {
        status: 429,
        headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
      });
    }
    
    const params = await parseParameters(req);

    const { error: rpcError } = await supabase.rpc("aggregate_notification_analytics", {
      p_date: params.date,
      p_hour: params.hour,
    });

    if (rpcError) {
      throw new Error(`Aggregation failed: ${rpcError.message}`);
    }

    const { data: summary, error: summaryError } = await supabase
      .from("notification_analytics")
      .select("*")
      .eq("date", params.date)
      .eq("hour", params.hour)
      .order("template_id", { ascending: true });

    if (summaryError) {
      throw new Error(`Failed to fetch analytics summary: ${summaryError.message}`);
    }

    const totals = (summary ?? []).reduce(
      (acc: AnalyticsTotals, row: NotificationAnalyticsRow) => {
        acc.total_sent += row.total_sent || 0;
        acc.total_delivered += row.total_delivered || 0;
        acc.total_failed += row.total_failed || 0;
        acc.total_pending += row.total_pending || 0;
        acc.delivery_rate_samples.push(row.delivery_rate ?? 0);
        return acc;
      },
      {
        total_sent: 0,
        total_delivered: 0,
        total_failed: 0,
        total_pending: 0,
        delivery_rate_samples: [] as number[],
      } as AnalyticsTotals,
    );

    const deliveryRate = totals.delivery_rate_samples.length
      ? totals.delivery_rate_samples.reduce((a: number, b: number) => a + b, 0) / totals.delivery_rate_samples.length
      : 0;

    const payload = {
      success: true,
      date: params.date,
      hour: params.hour,
      totals: {
        total_sent: totals.total_sent,
        total_delivered: totals.total_delivered,
        total_failed: totals.total_failed,
        total_pending: totals.total_pending,
        avg_delivery_rate: Number(deliveryRate.toFixed(2)),
      },
      details: summary ?? [],
    };

    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("aggregate-notification-analytics error", error);
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
    });
  }
});

async function parseParameters(req: Request): Promise<{ date: string; hour: number }> {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return normalizeParameters(url.searchParams.get("date"), url.searchParams.get("hour"));
  }

  try {
    const body = await req.json();
    return normalizeParameters(body?.date, body?.hour);
  } catch (_error) {
    return normalizeParameters(undefined, undefined);
  }
}

function normalizeParameters(dateInput?: string | null, hourInput?: string | number | null) {
  const now = new Date();
  const date = dateInput ?? now.toISOString().split("T")[0];
  const hour = typeof hourInput === "number"
    ? hourInput
    : parseInt(typeof hourInput === "string" ? hourInput : now.getUTCHours().toString(), 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be in YYYY-MM-DD format");
  }

  if (Number.isNaN(hour) || hour < 0 || hour > 23) {
    throw new Error("hour must be between 0 and 23");
  }

  return { date, hour };
}
