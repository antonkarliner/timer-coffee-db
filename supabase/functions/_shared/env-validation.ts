/**
 * Environment variable validation module for Edge Functions
 * Provides centralized validation and error reporting for required environment variables
 */

/**
 * Environment variable configuration interface
 */
interface EnvVarConfig {
  name: string;
  required: boolean;
  description: string;
  validator?: (value: string) => boolean;
  defaultValue?: string;
}

/**
 * Validation result interface
 */
interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Environment variable summary interface
 */
interface EnvVarSummary {
  present: boolean;
  required: boolean;
  description: string;
  value: string;
}

/**
 * Environment summary interface
 */
interface EnvironmentSummary {
  [key: string]: EnvVarSummary;
}

/**
 * Environment variable configurations
 */
const ENV_CONFIGS: EnvVarConfig[] = [
  // Core Supabase Configuration
  {
    name: 'SUPABASE_URL',
    required: true,
    description: 'Supabase project URL',
    validator: (value) => value.startsWith('https://') && value.includes('.supabase.co')
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    required: true,
    description: 'Supabase service role key',
    validator: (value) => value.startsWith('eyJ') && value.length > 100
  },

  // Firebase Configuration
  {
    name: 'FIREBASE_SERVICE_ACCOUNT',
    required: true,
    description: 'Firebase service account JSON',
    validator: (value) => {
      try {
        const parsed = JSON.parse(value);
        return parsed.type === 'service_account' && 
               parsed.project_id && 
               parsed.private_key && 
               parsed.client_email;
      } catch {
        return false;
      }
    }
  },

  // Security Configuration
  {
    name: 'CRON_JOB_SECRET',
    required: true,
    description: 'Secret for cron job authentication',
    validator: (value) => value.length >= 32
  },
  {
    name: 'ALLOWED_ORIGINS',
    required: true,
    description: 'CORS allowed origins',
    validator: (value) => value.includes(',') && value.includes('http')
  },
  {
    name: 'DOMAIN',
    required: false,
    description: 'Application domain',
    defaultValue: 'localhost'
  },

  // Rate Limiting Configuration
  {
    name: 'RATE_LIMIT_WINDOW_MS',
    required: false,
    description: 'Rate limit window in milliseconds',
    defaultValue: '900000',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  },
  {
    name: 'RATE_LIMIT_MAX_REQUESTS',
    required: false,
    description: 'Maximum requests per rate limit window',
    defaultValue: '100',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  },
  {
    name: 'DAILY_NOTIFICATION_LIMIT',
    required: false,
    description: 'Daily notification limit per user',
    defaultValue: '50',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  },
  {
    name: 'ANONYMOUS_RATE_LIMIT',
    required: false,
    description: 'Rate limit for anonymous requests',
    defaultValue: '10',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  },

  // Redis Configuration
  {
    name: 'REDIS_URL',
    required: false,
    description: 'Redis connection URL for distributed rate limiting'
  },
  {
    name: 'REDIS_PASSWORD',
    required: false,
    description: 'Redis password'
  },
  {
    name: 'REDIS_TTL',
    required: false,
    description: 'Redis TTL in seconds',
    defaultValue: '3600',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  },

  // Monitoring Configuration
  {
    name: 'MONITORING_WEBHOOK',
    required: false,
    description: 'Webhook URL for monitoring alerts',
    validator: (value) => value.startsWith('https://') && value.includes('hooks')
  },
  {
    name: 'ERROR_REPORTING_EMAIL',
    required: false,
    description: 'Email for error reporting',
    validator: (value) => value.includes('@') && value.includes('.')
  },
  {
    name: 'LOG_LEVEL',
    required: false,
    description: 'Application log level',
    defaultValue: 'info',
    validator: (value) => ['debug', 'info', 'warn', 'error'].includes(value)
  },

  // FCM Configuration
  {
    name: 'FCM_BATCH_SIZE',
    required: false,
    description: 'FCM batch size',
    defaultValue: '500',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0 && Number(value) <= 500
  },
  {
    name: 'TOKEN_MAX_AGE_DAYS',
    required: false,
    description: 'Maximum age for FCM tokens in days',
    defaultValue: '90',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  },
  {
    name: 'MAX_REQUEST_SIZE',
    required: false,
    description: 'Maximum request size in bytes',
    defaultValue: '1048576',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  },
  {
    name: 'SCHEDULED_NOTIFICATIONS_BATCH',
    required: false,
    description: 'Batch size for scheduled notifications',
    defaultValue: '100',
    validator: (value) => !isNaN(Number(value)) && Number(value) > 0
  }
];

/**
 * Validate all environment variables
 * @returns Validation result with errors and warnings
 */
