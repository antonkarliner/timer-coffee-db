# FCM Notification API

Complete API for managing FCM notifications, tokens, templates, and analytics with full CRUD operations.

## Overview

This API provides comprehensive functionality for:
- **Token Management**: Register, list, and deactivate FCM tokens
- **Scheduled Notifications**: Create, read, update, and cancel scheduled notifications
- **Template Management**: Create, read, update, and delete notification templates
- **Analytics**: View and export notification analytics
- **Admin Management**: Administrative functions for user management and broadcast notifications
- **User Preferences**: Manage notification delivery preferences

## Base URL

```
https://your-project.supabase.co/functions/v1
```

## Authentication

All endpoints require Bearer token authentication:

```
Authorization: Bearer <your-jwt-token>
```

## Rate Limiting

User-based rate limiting is applied to all endpoints. Exceeding limits will result in HTTP 429 responses.

## Endpoints

### Token Management

#### Register Token
```http
POST /v1/tokens
```

**Request Body:**
```json
{
  "token": "fcm_token_string",
  "device_type": "android",
  "device_model": "Pixel 6",
  "app_version": "1.0.0",
  "metadata": {}
}
```

#### List Tokens
```http
GET /v1/tokens?limit=50&device_type=android
```

#### Deactivate Token
```http
DELETE /v1/tokens/{tokenId}
```

### Scheduled Notifications

#### Create Scheduled Notification
```http
POST /v1/scheduled
```

**Request Body:**
```json
{
  "template_id": "uuid",
  "template_data": {},
  "title": "Custom title",
  "body": "Custom message",
  "data": {},
  "priority": "normal",
  "category": "general",
  "schedule_at": "2025-12-01T10:00:00Z",
  "recurrence": "daily",
  "recurrence_data": {},
  "quiet_hours_override": false,
  "timezone": "UTC"
}
```

Scheduled requests accept `audience` (`user` by default, or `broadcast`), `platform`
(`all` by default, or `ios`, `android`, `web`), optional `user_id`, and optional
`target_user_ids` (UUID array). Only admins may schedule a broadcast or address a
user other than themselves. Broadcast `user_id` must be null or omitted;
`target_user_ids` is allowed only for broadcasts. Non-admins cannot supply it.
For user schedules, omitted `user_id` defaults to the caller. The server records
`created_by` from the authenticated caller; it cannot be set by the request.
Broadcasts require explicit `title` and `body`; template-only broadcast jobs fail.
URL fields in `data` receive the same validation as immediate broadcasts.

```json
{
  "audience": "broadcast",
  "platform": "ios",
  "target_user_ids": ["00000000-0000-4000-8000-000000000001"],
  "title": "Coffee time",
  "body": "Your next cup awaits",
  "schedule_at": "2026-10-04T12:00:00Z",
  "locale": "en",
  "translate": true
}
```

Use an operator-controlled UUID in `target_user_ids` for any live test. Admins
list, update, and cancel all schedules; other users can manage only their own.
List responses include `audience`, `platform`, `target_user_ids`, and `created_by`.
Updates accept the same recipient fields with the same permissions. Changing to
`user` clears the broadcast target list; a null `target_user_ids` clears it on a
broadcast. A broadcast is never automatically retried: any successful locale
marks it sent, with locale failures recorded in `failure_reason`. Only one
broadcast job is processed per worker invocation.

#### List Scheduled Notifications
```http
GET /v1/scheduled?limit=50&status=pending
```

#### Update Scheduled Notification
```http
PUT /v1/scheduled/{scheduledId}
```

#### Cancel Scheduled Notification
```http
DELETE /v1/scheduled/{scheduledId}
```

### Template Management

#### Create Template (Admin Only)
```http
POST /v1/templates
```

**Request Body:**
```json
{
  "name": "Welcome Template",
  "title_template": "Welcome {{user_name}}!",
  "body_template": "Thanks for joining {{app_name}}",
  "data_schema": {},
  "category": "general",
  "is_active": true,
  "metadata": {}
}
```

#### List Templates
```http
GET /v1/templates?include_inactive=false
```

#### Get Template
```http
GET /v1/templates/{templateId}
```

