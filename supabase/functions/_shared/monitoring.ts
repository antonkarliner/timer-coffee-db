import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { ENVIRONMENT_CONFIG } from "./env-validation.ts";

// Initialize Supabase client for monitoring
const supabase = createClient(ENVIRONMENT_CONFIG.supabaseUrl, ENVIRONMENT_CONFIG.supabaseServiceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
  db: { schema: "service" },
});

// Monitoring configuration
const MONITORING_CONFIG = {
  batchSize: 50,
  flushInterval: 5000, // 5 seconds
  maxRetries: 3,
  retryDelay: 1000, // 1 second
};

// Log levels
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

// Error categories
export enum ErrorCategory {
  AUTHENTICATION = 'authentication',
  AUTHORIZATION = 'authorization',
  VALIDATION = 'validation',
  DATABASE = 'database',
  EXTERNAL_API = 'external_api',
  NETWORK = 'network',
  RATE_LIMIT = 'rate_limit',
  SYSTEM = 'system',
  BUSINESS_LOGIC = 'business_logic',
  TIMEOUT = 'timeout',
  CONFIGURATION = 'configuration',
}

// Error severity levels
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// Performance metrics interface
export interface PerformanceMetrics {
  startTime: number;
  endTime?: number;
  duration?: number;
  memoryUsage?: number;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  userId?: string;
  correlationId: string;
  service: string;
  functionName: string;
}

// Log entry interface
export interface LogEntry {
  correlationId: string;
  level: LogLevel;
  service: string;
  functionName?: string;
  userId?: string;
  userAgent?: string;
  message: string;
  details?: Record<string, unknown>;
  duration?: number;
  memoryUsage?: number;
  errorCategory?: ErrorCategory;
  errorSeverity?: ErrorSeverity;
  requestId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
}

// Health check result interface
export interface HealthCheckResult {
  component: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime?: number;
  details?: Record<string, unknown>;
  errorMessage?: string;
}

// In-memory buffer for batch logging
let logBuffer: LogEntry[] = [];
let flushTimeout: number | null = null;

/**
 * Generate a correlation ID for request tracing
 */
export function generateCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Get current memory usage in MB
 */
function getMemoryUsage(): number {
  try {
    // Try to get memory usage from performance API if available
    if (typeof performance !== 'undefined' && (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory) {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory!;
      return Math.round(memory.usedJSHeapSize / 1024 / 1024);
    }
    
    // Fallback: return 0 if memory monitoring is not available
    return 0;
  } catch {
    return 0;
  }
}



/**
 * Get user agent from request
 */
function getUserAgent(request: Request): string {
  return request.headers.get('user-agent') || 'unknown';
}

/**
 * Flush log buffer to database
 */
async function flushLogBuffer(): Promise<void> {
  if (logBuffer.length === 0) return;

  const logsToFlush = [...logBuffer];
  logBuffer = [];

  try {
    const { error } = await supabase
      .from('system_logs')
      .insert(logsToFlush.map(log => ({
        correlation_id: log.correlationId,
        level: log.level,
        service: log.service,
        function_name: log.functionName,
        user_id: log.userId,
        user_agent: log.userAgent,
        message: log.message,
        details: log.details,
        duration_ms: log.duration,
        memory_usage_mb: log.memoryUsage,
        error_category: log.errorCategory,
        error_severity: log.errorSeverity,
        request_id: log.requestId,
        endpoint: log.endpoint,
        method: log.method,
        status_code: log.statusCode,
      })));

    if (error) {
      console.error('Failed to flush logs to database:', error);
      // Re-add logs to buffer for retry
      logBuffer.unshift(...logsToFlush);
    }
  } catch (error) {
    console.error('Error flushing log buffer:', error);
    // Re-add logs to buffer for retry
    logBuffer.unshift(...logsToFlush);
  }
}

/**
 * Schedule log buffer flush
 */
function scheduleFlush(): void {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
  }
  
  flushTimeout = setTimeout(() => {
    flushLogBuffer();
  }, MONITORING_CONFIG.flushInterval);
}

/**
 * Add log entry to buffer
 */
function addToBuffer(logEntry: LogEntry): void {
  logBuffer.push(logEntry);
  
  if (logBuffer.length >= MONITORING_CONFIG.batchSize) {
    flushLogBuffer();
  } else {
    scheduleFlush();
  }
}

/**
 * Create a performance tracker
 */
