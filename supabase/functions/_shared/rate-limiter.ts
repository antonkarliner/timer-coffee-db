/**
 * Rate limiting module for Edge Functions
 * Implements Redis-based rate limiting with per-user and IP-based throttling
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { validateAndLogEnvironment, ENVIRONMENT_CONFIG } from "./env-validation.ts";

// Validate environment variables
validateAndLogEnvironment();

// Supabase client for rate limit tracking
const supabaseUrl = ENVIRONMENT_CONFIG.supabaseUrl;
const serviceRoleKey = ENVIRONMENT_CONFIG.supabaseServiceRoleKey;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for rate limiting");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
  db: { schema: "service" },
});

/**
 * Rate limit result interface
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
  limitType: 'user' | 'ip' | 'anonymous' | 'daily_notifications';
}

/**
 * Check rate limit for a specific user ID
 * @param userId The user ID to check
 * @param limit Optional custom limit override
 * @returns Rate limit result
 */
export async function checkUserRateLimit(
  userId: string,
  limit: number = ENVIRONMENT_CONFIG.rateLimitMaxRequests
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - ENVIRONMENT_CONFIG.rateLimitWindowMs;
  
  try {
    // Clean old entries first
    await supabase
      .from("rate_limits")
      .delete()
      .lt("timestamp", new Date(windowStart).toISOString());
    
    // Count recent requests for this user
    const { data: existingRequests, error: countError } = await supabase
      .from("rate_limits")
      .select("id, timestamp")
      .eq("user_id", userId)
      .gte("timestamp", new Date(windowStart).toISOString());
    
    if (countError) {
      console.error("Rate limit check error:", countError);
      // Allow request if rate limiting fails
      return {
        allowed: true,
        remaining: limit - 1,
        resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
        limitType: 'user'
      };
    }
    
    const currentCount = existingRequests?.length || 0;
    const remaining = Math.max(0, limit - currentCount - 1);
    
    if (currentCount >= limit) {
      // Find oldest request to calculate retry after
      const oldestRequest = existingRequests?.[0];
      const retryAfter = oldestRequest 
        ? Math.ceil((new Date(oldestRequest.timestamp).getTime() + ENVIRONMENT_CONFIG.rateLimitWindowMs - now) / 1000)
        : Math.ceil(ENVIRONMENT_CONFIG.rateLimitWindowMs / 1000);
      
      return {
        allowed: false,
        remaining: 0,
        resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
        retryAfter,
        limitType: 'user'
      };
    }
    
    // Log this request
    await supabase
      .from("rate_limits")
      .insert({
        user_id: userId,
        ip_address: null,
        timestamp: new Date().toISOString()
      });
    
    return {
      allowed: true,
      remaining,
      resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
      limitType: 'user'
    };
  } catch (error) {
    console.error("Rate limiting error:", error);
    // Allow request if rate limiting fails
    return {
      allowed: true,
      remaining: limit - 1,
      resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
      limitType: 'user'
    };
  }
}

/**
 * Check rate limit for an IP address (for anonymous requests)
 * @param ipAddress The IP address to check
 * @param limit Optional custom limit override
 * @param failClosed Throw on database errors instead of allowing the request
 * @param rateLimitClient Injectable client for offline tests
 * @returns Rate limit result
 */
export async function checkIpRateLimit(
  ipAddress: string,
  limit: number = ENVIRONMENT_CONFIG.anonymousRateLimit,
  failClosed: boolean = false,
  rateLimitClient = supabase
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - ENVIRONMENT_CONFIG.rateLimitWindowMs;
  
  try {
    // Clean old entries first
    const { error: cleanupError } = await rateLimitClient
      .from("rate_limits")
      .delete()
      .lt("timestamp", new Date(windowStart).toISOString());
    
    if (failClosed && cleanupError) throw new Error("IP rate limit cleanup failed");

    // Count recent requests for this IP
    const { data: existingRequests, error: countError } = await rateLimitClient
      .from("rate_limits")
      .select("id, timestamp")
      .eq("ip_address", ipAddress)
      .is("user_id", null)
      .gte("timestamp", new Date(windowStart).toISOString());
    
    if (countError) {
      if (failClosed) throw new Error("IP rate limit count failed");
      console.error("IP rate limit check error:", countError);
      return {
        allowed: true,
        remaining: limit - 1,
        resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
        limitType: 'anonymous'
      };
    }
    
    const currentCount = existingRequests?.length || 0;
    const remaining = Math.max(0, limit - currentCount - 1);
    
    if (currentCount >= limit) {
      const oldestRequest = existingRequests?.[0];
      const retryAfter = oldestRequest 
        ? Math.ceil((new Date(oldestRequest.timestamp).getTime() + ENVIRONMENT_CONFIG.rateLimitWindowMs - now) / 1000)
        : Math.ceil(ENVIRONMENT_CONFIG.rateLimitWindowMs / 1000);
      
      return {
        allowed: false,
        remaining: 0,
        resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
        retryAfter,
        limitType: 'anonymous'
      };
    }
    
    // Log this request
    const { error: insertError } = await rateLimitClient
      .from("rate_limits")
      .insert({
        user_id: null,
        ip_address: ipAddress,
        timestamp: new Date().toISOString()
      });
    
    if (failClosed && insertError) throw new Error("IP rate limit accounting failed");

    return {
      allowed: true,
      remaining,
      resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
      limitType: 'anonymous'
    };
  } catch (error) {
    if (failClosed) throw new Error("IP rate limit check failed");
    console.error("IP rate limiting error:", error);
    return {
      allowed: true,
      remaining: limit - 1,
      resetTime: now + ENVIRONMENT_CONFIG.rateLimitWindowMs,
      limitType: 'anonymous'
    };
  }
}