#### Update Template (Admin Only)
```http
PUT /v1/templates/{templateId}
```

#### Delete Template (Admin Only)
```http
DELETE /v1/templates/{templateId}
```

### Analytics (Admin Only)

#### Get Analytics
```http
GET /v1/analytics?start_date=2025-12-01&end_date=2025-12-31&template_id=uuid&device_type=android&group_by=date
```

#### Export Analytics
```http
GET /v1/analytics/export?start_date=2025-12-01&end_date=2025-12-31&export=csv
```

### Admin Management (Admin Only)

#### List Users
```http
GET /v1/admin/users?limit=50&search=user@example.com
```

#### Get User Tokens
```http
GET /v1/admin/users/{userId}/tokens
```

#### Broadcast Notification
```http
POST /v1/admin/notifications/broadcast
```

**Request Body:**
```json
{
  "title": "System Maintenance",
  "body": "System will be under maintenance",
  "data": {},
  "priority": "high",
  "category": "system",
  "target_device_types": ["android", "ios"],
  "target_user_ids": ["uuid1", "uuid2"],
  "dry_run": false
}
```

### Notifications

#### List Notifications (Enhanced)
```http
GET /v1/notifications?limit=50&offset=0&status=sent&category=marketing&priority=high&start_date=2025-12-01&end_date=2025-12-31&sort_by=created_at&sort_order=desc&userId=uuid
```

**Response includes pagination metadata:**
```json
{
  "data": [...],
  "pagination": {
    "total": 100,
    "page": 1,
    "per_page": 50,
    "total_pages": 2,
    "has_next_page": true,
    "has_prev_page": false,
    "next_offset": 50,
    "prev_offset": null
  }
}
```

#### Create Notification
```http
POST /v1/notifications
```

**Request Body:**
```json
{
  "userId": "user-uuid",
  "templateId": "template-uuid",
  "templateName": "template-name",
  "title": "Custom title",
  "body": "Custom message",
  "data": {},
  "priority": "normal",
  "category": "general"
}
```

### User Preferences

#### Get Preferences
```http
GET /v1/preferences
```

#### Update Preferences
```http
PUT /v1/preferences
```

**Request Body:**
```json
{
  "push_enabled": true,
  "quiet_hours_start": "22:00",
  "quiet_hours_end": "08:00",
  "marketing_enabled": true,
  "transactional_enabled": true,
  "social_enabled": true,
  "reminder_enabled": true,
  "priority_threshold": "normal",
  "batch_notifications": false
}
```

## Response Format

All responses follow this structure:

### Success Response
```json
{
  "data": { ... }
}
```

### Error Response
```json
{
  "error": "Error Type",
  "message": "Detailed error message"
}
```

### Pagination Response
```json
{
  "data": [...],
  "pagination": {
    "total": 100,
    "page": 1,
    "per_page": 50,
    "total_pages": 2,
    "has_next_page": true,
    "has_prev_page": false,
    "next_offset": 50,
    "prev_offset": null
  }
}
```

## HTTP Status Codes

- `200` - Success
- `201` - Created
- `202` - Accepted (for async operations)
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `429` - Rate Limited
- `500` - Internal Server Error

## Data Types

### Device Types
- `android` - Android devices
- `ios` - iOS devices  
- `web` - Web browsers

### Notification Status
- `pending` - Waiting to be sent
- `sent` - Sent to FCM
- `delivered` - Delivered to device
- `failed` - Send failed
- `cancelled` - Cancelled by user

### Notification Priority
- `low` - Low priority
- `normal` - Normal priority (default)
- `high` - High priority

### Scheduled Notification Status
- `pending` - Waiting to be sent
- `processing` - Currently being processed
- `sent` - Successfully sent
- `failed` - Send failed
- `cancelled` - Cancelled by user

### Recurrence Patterns
- `none` - One-time notification (default)
- `daily` - Daily at specified time
- `weekly` - Weekly on specified day
- `monthly` - Monthly on specified day

## Security

### Authentication
- JWT tokens are validated against Supabase Auth
- Admin endpoints require admin role in `service.admin_users` table

### Rate Limiting
- User-based rate limiting prevents abuse
- Rate limit responses include retry information

