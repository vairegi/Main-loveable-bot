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
      channels: {
        Row: {
          added_by: number | null
          created_at: string
          role: string
          telegram_chat_id: number
          title: string | null
        }
        Insert: {
          added_by?: number | null
          created_at?: string
          role: string
          telegram_chat_id: number
          title?: string | null
        }
        Update: {
          added_by?: number | null
          created_at?: string
          role?: string
          telegram_chat_id?: number
          title?: string | null
        }
        Relationships: []
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
      posts: {
        Row: {
          caption: string | null
          code: string
          created_at: string
          created_by: number | null
          extra_files: Json
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
          id?: number
          media?: Json
          media_group_id?: string | null
          posted_at?: string | null
          source_chat_id?: number
          source_message_id?: number
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
      is_telegram_bot_request: { Args: never; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