export function createPerformanceTracker(
  service: string,
  functionName: string,
  correlationId: string
): PerformanceMetrics {
  return {
    startTime: Date.now(),
    correlationId,
    service,
    functionName,
  };
}

/**
 * Complete performance tracking and log metrics
 */
export function completePerformanceTracking(
  metrics: PerformanceMetrics,
  request?: Request,
  statusCode?: number,
  userId?: string
): void {
  metrics.endTime = Date.now();
  metrics.duration = metrics.endTime - metrics.startTime;
  metrics.memoryUsage = getMemoryUsage();
  metrics.statusCode = statusCode;
  metrics.userId = userId;

  if (request) {
    metrics.endpoint = new URL(request.url).pathname;
    metrics.method = request.method;
  }

  // Log performance metrics
  logInfo('Request completed', {
    correlationId: metrics.correlationId,
    service: metrics.service,
    functionName: metrics.functionName,
    duration: metrics.duration,
    memoryUsage: metrics.memoryUsage,
    endpoint: metrics.endpoint,
    method: metrics.method,
    statusCode: metrics.statusCode,
    userId: metrics.userId,
  });
}

/**
 * Log debug message
 */
export function logDebug(
  message: string,
  details?: Record<string, unknown>,
  correlationId?: string
): void {
  addToBuffer({
    correlationId: correlationId || generateCorrelationId(),
    level: LogLevel.DEBUG,
    service: 'notification-api',
    message,
    details,
  });
}

/**
 * Log info message
 */
export function logInfo(
  message: string,
  details?: Record<string, unknown>,
  correlationId?: string
): void {
  console.info(message, details ?? {});
  addToBuffer({
    correlationId: correlationId || generateCorrelationId(),
    level: LogLevel.INFO,
    service: 'notification-api',
    message,
    details,
  });
}

/**
 * Log warning message
 */
export function logWarning(
  message: string,
  details?: Record<string, unknown>,
  correlationId?: string
): void {
  console.warn(message, details ?? {});
  addToBuffer({
    correlationId: correlationId || generateCorrelationId(),
    level: LogLevel.WARN,
    service: 'notification-api',
    message,
    details,
  });
}

/**
 * Log error message
 */
export function logError(
  message: string,
  error?: Error,
  category?: ErrorCategory,
  severity?: ErrorSeverity,
  details?: Record<string, unknown>,
  correlationId?: string
): void {
  console.error(message, { ...details, error });
  addToBuffer({
    correlationId: correlationId || generateCorrelationId(),
    level: LogLevel.ERROR,
    service: 'notification-api',
    message,
    details: {
      ...details,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : undefined,
    },
    errorCategory: category,
    errorSeverity: severity || ErrorSeverity.MEDIUM,
  });
}

/**
 * Log fatal error
 */
export function logFatal(
  message: string,
  error?: Error,
  category?: ErrorCategory,
  details?: Record<string, unknown>,
  correlationId?: string
): void {
  addToBuffer({
    correlationId: correlationId || generateCorrelationId(),
    level: LogLevel.FATAL,
    service: 'notification-api',
    message,
    details: {
      ...details,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : undefined,
    },
    errorCategory: category,
    errorSeverity: ErrorSeverity.CRITICAL,
  });
}

/**
 * Log API request
 */
export function logApiRequest(
  request: Request,
  userId?: string,
  correlationId?: string
): string {
  const requestId = generateCorrelationId();
  const cid = correlationId || requestId;
  
  addToBuffer({
    correlationId: cid,
    level: LogLevel.INFO,
    service: 'notification-api',
    functionName: 'api_request',
    userId,
    userAgent: getUserAgent(request),
    message: 'API request started',
    details: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()) as Record<string, string>,
    },
    requestId,
    endpoint: new URL(request.url).pathname,
    method: request.method,
  });

  return requestId;
}

/**
 * Log API response
 */
export function logApiResponse(
  requestId: string,
  statusCode: number,
  duration: number,
  userId?: string,
  correlationId?: string
): void {
  addToBuffer({
    correlationId: correlationId || generateCorrelationId(),
    level: LogLevel.INFO,
    service: 'notification-api',
    functionName: 'api_response',
    userId,
    message: 'API request completed',
    details: {
      statusCode,
      duration,
    } as Record<string, unknown>,
    duration,
    requestId,
    statusCode,
  });
}

/**
 * Perform health check for database connectivity
 */
