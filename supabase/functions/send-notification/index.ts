import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { corsHeaders } from "../_shared/cors.ts";
import { securityHeaders } from "../_shared/security-headers.ts";
import { checkUserRateLimit, createRateLimitResponse } from "../_shared/rate-limiter.ts";
import { NotificationRequest } from "../_shared/types.ts";

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body: NotificationRequest = await req.json();
    const { title, content, locale, platform, deep_link, scheduled_at } = body;
    console.log("Received notification request", {
      titlePresent: !!title,
      locale,
      platform,
      deep_link,
      scheduled_at,
    });

    // Validate required fields
    if (!title || !content) {
      return new Response(JSON.stringify({
        error: "Missing required fields: title, content"
      }), {
        status: 400,
        headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate platform if provided
    if (platform) {
      const validPlatforms = ['all', 'ios', 'android', 'web'];
      if (!validPlatforms.includes(platform)) {
        return new Response(JSON.stringify({
          error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}`
        }), {
          status: 400,
          headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Validate scheduled date if provided
    let scheduledAtDate: string | null = null;
    if (scheduled_at) {
      const parsedDate = new Date(scheduled_at);
      if (isNaN(parsedDate.getTime())) {
        return new Response(JSON.stringify({
          error: "Invalid scheduled_at format. Must be a valid ISO datetime."
        }), {
          status: 400,
          headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
        });
      }
      
      // Ensure scheduled date is in the future
      if (parsedDate.getTime() <= Date.now()) {
        return new Response(JSON.stringify({
          error: "scheduled_at must be in the future."
        }), {
          status: 400,
          headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
        });
      }
      
      scheduledAtDate = parsedDate.toISOString();
    }

    // This Edge Function uses user authentication passed from the API route
    // The API route validates admin permissions before calling this function
    const authHeader = req.headers.get('authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({
        error: "Authorization header required"
      }), {
        status: 401,
        headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
      });
    }

    const userToken = authHeader.replace('Bearer ', '');
    // Create Supabase client with user's JWT token only
    // RLS policies will handle the authentication
    const supabase = createClient(supabaseUrl, userToken);

    // Verify the user is authenticated
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
      return new Response(JSON.stringify({
        error: "Invalid authentication token"
      }), {
        status: 401,
        headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
      });
    }

    // Apply rate limiting for authenticated users
    const rateLimitResult = await checkUserRateLimit(user.id);
    if (!rateLimitResult.allowed) {
      return createRateLimitResponse(rateLimitResult);
    }

    // Insert notification - NULL scheduled_at means send immediately
    const { data, error } = await supabase
      .from('notifications')
      .insert({
        title,
        content,
        locale: locale || 'en',
        platform: platform || 'all',
        deep_link,
        scheduled_at: scheduledAtDate, // NULL for immediate send
      })
      .select()
      .single();

    if (error) {
      console.error("Error inserting notification:", error);
      return new Response(JSON.stringify({
        error: error.message,
        details: error.details
      }), {
        status: 500,
        headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Notification inserted", {
      notificationId: data.id,
      scheduled: !!scheduledAtDate,
      locale: data.locale,
      platform: data.platform,
      deep_link: data.deep_link,
    });

    return new Response(JSON.stringify({
      success: true,
      notificationId: data.id,
      message: scheduledAtDate
        ? "Notification scheduled and will be sent at the specified time"
        : "Notification created and will be sent immediately after translation",
      scheduled: !!scheduledAtDate,
      immediateSend: !scheduledAtDate
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
    });
  }
});
