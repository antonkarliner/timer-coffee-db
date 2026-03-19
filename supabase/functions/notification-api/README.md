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