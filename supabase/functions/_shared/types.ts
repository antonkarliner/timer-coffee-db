// Shared Type Definitions for Supabase Edge Functions

export type GeocodeSource = "nominatim" | "maps.co" | "gemini" | "gemini+osm";

export interface GeocodeHit {
  address: string;
  lat: number;
  lng: number;
  source: GeocodeSource;
}

// When Gemini vets a candidate, we tag source "gemini" but keep the same shape
export type CandidatePick = GeocodeHit;

// Minimal shape we use from Google Custom Search API
export interface GoogleSearchItem {
  title: string;
  link: string;
}

// Row shape for logging to service.new_roaster_candidates
// Note: Keep fields wide to avoid coupling tightly to DB types
export interface NewRoasterLogRow {
  roaster: string;
  coffee_bean_name: string;
  similar_candidates: Array<{ roaster_name: string; sim_score: number }>;
  google_search_results: GoogleSearchItem[];
  bean_search_results: GoogleSearchItem[];
  location: GeocodeHit | null;
}

// Notification System Types
export interface Notification {
  id: number;
  title: string;
  content: string;
  locale: string;
  platform: string;
  deep_link?: string;
  is_translated: boolean;
  is_sent: boolean;
  scheduled_at?: string;
  sent_at?: string;
  created_at: string;
  updated_at: string;
  notification_group_id?: string;
}

export interface NotificationRequest {
  title: string;
  content: string;
  locale?: string;
  platform?: 'ios' | 'android' | 'web' | 'all';
  deep_link?: string;
  scheduled_at?: string;
}

export interface TranslationRequest {
  text: string;
  sourceLocale: string;
  platform: string;
  deepLink?: string;
  notificationId?: number;
}

export interface TranslationResult {
  locale: string;
  content?: string;
  id?: number;
  error?: string;
}

// Database Types for Notifications
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      notifications: {
        Row: {
          id: number
          title: string
          content: string
          locale: string
          scheduled_at: string
          sent_at: string | null
          is_sent: boolean
          is_translated: boolean
          platform: string
          deep_link: string | null
          created_at: string
          updated_at: string
          notification_group_id: string
        }
        Insert: {
          id?: number
          title: string
          content: string
          locale?: string
          scheduled_at?: string
          sent_at?: string | null
          is_sent?: boolean
          is_translated?: boolean
          platform?: string
          deep_link?: string | null
          created_at?: string
          updated_at?: string
          notification_group_id?: string
        }
        Update: {
          id?: number
          title?: string
          content?: string
          locale?: string
          scheduled_at?: string
          sent_at?: string | null
          is_sent?: boolean
          is_translated?: boolean
          platform?: string
          deep_link?: string | null
          created_at?: string
          updated_at?: string
          notification_group_id?: string
        }
      }
    }
  }
}

// Notification Analytics Types
export interface NotificationAnalyticsRow {
  id: string;
  date: string;
  hour: number;
  template_id: string | null;
  device_type: string | null;
  total_sent: number;
  total_delivered: number;
  total_failed: number;
  total_pending: number;
  avg_delivery_time_ms: number | null;
  delivery_rate: number;
  failure_rate: number;
  error_invalid_token: number;
  error_quota_exceeded: number;
  error_server_error: number;
  error_timeout: number;
  error_unknown: number;
  created_at: string;
  updated_at: string;
}

export interface AnalyticsTotals {
  total_sent: number;
  total_delivered: number;
  total_failed: number;
  total_pending: number;
  delivery_rate_samples: number[];
}