export function validateEnvironment(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const config of ENV_CONFIGS) {
    const value = Deno.env.get(config.name);
    
    // Check if required variable is missing
    if (config.required && !value) {
      errors.push(`Required environment variable ${config.name} is missing: ${config.description}`);
      continue;
    }

    // Use default value if available
    const finalValue = value || config.defaultValue;
    if (!finalValue) {
      continue;
    }

    // Validate the value
    if (config.validator && finalValue) {
      try {
        if (!config.validator(finalValue)) {
          errors.push(`Invalid value for ${config.name}: ${config.description}`);
        }
      } catch (error) {
        errors.push(`Validation error for ${config.name}: ${(error as Error).message}`);
      }
    }

    // Add warnings for optional variables that should be set in production
    if (!config.required && !value && isProduction()) {
      const recommendedVars = [
        'REDIS_URL',
        'MONITORING_WEBHOOK',
        'ERROR_REPORTING_EMAIL'
      ];
      
      if (recommendedVars.includes(config.name)) {
        warnings.push(`Optional environment variable ${config.name} should be set in production: ${config.description}`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Get environment variable with validation
 * @param name Environment variable name
 * @param defaultValue Default value if not found
 * @returns Environment variable value
 */
export function getEnvVar(name: string, defaultValue?: string): string {
  const value = Deno.env.get(name);
  
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    
    const config = ENV_CONFIGS.find(c => c.name === name);
    if (config?.required) {
      throw new Error(`Required environment variable ${name} is missing: ${config.description}`);
    }
    
    return '';
  }

  // Validate the value
  const config = ENV_CONFIGS.find(c => c.name === name);
  if (config?.validator && !config.validator(value)) {
    throw new Error(`Invalid value for environment variable ${name}: ${config.description}`);
  }

  return value;
}

/**
 * Get numeric environment variable
 * @param name Environment variable name
 * @param defaultValue Default value if not found
 * @returns Numeric value
 */
export function getEnvNumber(name: string, defaultValue: number): number {
  const value = getEnvVar(name, defaultValue.toString());
  const num = Number(value);
  
  if (isNaN(num)) {
    throw new Error(`Environment variable ${name} must be a valid number, got: ${value}`);
  }
  
  return num;
}

/**
 * Get boolean environment variable
 * @param name Environment variable name
 * @param defaultValue Default value if not found
 * @returns Boolean value
 */
export function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const value = getEnvVar(name, defaultValue.toString());
  return value.toLowerCase() === 'true';
}

/**
 * Check if running in production
 * @returns True if in production environment
 */
function isProduction(): boolean {
  const env = Deno.env.get('DENO_ENV') || Deno.env.get('ENVIRONMENT') || 'development';
  return env.toLowerCase() === 'production';
}

/**
 * Validate environment and log results
 * Should be called at the start of each Edge Function
 */
export function validateAndLogEnvironment(): void {
  const result = validateEnvironment();
  
  if (!result.isValid) {
    console.error('❌ Environment validation failed:');
    result.errors.forEach(error => console.error(`  - ${error}`));
    
    // In production, we might want to fail fast
    if (isProduction()) {
      throw new Error('Environment validation failed. Check logs for details.');
    }
  }
  
  if (result.warnings.length > 0) {
    console.warn('⚠️  Environment warnings:');
    result.warnings.forEach(warning => console.warn(`  - ${warning}`));
  }
  
  if (result.isValid && result.warnings.length === 0) {
    console.log('✅ Environment validation passed');
  }
}

/**
 * Get environment configuration summary
 * @returns Summary of environment configuration
 */
export function getEnvironmentSummary(): EnvironmentSummary {
  const summary: EnvironmentSummary = {};
  
  for (const config of ENV_CONFIGS) {
    const value = Deno.env.get(config.name);
    summary[config.name] = {
      present: !!value,
      required: config.required,
      description: config.description,
      // Mask sensitive values
      value: isSensitive(config.name) ? '***MASKED***' : (value || config.defaultValue || 'NOT_SET')
    };
  }
  
  return summary;
}

/**
 * Check if environment variable contains sensitive data
 * @param name Environment variable name
 * @returns True if variable contains sensitive data
 */
function isSensitive(name: string): boolean {
  const sensitivePatterns = [
    'KEY',
    'SECRET',
    'PASSWORD',
    'TOKEN',
    'PRIVATE',
    'SERVICE_ACCOUNT'
  ];
  
  return sensitivePatterns.some(pattern => name.toUpperCase().includes(pattern));
}

/**
 * Environment-specific configuration
 */
export const ENVIRONMENT_CONFIG = {
  isProduction: isProduction(),
  isDevelopment: !isProduction(),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  
  // Core configuration
  supabaseUrl: getEnvVar('SUPABASE_URL'),
  supabaseServiceRoleKey: getEnvVar('SUPABASE_SERVICE_ROLE_KEY'),
  firebaseServiceAccount: getEnvVar('FIREBASE_SERVICE_ACCOUNT'),
  
  // Rate limiting
  rateLimitWindowMs: getEnvNumber('RATE_LIMIT_WINDOW_MS', 900000),
  rateLimitMaxRequests: getEnvNumber('RATE_LIMIT_MAX_REQUESTS', 100),
  dailyNotificationLimit: getEnvNumber('DAILY_NOTIFICATION_LIMIT', 50),
  anonymousRateLimit: getEnvNumber('ANONYMOUS_RATE_LIMIT', 10),
  
  // FCM configuration
  fcmBatchSize: getEnvNumber('FCM_BATCH_SIZE', 500),
  tokenMaxAgeDays: getEnvNumber('TOKEN_MAX_AGE_DAYS', 90),
  maxRequestSize: getEnvNumber('MAX_REQUEST_SIZE', 1048576),
  scheduledNotificationsBatch: getEnvNumber('SCHEDULED_NOTIFICATIONS_BATCH', 100),
  
  // Redis configuration
  redisUrl: getEnvVar('REDIS_URL'),
  redisPassword: getEnvVar('REDIS_PASSWORD'),
  redisTtl: getEnvNumber('REDIS_TTL', 3600),
  
  // Monitoring
  monitoringWebhook: getEnvVar('MONITORING_WEBHOOK'),
  errorReportingEmail: getEnvVar('ERROR_REPORTING_EMAIL'),
  
  // Security
  allowedOrigins: getEnvVar('ALLOWED_ORIGINS'),
  domain: getEnvVar('DOMAIN', 'localhost'),
  cronJobSecret: getEnvVar('CRON_JOB_SECRET')
};

// Export validation result type for use in other modules
export type { ValidationResult, EnvVarConfig, EnvVarSummary, EnvironmentSummary };