### Input Validation
- All inputs are validated using Zod schemas
- Malicious content is filtered (HTML tags removed)
- SQL injection protection through parameterized queries

### Data Protection
- Tokens are masked in responses
- IP addresses logged for security
- Row Level Security (RLS) enforced on all tables

## OpenAPI Documentation

Complete OpenAPI 3.0 specification is available in `openapi.yaml` with:
- All endpoints documented
- Request/response schemas
- Authentication requirements
- Rate limiting information
- Example requests/responses

## Error Handling

### Validation Errors
```json
{
  "error": "Bad Request",
  "message": "Invalid input: field 'device_type' must be one of: android, ios, web"
}
```

### Authorization Errors
```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired JWT token"
}
```

### Rate Limit Errors
```json
{
  "error": "Rate Limited",
  "message": "Too many requests. Try again in 60 seconds."
}
```

## Best Practices

### For Clients
1. **Handle pagination**: Use `pagination` metadata for navigation
2. **Filter efficiently**: Use specific filters to reduce data transfer
3. **Retry on 429**: Implement exponential backoff
4. **Validate input**: Client-side validation reduces errors
5. **Cache templates**: Store frequently used templates locally

### For Developers
1. **Use templates**: Reusable templates reduce duplication
2. **Schedule wisely**: Use quiet hours respectfully
3. **Monitor analytics**: Track delivery rates and failures
4. **Batch operations**: Use broadcast for multiple users
5. **Secure tokens**: Never expose FCM tokens in logs

## Deployment

The API is deployed as a Supabase Edge Function with:
- TypeScript for type safety
- Zod for input validation
- Comprehensive error handling
- Security headers and CORS
- Rate limiting protection

## Support

For API support and questions:
- Check the OpenAPI specification for detailed documentation
- Review error messages for troubleshooting
- Monitor analytics for performance insights
- Contact support for production issues
## Push audience targeting (plan 041 §5)

Immediate broadcasts and scheduled create/update accept `audience_filter`:

```json
{"locales":["de","pt"],"countries":["DE","AT"],"regions":["EU"],"platforms":["ios"]}
```

Null/absent means everyone. Null/empty dimension arrays are unrestricted. Locale,
platform and geography restrictions combine with AND. Countries and regions form
one union. The existing `platform` and `target_user_ids` restrictions also apply.
Invalid filters return 400. Scheduled filters require admin access and broadcast
audience. Lists return the saved filter; recurrence retains it. Changing a job to
user audience clears an inherited filter (an explicit non-null filter is rejected).

Broadcast `dry_run: true` returns `audience_filter` and, for non-null filters,
`matched_token_count`, without translating or sending. Null filters preserve the
existing token query and locale RPC path.

`GET /v1/admin/broadcast-reach` follows the existing admin-only read-route pattern.
Query parameters: `platform` (default `all`), `audience_filter` (URL-encoded JSON),
`target_user_ids` (URL-encoded JSON UUID array). Returns `{ "data": { "total": 0,
"by_locale": {}, "unknown_country_excluded": 0, "unknown_timezone": 0,
"total_active": 0 } }`. Counts are device tokens, not unique users. `total_active`
is all active tokens before restrictions; null locale is grouped as `unknown`.
Unknown-country exclusions match every non-geographic restriction but lack the
country or region needed to decide geographic eligibility.

The portal can also call `public.estimate_broadcast_reach` directly using its admin
JWT, with `p_audience_filter`, `p_platform`, and `p_target_user_ids`. The RPC itself
checks `public.is_admin()`; authenticated non-admins are denied.

Token columns `country`, `timezone`, `locale_source` are written by the app. Invalid
values become null rather than failing token upserts. Country is uppercased;
timezone is checked against PostgreSQL timezone names when inserted/changed;
locale source accepts `explicit` or `system`. Token grants/RLS are unchanged.
GeoIP reads `public.country_regions` using a server-side service-role key, caches
it for one hour, and warns/returns `WW` on mapping database failures.

Before relying on language/country reach, verify app plan 076 adoption and the
locale distribution. This change does not implement local-time delivery (§6).
Operator checks: [push targeting verification](../../../docs/push-audience-targeting-verification.md).
