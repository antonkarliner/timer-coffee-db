/**
 * Security headers module for Edge Functions
 * Implements comprehensive security headers to protect against common vulnerabilities
 */

// Get environment-specific security settings
const isDevelopment = Deno.env.get("DENO_DEPLOYMENT_ID") === undefined;
const domain = Deno.env.get("DOMAIN") || "yourdomain.com";

// Content Security Policy configuration
const getCSP = () => {
  if (isDevelopment) {
    // More permissive CSP for development
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://api.github.com https://*.supabase.co",
      "font-src 'self'",
      "object-src 'none'",
      "media-src 'self'",
      "frame-src 'none'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests"
    ].join("; ");
  } else {
    // Strict CSP for production
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: https:",
      `connect-src 'self' https://api.${domain} https://${domain}.supabase.co`,
      "font-src 'self'",
      "object-src 'none'",
      "media-src 'self'",
      "frame-src 'none'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests"
    ].join("; ");
  }
};

// Standard security headers
export const securityHeaders = {
  // Content Security Policy to prevent XSS and code injection
  'Content-Security-Policy': getCSP(),
  
  // HTTP Strict Transport Security for HTTPS enforcement
  'Strict-Transport-Security': isDevelopment 
    ? 'max-age=0; includeSubDomains; preload' 
    : 'max-age=31536000; includeSubDomains; preload',
  
  // XSS Protection header (legacy but still useful for older browsers)
  'X-XSS-Protection': '1; mode=block',
  
  // Content Type Options to prevent MIME-type sniffing
  'X-Content-Type-Options': 'nosniff',
  
  // Frame options to prevent clickjacking
  'X-Frame-Options': 'DENY',
  
  // Referrer Policy for privacy
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  
  // Permissions Policy to restrict browser features
  'Permissions-Policy': [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'payment=()',
    'usb=()',
    'magnetometer=()',
    'gyroscope=()',
    'accelerometer=()',
    'ambient-light-sensor=()',
    'autoplay=()',
    'encrypted-media=()',
    'fullscreen=(self)',
    'picture-in-picture=(self)'
  ].join(', '),
  
  // Cache control for sensitive endpoints
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  
  // Server information disclosure prevention
  'Server': 'EdgeFunction'
};

/**
 * Apply security headers to a Response object
 * @param response The response to add headers to
 * @param additionalHeaders Any additional headers to merge
 * @returns New Response with security headers applied
 */
export function applySecurityHeaders(
  response: Response, 
  additionalHeaders?: Record<string, string>
): Response {
  const headers = new Headers(response.headers);
  
  // Apply all security headers
  Object.entries(securityHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });
  
  // Apply any additional headers
  if (additionalHeaders) {
    Object.entries(additionalHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });
  }
  
  // Create new response with updated headers
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Create a new Response with security headers applied
 * @param body Response body
 * @param init Response initialization options
 * @param additionalHeaders Any additional headers to merge
 * @returns New Response with security headers applied
 */
export function createSecureResponse(
  body?: BodyInit | null,
  init?: ResponseInit & { headers?: Record<string, string> },
  additionalHeaders?: Record<string, string>
): Response {
  const response = new Response(body, init);
  return applySecurityHeaders(response, additionalHeaders);
}

/**
 * Get security headers as a plain object for manual application
 * @param additionalHeaders Any additional headers to merge
 * @returns Object containing all security headers
 */
export function getSecurityHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
  return {
    ...securityHeaders,
    ...additionalHeaders
  };
}