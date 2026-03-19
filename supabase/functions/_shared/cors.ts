/**
 * CORS handling module for Edge Functions
 * Provides consistent CORS headers across all functions
 */

import { validateAndLogEnvironment, ENVIRONMENT_CONFIG } from "./env-validation.ts";

// Validate environment variables
validateAndLogEnvironment();

// Get allowed origins from environment configuration and normalize into an array
const allowedOrigins = Array.isArray(ENVIRONMENT_CONFIG.allowedOrigins)
  ? ENVIRONMENT_CONFIG.allowedOrigins
  : (ENVIRONMENT_CONFIG.allowedOrigins || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);

// Function to get appropriate CORS headers for a request
export function getCorsHeaders(requestOrigin?: string): Record<string, string> {
  // Check if the request origin is in our allowed list
  const isAllowedOrigin = requestOrigin && allowedOrigins.includes(requestOrigin);

  // Return the specific origin if allowed, otherwise return the first allowed origin
  const origin = isAllowedOrigin ? requestOrigin : (allowedOrigins[0] || '');
  
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
}

// Legacy export for backward compatibility
export const corsHeaders = getCorsHeaders();
