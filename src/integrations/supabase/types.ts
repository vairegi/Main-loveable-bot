export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          action: string
          actor_id: number | null
          actor_username: string | null
          created_at: string
          details: Json | null
          id: number
        }
        Insert: {
          action: string
          actor_id?: number | null
          actor_username?: string | null
          created_at?: string
          details?: Json | null
          id?: number
        }
        Update: {
          action?: string
          actor_id?: number | null
          actor_username?: string | null
          created_at?: string
          details?: Json | null
          id?: number
        }
        Relationships: []
      }
      admins: {
        Row: {
          added_by: number | null
          created_at: string
          first_name: string | null
          is_super_admin: boolean
          telegram_user_id: number
          username: string | null
        }
        Insert: {
          added_by?: number | null
          created_at?: string
          first_name?: string | null
          is_super_admin?: boolean
          telegram_user_id: number
          username?: string | null
        }
        Update: {
          added_by?: number | null
          created_at?: string
          first_name?: string | null
          is_super_admin?: boolean
          telegram_user_id?: number
          username?: string | null
        }
        Relationships: []
      }
      backup_copies: {
        Row: {
          backup_chat_id: number
          backup_message_id: number | null
          created_at: string
          id: number
          post_id: number
        }
        Insert: {
          backup_chat_id: number
          backup_message_id?: number | null
          created_at?: string
          id?: number
          post_id: number
        }
        Update: {
          backup_chat_id?: number
          backup_message_id?: number | null
          created_at?: string
          id?: number
          post_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "backup_copies_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_failures: {
        Row: {
          attempts: number
          backup_chat_id: number
          created_at: string
          id: number
          last_attempt_at: string
          last_error: string | null
          post_id: number
          updated_at: string
        }
        Insert: {
          attempts?: number
          backup_chat_id: number
          created_at?: string
          id?: number
          last_attempt_at?: string
          last_error?: string | null
          post_id: number
          updated_at?: string
        }
        Update: {
          attempts?: number
          backup_chat_id?: number
          created_at?: string
          id?: number
          last_attempt_at?: string
          last_error?: string | null
          post_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      bot_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      bot_users: {
        Row: {
          banned: boolean
          banned_at: string | null
          banned_reason: string | null
          fetch_count: number
          first_name: string | null
          first_seen: string
          last_seen: string
          rate_window_count: number
          rate_window_started_at: string | null
          sh_bypass_count: number
          sh_files_used: number
          sh_pending_code: string | null
          sh_pending_issued_at: string | null
          sh_pending_token: string | null
          sh_pending_verified_at: string | null
          sh_verified_until: string | null
          telegram_user_id: number
          username: string | null
        }
        Insert: {
          banned?: boolean
          banned_at?: string | null
          banned_reason?: string | null
          fetch_count?: number
          first_name?: string | null
          first_seen?: string
          last_seen?: string
          rate_window_count?: number
          rate_window_started_at?: string | null
          sh_bypass_count?: number
          sh_files_used?: number
          sh_pending_code?: string | null
          sh_pending_issued_at?: string | null
          sh_pending_token?: string | null
          sh_pending_verified_at?: string | null
          sh_verified_until?: string | null
          telegram_user_id: number
          username?: string | null
        }
        Update: {
          banned?: boolean
          banned_at?: string | null
          banned_reason?: string | null
          fetch_count?: number
          first_name?: string | null
          first_seen?: string
          last_seen?: string
          rate_window_count?: number
          rate_window_started_at?: string | null
          sh_bypass_count?: number
          sh_files_used?: number
          sh_pending_code?: string | null
          sh_pending_issued_at?: string | null
          sh_pending_token?: string | null
          sh_pending_verified_at?: string | null
          sh_verified_until?: string | null
          telegram_user_id?: number
          username?: string | null
        }
        Relationships: []
      }
      broadcast_jobs: {
        Row: {
          blocked_ids: Json
          cursor_user_id: number
          failure_samples: Json
          finished_at: string | null
          id: number
          initiator_chat_id: number
          initiator_user_id: number
          initiator_username: string | null
          last_tick_at: string | null
          mode: string
          payload_text: string | null
          source_chat_id: number | null
          source_message_id: number | null
          started_at: string
          status: string
          total_failed: number
          total_ok: number
        }
        Insert: {
          blocked_ids?: Json
          cursor_user_id?: number
          failure_samples?: Json
          finished_at?: string | null
          id?: number
          initiator_chat_id: number
          initiator_user_id: number
          initiator_username?: string | null
          last_tick_at?: string | null
          mode: string
          payload_text?: string | null
          source_chat_id?: number | null
          source_message_id?: number | null
          started_at?: string
          status?: string
          total_failed?: number
          total_ok?: number
        }
        Update: {
          blocked_ids?: Json
          cursor_user_id?: number
          failure_samples?: Json
          finished_at?: string | null
          id?: number
          initiator_chat_id?: number
          initiator_user_id?: number
          initiator_username?: string | null
          last_tick_at?: string | null
          mode?: string
          payload_text?: string | null
          source_chat_id?: number | null
          source_message_id?: number | null
          started_at?: string
          status?: string
          total_failed?: number
          total_ok?: number
        }
        Relationships: []
      }
      channels: {
        Row: {
          added_by: number | null
          created_at: string
          invite_link: string | null
          role: string
          telegram_chat_id: number
          title: string | null
        }
        Insert: {
          added_by?: number | null
          created_at?: string
          invite_link?: string | null
          role: string
          telegram_chat_id: number
          title?: string | null
        }
        Update: {
          added_by?: number | null
          created_at?: string
          invite_link?: string | null
          role?: string
          telegram_chat_id?: number
          title?: string | null
        }
        Relationships: []
      }
      deleted_posts: {
        Row: {
          caption: string | null
          code: string
          created_by: number | null
          deleted_at: string
          deleted_by: number | null
          extra_files: Json
          fetch_count: number
          id: number
          media: Json
          media_group_id: string | null
          original_created_at: string | null
          original_post_id: number
          original_posted_at: string | null
          source_chat_id: number
          source_message_id: number
        }
        Insert: {
          caption?: string | null
          code: string
          created_by?: number | null
          deleted_at?: string
          deleted_by?: number | null
          extra_files?: Json
          fetch_count?: number
          id?: number
          media?: Json
          media_group_id?: string | null
          original_created_at?: string | null
          original_post_id: number
          original_posted_at?: string | null
          source_chat_id: number
          source_message_id: number
        }
        Update: {
          caption?: string | null
          code?: string
          created_by?: number | null
          deleted_at?: string
          deleted_by?: number | null
          extra_files?: Json
          fetch_count?: number
          id?: number
          media?: Json
          media_group_id?: string | null
          original_created_at?: string | null
          original_post_id?: number
          original_posted_at?: string | null
          source_chat_id?: number
          source_message_id?: number
        }
        Relationships: []
      }
      favorites: {
        Row: {
          created_at: string
          post_id: number
          user_id: number
        }
        Insert: {
          created_at?: string
          post_id: number
          user_id: number
        }
        Update: {
          created_at?: string
          post_id?: number
          user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "favorites_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      fsub_satisfied: {
        Row: {
          channel_chat_id: number
          satisfied_at: string
          user_id: number
        }
        Insert: {
          channel_chat_id: number
          satisfied_at?: string
          user_id: number
        }
        Update: {
          channel_chat_id?: number
          satisfied_at?: string
          user_id?: number
        }
        Relationships: []
      }
      pending_deletions: {
        Row: {
          chat_id: number
          created_at: string
          delete_at: string
          id: number
          message_id: number
        }
        Insert: {
          chat_id: number
          created_at?: string
          delete_at: string
          id?: number
          message_id: number
        }
        Update: {
          chat_id?: number
          created_at?: string
          delete_at?: string
          id?: number
          message_id?: number
        }
        Relationships: []
      }
      post_copies: {
        Row: {
          created_at: string
          id: number
          main_chat_id: number
          main_message_id: number
          post_id: number
        }
        Insert: {
          created_at?: string
          id?: number
          main_chat_id: number
          main_message_id: number
          post_id: number
        }
        Update: {
          created_at?: string
          id?: number
          main_chat_id?: number
          main_message_id?: number
          post_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_copies_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_ratings: {
        Row: {
          created_at: string
          post_id: number
          rating: number
          user_id: number
        }
        Insert: {
          created_at?: string
          post_id: number
          rating: number
          user_id: number
        }
        Update: {
          created_at?: string
          post_id?: number
          rating?: number
          user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_ratings_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          caption: string | null
          code: string
          created_at: string
          created_by: number | null
          extra_files: Json
          fetch_count: number
          id: number
          media: Json
          media_group_id: string | null
          posted_at: string | null
          source_chat_id: number
          source_message_id: number
        }
        Insert: {
          caption?: string | null
          code: string
          created_at?: string
          created_by?: number | null
          extra_files?: Json
          fetch_count?: number
          id?: number
          media?: Json
          media_group_id?: string | null
          posted_at?: string | null
          source_chat_id: number
          source_message_id: number
        }
        Update: {
          caption?: string | null
          code?: string
          created_at?: string
          created_by?: number | null
          extra_files?: Json
          fetch_count?: number
          id?: number
          media?: Json
          media_group_id?: string | null
          posted_at?: string | null
          source_chat_id?: number
          source_message_id?: number
        }
        Relationships: []
      }
      search_sessions: {
        Row: {
          chat_id: number
          created_at: string
          hits: Json
          message_id: number
          query: string
          selected: Json
          user_id: number
        }
        Insert: {
          chat_id: number
          created_at?: string
          hits?: Json
          message_id: number
          query?: string
          selected?: Json
          user_id: number
        }
        Update: {
          chat_id?: number
          created_at?: string
          hits?: Json
          message_id?: number
          query?: string
          selected?: Json
          user_id?: number
        }
        Relationships: []
      }
      telegram_link_tokens: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          telegram_user_id: number
          telegram_username: string | null
          token: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          telegram_user_id: number
          telegram_username?: string | null
          token: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          telegram_user_id?: number
          telegram_username?: string | null
          token?: string
        }
        Relationships: []
      }
      telegram_updates: {
        Row: {
          received_at: string
          update_id: number
        }
        Insert: {
          received_at?: string
          update_id: number
        }
        Update: {
          received_at?: string
          update_id?: number
        }
        Relationships: []
      }
      telegram_web_links: {
        Row: {
          auth_user_id: string
          linked_at: string
          telegram_user_id: number
        }
        Insert: {
          auth_user_id: string
          linked_at?: string
          telegram_user_id: number
        }
        Update: {
          auth_user_id?: string
          linked_at?: string
          telegram_user_id?: number
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bootstrap_telegram_super_admin: {
        Args: {
          _first_name: string
          _telegram_user_id: number
          _username: string
          _webhook_secret: string
        }
        Returns: {
          added_by: number | null
          created_at: string
          first_name: string | null
          is_super_admin: boolean
          telegram_user_id: number
          username: string | null
        }
        SetofOptions: {
          from: "*"
          to: "admins"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_backup_progress_counts: {
        Args: { _backup_chat_id: number; _max_failed_attempts?: number }
        Returns: {
          already_done: number
          already_exhausted: number
          total_all: number
          total_to_do: number
        }[]
      }
      get_missing_backup_posts: {
        Args: {
          _after_post_id?: number
          _backup_chat_id: number
          _limit?: number
          _max_failed_attempts?: number
        }
        Returns: {
          caption: string
          created_at: string
          extra_files: Json
          id: number
          media: Json
          source_chat_id: number
          source_message_id: number
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_telegram_bot_request: { Args: never; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