/**
 * Check daily notification limit for a user
 * @param userId The user ID to check
 * @returns Rate limit result
 */
export async function checkDailyNotificationLimit(userId: string): Promise<RateLimitResult> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  try {
    // Count notifications sent today
    const { data: notifications, error: countError } = await supabase
      .from("notifications")
      .select("id")
      .eq("user_id", userId)
      .gte("created_at", startOfDay.toISOString())
      .in("status", ["sent", "pending"]);
    
    if (countError) {
      console.error("Daily notification limit check error:", countError);
      return {
        allowed: true,
        remaining: ENVIRONMENT_CONFIG.dailyNotificationLimit - 1,
        resetTime: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000).getTime(),
        limitType: 'daily_notifications'
      };
    }
    
    const currentCount = notifications?.length || 0;
    const remaining = Math.max(0, ENVIRONMENT_CONFIG.dailyNotificationLimit - currentCount);
    
    if (currentCount >= ENVIRONMENT_CONFIG.dailyNotificationLimit) {
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
      const retryAfter = Math.ceil((endOfDay.getTime() - now.getTime()) / 1000);
      
      return {
        allowed: false,
        remaining: 0,
        resetTime: endOfDay.getTime(),
        retryAfter,
        limitType: 'daily_notifications'
      };
    }
    
    return {
      allowed: true,
      remaining: remaining - 1,
      resetTime: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000).getTime(),
      limitType: 'daily_notifications'
    };
  } catch (error) {
    console.error("Daily notification limit error:", error);
    return {
      allowed: true,
      remaining: ENVIRONMENT_CONFIG.dailyNotificationLimit - 1,
      resetTime: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000).getTime(),
      limitType: 'daily_notifications'
    };
  }
}

/**
 * Extract client IP from request headers
 * @param request The HTTP request
 * @returns IP address string
 */
export function getClientIP(request: Request): string {
  // Check various headers for the real IP
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  
  const realIP = request.headers.get("x-real-ip");
  if (realIP) {
    return realIP.trim();
  }
  
  const cfConnectingIP = request.headers.get("cf-connecting-ip");
  if (cfConnectingIP) {
    return cfConnectingIP.trim();
  }
  
  // Fallback to a default if no headers found
  return "unknown";
}

/**
 * Create rate limit response headers
 * @param result Rate limit result
 * @returns Headers object
 */
export function createRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': result.limitType === 'daily_notifications'
      ? ENVIRONMENT_CONFIG.dailyNotificationLimit.toString()
      : result.limitType === 'anonymous'
        ? ENVIRONMENT_CONFIG.anonymousRateLimit.toString()
        : ENVIRONMENT_CONFIG.rateLimitMaxRequests.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': new Date(result.resetTime).toISOString(),
    'X-RateLimit-Type': result.limitType
  };
  
  if (result.retryAfter) {
    headers['Retry-After'] = result.retryAfter.toString();
  }
  
  return headers;
}

/**
 * Create a rate limited response
 * @param result Rate limit result
 * @returns Response object with 429 status
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  const headers = createRateLimitHeaders(result);
  
  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded",
      message: `Too many requests. Try again in ${result.retryAfter || 60} seconds.`,
      limitType: result.limitType,
      resetTime: new Date(result.resetTime).toISOString()
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }
  );
}