export async function checkDatabaseHealth(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    const { error } = await supabase
      .from('system_logs')
      .select('id')
      .limit(1);
    
    const responseTime = Date.now() - startTime;
    
    if (error) {
      return {
        component: 'database',
        status: 'unhealthy',
        responseTime,
        errorMessage: error.message,
        details: { error: error.message },
      };
    }
    
    return {
      component: 'database',
      status: 'healthy',
      responseTime,
      details: { responseTime },
    };
  } catch (error) {
    return {
      component: 'database',
      status: 'unhealthy',
      responseTime: Date.now() - startTime,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      details: { error: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
}

/**
 * Perform health check for Firebase FCM service
 */
export function checkFirebaseHealth(): HealthCheckResult {
  const startTime = Date.now();
  
  try {
    // Check if Firebase service account is accessible
    const serviceAccountKey = Deno.env.get('FIREBASE_SERVICE_ACCOUNT');
    if (!serviceAccountKey) {
      return {
        component: 'firebase_fcm',
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        errorMessage: 'Firebase service account key not configured',
        details: { error: 'Missing configuration' },
      };
    }
    
    // Parse service account key to validate format
    const serviceAccount = JSON.parse(serviceAccountKey);
    if (!serviceAccount.project_id || !serviceAccount.private_key) {
      return {
        component: 'firebase_fcm',
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        errorMessage: 'Invalid Firebase service account format',
        details: { error: 'Invalid configuration' },
      };
    }
    
    return {
      component: 'firebase_fcm',
      status: 'healthy',
      responseTime: Date.now() - startTime,
      details: { 
        projectId: serviceAccount.project_id,
        responseTime: Date.now() - startTime,
      },
    };
  } catch (error) {
    return {
      component: 'firebase_fcm',
      status: 'unhealthy',
      responseTime: Date.now() - startTime,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      details: { error: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
}

/**
 * Perform health check for Edge Function runtime
 */
export function checkRuntimeHealth(): HealthCheckResult {
  const startTime = Date.now();
  const memoryUsage = getMemoryUsage();
  
  try {
    // Basic runtime checks
    const isHealthy = memoryUsage < 1024; // Less than 1GB memory usage
    
    return {
      component: 'runtime',
      status: isHealthy ? 'healthy' : 'degraded',
      responseTime: Date.now() - startTime,
      details: {
        memoryUsage,
        isHealthy,
      },
    };
  } catch (error) {
    return {
      component: 'runtime',
      status: 'unhealthy',
      responseTime: Date.now() - startTime,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      details: { error: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
}

/**
 * Record health check results to database
 */
export async function recordHealthCheck(results: HealthCheckResult[]): Promise<void> {
  try {
    const { error } = await supabase
      .from('health_checks')
      .insert(results.map(result => ({
        service: 'notification-api',
        component: result.component,
        status: result.status,
        response_time_ms: result.responseTime,
        details: result.details as Record<string, unknown>,
        error_message: result.errorMessage,
      })));

    if (error) {
      console.error('Failed to record health check:', error);
    }
  } catch (error) {
    console.error('Error recording health check:', error);
  }
}

/**
 * Get system health status
 */
export async function getSystemHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: HealthCheckResult[];
  timestamp: string;
}> {
  const healthChecks = await Promise.all([
    checkDatabaseHealth(),
    checkFirebaseHealth(),
    checkRuntimeHealth(),
  ]);

  // Record health check results
  await recordHealthCheck(healthChecks);

  // Determine overall system status
  const hasUnhealthy = healthChecks.some(check => check.status === 'unhealthy');
  const hasDegraded = healthChecks.some(check => check.status === 'degraded');
  
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  if (hasUnhealthy) {
    overallStatus = 'unhealthy';
  } else if (hasDegraded) {
    overallStatus = 'degraded';
  } else {
    overallStatus = 'healthy';
  }

  return {
    status: overallStatus,
    components: healthChecks,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Flush any remaining logs before function exits
 */
export function flushLogsOnExit(): void {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
  }
  flushLogBuffer();
}

// Auto-flush logs on interval
setInterval(flushLogBuffer, MONITORING_CONFIG.flushInterval * 2);

// Export monitoring utilities
export const monitoring = {
  generateCorrelationId,
  createPerformanceTracker,
  completePerformanceTracking,
  logDebug,
  logInfo,
  logWarning,
  logError,
  logFatal,
  logApiRequest,
  logApiResponse,
  checkDatabaseHealth,
  checkFirebaseHealth,
  checkRuntimeHealth,
  getSystemHealth,
  recordHealthCheck,
  flushLogsOnExit,
  LogLevel,
  ErrorCategory,
  ErrorSeverity,
};
