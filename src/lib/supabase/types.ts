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
      accreditation_indicators: {
        Row: {
          code: string
          description: string
          id: string
          order_index: number
          outcome_id: string
        }
        Insert: {
          code: string
          description: string
          id?: string
          order_index?: number
          outcome_id: string
        }
        Update: {
          code?: string
          description?: string
          id?: string
          order_index?: number
          outcome_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "accreditation_indicators_outcome_id_fkey"
            columns: ["outcome_id"]
            isOneToOne: false
            referencedRelation: "accreditation_outcomes"
            referencedColumns: ["id"]
          },
        ]
      }
      accreditation_outcomes: {
        Row: {
          code: string
          description: string | null
          id: string
          name: string
          order_index: number
          standard_id: string
        }
        Insert: {
          code: string
          description?: string | null
          id?: string
          name: string
          order_index?: number
          standard_id: string
        }
        Update: {
          code?: string
          description?: string | null
          id?: string
          name?: string
          order_index?: number
          standard_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "accreditation_outcomes_standard_id_fkey"
            columns: ["standard_id"]
            isOneToOne: false
            referencedRelation: "accreditation_standards"
            referencedColumns: ["id"]
          },
        ]
      }
      accreditation_standards: {
        Row: {
          created_at: string
          id: string
          institution_id: string | null
          is_active: boolean
          name: string
          version: string
        }
        Insert: {
          created_at?: string
          id?: string
          institution_id?: string | null
          is_active?: boolean
          name: string
          version: string
        }
        Update: {
          created_at?: string
          id?: string
          institution_id?: string | null
          is_active?: boolean
          name?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "accreditation_standards_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accreditation_standards_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_skills: {
        Row: {
          activity_id: string
          activity_type: string
          created_at: string
          id: string
          institution_id: string
          section_id: string
          skill_id: string
        }
        Insert: {
          activity_id: string
          activity_type: string
          created_at?: string
          id?: string
          institution_id: string
          section_id: string
          skill_id: string
        }
        Update: {
          activity_id?: string
          activity_type?: string
          created_at?: string
          id?: string
          institution_id?: string
          section_id?: string
          skill_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_skills_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_skills_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_skills_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_conversations: {
        Row: {
          context_hash: string | null
          created_at: string
          id: string
          metadata: Json
          section_id: string
          student_id: string
          title: string
          updated_at: string
        }
        Insert: {
          context_hash?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          section_id: string
          student_id: string
          title?: string
          updated_at?: string
        }
        Update: {
          context_hash?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          section_id?: string
          student_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_conversations_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_conversations_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          metadata: Json
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          metadata?: Json
          role: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_events: {
        Row: {
          cached_input_tokens: number
          cost_usd: number
          created_at: string
          feature: string
          id: string
          input_tokens: number
          institution_id: string
          metadata: Json
          model: string
          output_tokens: number
          section_id: string | null
          total_tokens: number | null
          user_id: string | null
        }
        Insert: {
          cached_input_tokens?: number
          cost_usd?: number
          created_at?: string
          feature: string
          id?: string
          input_tokens?: number
          institution_id: string
          metadata?: Json
          model: string
          output_tokens?: number
          section_id?: string | null
          total_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          cached_input_tokens?: number
          cost_usd?: number
          created_at?: string
          feature?: string
          id?: string
          input_tokens?: number
          institution_id?: string
          metadata?: Json
          model?: string
          output_tokens?: number
          section_id?: string | null
          total_tokens?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_comments: {
        Row: {
          announcement_id: string
          author_id: string
          content: string
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          announcement_id: string
          author_id: string
          content: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          announcement_id?: string
          author_id?: string
          content?: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_comments_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_mentions: {
        Row: {
          announcement_id: string
          created_at: string
          id: string
          notified: boolean
          student_id: string
        }
        Insert: {
          announcement_id: string
          created_at?: string
          id?: string
          notified?: boolean
          student_id: string
        }
        Update: {
          announcement_id?: string
          created_at?: string
          id?: string
          notified?: boolean
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_mentions_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_mentions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_reactions: {
        Row: {
          announcement_id: string
          created_at: string
          emoji: string
          id: string
          student_id: string
        }
        Insert: {
          announcement_id: string
          created_at?: string
          emoji: string
          id?: string
          student_id: string
        }
        Update: {
          announcement_id?: string
          created_at?: string
          emoji?: string
          id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_reactions_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_reactions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_reads: {
        Row: {
          acknowledged_at: string | null
          announcement_id: string
          id: string
          read_at: string
          student_id: string
          via_bulk: boolean
        }
        Insert: {
          acknowledged_at?: string | null
          announcement_id: string
          id?: string
          read_at?: string
          student_id: string
          via_bulk?: boolean
        }
        Update: {
          acknowledged_at?: string | null
          announcement_id?: string
          id?: string
          read_at?: string
          student_id?: string
          via_bulk?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "announcement_reads_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_reads_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          allow_comments: boolean
          allow_reactions: boolean
          attachments: Json
          author_id: string
          content: string
          created_at: string
          id: string
          is_important: boolean
          is_pinned: boolean
          linked_items: Json
          links: Json
          parent_announcement_id: string | null
          published_at: string | null
          requires_acknowledgement: boolean
          rich_content: Json | null
          scheduled_at: string | null
          section_id: string
          status: string
          title: string
          updated_at: string
          visibility: string
        }
        Insert: {
          allow_comments?: boolean
          allow_reactions?: boolean
          attachments?: Json
          author_id: string
          content?: string
          created_at?: string
          id?: string
          is_important?: boolean
          is_pinned?: boolean
          linked_items?: Json
          links?: Json
          parent_announcement_id?: string | null
          published_at?: string | null
          requires_acknowledgement?: boolean
          rich_content?: Json | null
          scheduled_at?: string | null
          section_id: string
          status?: string
          title: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          allow_comments?: boolean
          allow_reactions?: boolean
          attachments?: Json
          author_id?: string
          content?: string
          created_at?: string
          id?: string
          is_important?: boolean
          is_pinned?: boolean
          linked_items?: Json
          links?: Json
          parent_announcement_id?: string | null
          published_at?: string | null
          requires_acknowledgement?: boolean
          rich_content?: Json | null
          scheduled_at?: string | null
          section_id?: string
          status?: string
          title?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcements_parent_announcement_id_fkey"
            columns: ["parent_announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcements_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      app_notifications: {
        Row: {
          actor_id: string | null
          body: string | null
          created_at: string
          dismissed_at: string | null
          id: string
          is_read: boolean
          kind: string
          link_url: string | null
          metadata: Json
          read_at: string | null
          recipient_id: string
          title: string
        }
        Insert: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          id?: string
          is_read?: boolean
          kind: string
          link_url?: string | null
          metadata?: Json
          read_at?: string | null
          recipient_id: string
          title: string
        }
        Update: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          id?: string
          is_read?: boolean
          kind?: string
          link_url?: string | null
          metadata?: Json
          read_at?: string | null
          recipient_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_notifications_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_ai_grade_suggestions: {
        Row: {
          assignment_id: string
          confidence: string
          created_at: string
          feedback: string
          flagged_count: number
          id: string
          institution_id: string
          model: string
          rationale: Json
          section_id: string
          status: string
          student_id: string
          submission_id: string
          submission_version: string | null
          suggested_rubric_scores: Json
          suggested_score: number
          unmapped_questions: Json
          updated_at: string
        }
        Insert: {
          assignment_id: string
          confidence: string
          created_at?: string
          feedback?: string
          flagged_count?: number
          id?: string
          institution_id: string
          model: string
          rationale?: Json
          section_id: string
          status?: string
          student_id: string
          submission_id: string
          submission_version?: string | null
          suggested_rubric_scores?: Json
          suggested_score: number
          unmapped_questions?: Json
          updated_at?: string
        }
        Update: {
          assignment_id?: string
          confidence?: string
          created_at?: string
          feedback?: string
          flagged_count?: number
          id?: string
          institution_id?: string
          model?: string
          rationale?: Json
          section_id?: string
          status?: string
          student_id?: string
          submission_id?: string
          submission_version?: string | null
          suggested_rubric_scores?: Json
          suggested_score?: number
          unmapped_questions?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_ai_grade_suggestions_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_ai_grade_suggestions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_ai_grade_suggestions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_ai_grade_suggestions_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_ai_grade_suggestions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_ai_grade_suggestions_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: true
            referencedRelation: "assignment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_answer_keys: {
        Row: {
          assignment_id: string
          char_count: number
          created_at: string
          id: string
          institution_id: string
          rubric_ai: Json
          rubric_ai_draft: Json
          section_id: string
          source_name: string | null
          source_path: string | null
          text: string | null
          updated_at: string
        }
        Insert: {
          assignment_id: string
          char_count?: number
          created_at?: string
          id?: string
          institution_id: string
          rubric_ai?: Json
          rubric_ai_draft?: Json
          section_id: string
          source_name?: string | null
          source_path?: string | null
          text?: string | null
          updated_at?: string
        }
        Update: {
          assignment_id?: string
          char_count?: number
          created_at?: string
          id?: string
          institution_id?: string
          rubric_ai?: Json
          rubric_ai_draft?: Json
          section_id?: string
          source_name?: string | null
          source_path?: string | null
          text?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_answer_keys_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: true
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_answer_keys_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_answer_keys_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_answer_keys_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_designs: {
        Row: {
          assignment_id: string | null
          created_at: string
          created_by: string
          criterion_tags: Json
          failure_modes: Json
          gate_report: Json
          id: string
          individuation_axis: string
          institution_id: string
          quiz_id: string | null
          reference_invariants: Json
          rot_notes: string
          section_id: string
          shell: string
          shell_check: string | null
          spine: string
          updated_at: string
          verification_mode: string
          waivers: Json
        }
        Insert: {
          assignment_id?: string | null
          created_at?: string
          created_by: string
          criterion_tags?: Json
          failure_modes?: Json
          gate_report?: Json
          id?: string
          individuation_axis: string
          institution_id: string
          quiz_id?: string | null
          reference_invariants?: Json
          rot_notes: string
          section_id: string
          shell: string
          shell_check?: string | null
          spine: string
          updated_at?: string
          verification_mode: string
          waivers?: Json
        }
        Update: {
          assignment_id?: string | null
          created_at?: string
          created_by?: string
          criterion_tags?: Json
          failure_modes?: Json
          gate_report?: Json
          id?: string
          individuation_axis?: string
          institution_id?: string
          quiz_id?: string | null
          reference_invariants?: Json
          rot_notes?: string
          section_id?: string
          shell?: string
          shell_check?: string | null
          spine?: string
          updated_at?: string
          verification_mode?: string
          waivers?: Json
        }
        Relationships: [
          {
            foreignKeyName: "assignment_designs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_designs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_designs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_designs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_designs_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_designs_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_grading_corrections: {
        Row: {
          agreed: boolean | null
          ai_confidence: string
          ai_flagged: boolean
          ai_has_evidence: boolean
          ai_points: number
          ai_tick: boolean
          assignment_id: string
          created_at: string
          criterion_key: string
          grader_id: string
          id: string
          institution_id: string
          model: string
          professor_tick: boolean
          rubric_version: string | null
          section_id: string
          student_id: string
          submission_id: string
          suggestion_updated_at: string | null
          updated_at: string
        }
        Insert: {
          agreed?: boolean | null
          ai_confidence: string
          ai_flagged?: boolean
          ai_has_evidence?: boolean
          ai_points?: number
          ai_tick: boolean
          assignment_id: string
          created_at?: string
          criterion_key: string
          grader_id: string
          id?: string
          institution_id: string
          model: string
          professor_tick: boolean
          rubric_version?: string | null
          section_id: string
          student_id: string
          submission_id: string
          suggestion_updated_at?: string | null
          updated_at?: string
        }
        Update: {
          agreed?: boolean | null
          ai_confidence?: string
          ai_flagged?: boolean
          ai_has_evidence?: boolean
          ai_points?: number
          ai_tick?: boolean
          assignment_id?: string
          created_at?: string
          criterion_key?: string
          grader_id?: string
          id?: string
          institution_id?: string
          model?: string
          professor_tick?: boolean
          rubric_version?: string | null
          section_id?: string
          student_id?: string
          submission_id?: string
          suggestion_updated_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_grading_corrections_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_grading_corrections_grader_id_fkey"
            columns: ["grader_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_grading_corrections_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_grading_corrections_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_grading_corrections_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_grading_corrections_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_grading_corrections_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "assignment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_proctoring_logs: {
        Row: {
          assignment_id: string
          batch_index: number
          created_at: string
          events: Json
          id: string
          institution_id: string
          keystroke_count: number
          section_id: string
          student_id: string
          submission_id: string
        }
        Insert: {
          assignment_id: string
          batch_index?: number
          created_at?: string
          events?: Json
          id?: string
          institution_id: string
          keystroke_count?: number
          section_id: string
          student_id: string
          submission_id: string
        }
        Update: {
          assignment_id?: string
          batch_index?: number
          created_at?: string
          events?: Json
          id?: string
          institution_id?: string
          keystroke_count?: number
          section_id?: string
          student_id?: string
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_proctoring_logs_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_logs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_logs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_logs_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_logs_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_logs_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "assignment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_proctoring_snapshots: {
        Row: {
          assignment_id: string
          created_at: string
          face_count: number
          id: string
          institution_id: string
          section_id: string
          snapshot_url: string
          storage_path: string
          student_id: string
          submission_id: string
          timestamp_offset: number
          violation_type: string
        }
        Insert: {
          assignment_id: string
          created_at?: string
          face_count?: number
          id?: string
          institution_id: string
          section_id: string
          snapshot_url: string
          storage_path: string
          student_id: string
          submission_id: string
          timestamp_offset: number
          violation_type: string
        }
        Update: {
          assignment_id?: string
          created_at?: string
          face_count?: number
          id?: string
          institution_id?: string
          section_id?: string
          snapshot_url?: string
          storage_path?: string
          student_id?: string
          submission_id?: string
          timestamp_offset?: number
          violation_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_proctoring_snapshots_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_snapshots_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_snapshots_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_snapshots_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_snapshots_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_proctoring_snapshots_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "assignment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_regrade_requests: {
        Row: {
          assignment_id: string
          created_at: string
          id: string
          institution_id: string
          new_score: number | null
          old_score: number | null
          questions: Json
          reason: string
          resolution_note: string
          resolved_at: string | null
          resolved_by: string | null
          section_id: string
          status: string
          student_id: string
          submission_id: string
          updated_at: string
        }
        Insert: {
          assignment_id: string
          created_at?: string
          id?: string
          institution_id: string
          new_score?: number | null
          old_score?: number | null
          questions?: Json
          reason: string
          resolution_note?: string
          resolved_at?: string | null
          resolved_by?: string | null
          section_id: string
          status?: string
          student_id: string
          submission_id: string
          updated_at?: string
        }
        Update: {
          assignment_id?: string
          created_at?: string
          id?: string
          institution_id?: string
          new_score?: number | null
          old_score?: number | null
          questions?: Json
          reason?: string
          resolution_note?: string
          resolved_at?: string | null
          resolved_by?: string | null
          section_id?: string
          status?: string
          student_id?: string
          submission_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_regrade_requests_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_regrade_requests_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_regrade_requests_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_regrade_requests_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_regrade_requests_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_regrade_requests_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_regrade_requests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "assignment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_submission_comments: {
        Row: {
          author_id: string
          author_role: string
          body: string
          created_at: string
          id: string
          institution_id: string
          question_index: number
          question_label: string
          section_id: string
          submission_id: string
        }
        Insert: {
          author_id: string
          author_role: string
          body: string
          created_at?: string
          id?: string
          institution_id: string
          question_index: number
          question_label?: string
          section_id: string
          submission_id: string
        }
        Update: {
          author_id?: string
          author_role?: string
          body?: string
          created_at?: string
          id?: string
          institution_id?: string
          question_index?: number
          question_label?: string
          section_id?: string
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_submission_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submission_comments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submission_comments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submission_comments_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submission_comments_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "assignment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      assignment_submissions: {
        Row: {
          answers: Json
          assessment_started_at: string | null
          assessment_work_ended_at: string | null
          assignment_id: string
          code_content: string | null
          code_language: string | null
          created_at: string
          feedback: string
          files: Json
          graded_at: string | null
          graded_by: string | null
          graded_with_rubric: boolean
          id: string
          institution_id: string
          late_request_at: string | null
          proctoring_summary: Json | null
          resubmit_until: string | null
          rubric_comments: Json
          rubric_scores: Json
          score: number | null
          status: string
          student_id: string
          submitted_at: string | null
          text_content: string | null
          updated_at: string
          url: string | null
        }
        Insert: {
          answers?: Json
          assessment_started_at?: string | null
          assessment_work_ended_at?: string | null
          assignment_id: string
          code_content?: string | null
          code_language?: string | null
          created_at?: string
          feedback?: string
          files?: Json
          graded_at?: string | null
          graded_by?: string | null
          graded_with_rubric?: boolean
          id?: string
          institution_id: string
          late_request_at?: string | null
          proctoring_summary?: Json | null
          resubmit_until?: string | null
          rubric_comments?: Json
          rubric_scores?: Json
          score?: number | null
          status?: string
          student_id: string
          submitted_at?: string | null
          text_content?: string | null
          updated_at?: string
          url?: string | null
        }
        Update: {
          answers?: Json
          assessment_started_at?: string | null
          assessment_work_ended_at?: string | null
          assignment_id?: string
          code_content?: string | null
          code_language?: string | null
          created_at?: string
          feedback?: string
          files?: Json
          graded_at?: string | null
          graded_by?: string | null
          graded_with_rubric?: boolean
          id?: string
          institution_id?: string
          late_request_at?: string | null
          proctoring_summary?: Json | null
          resubmit_until?: string | null
          rubric_comments?: Json
          rubric_scores?: Json
          score?: number | null
          status?: string
          student_id?: string
          submitted_at?: string | null
          text_content?: string | null
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assignment_submissions_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submissions_graded_by_fkey"
            columns: ["graded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submissions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submissions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_submissions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      assignments: {
        Row: {
          created_at: string
          created_by: string
          description: string
          due_at: string | null
          end_at: string | null
          guidelines: string
          id: string
          institution_id: string
          is_graded: boolean
          module_id: string | null
          points: number
          publish_notified_at: string | null
          published_at: string | null
          reference_materials: Json
          rubric: Json
          scheduled_publish_at: string | null
          section_id: string
          settings: Json
          start_at: string | null
          status: string
          submission_type: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string
          due_at?: string | null
          end_at?: string | null
          guidelines?: string
          id?: string
          institution_id: string
          is_graded?: boolean
          module_id?: string | null
          points?: number
          publish_notified_at?: string | null
          published_at?: string | null
          reference_materials?: Json
          rubric?: Json
          scheduled_publish_at?: string | null
          section_id: string
          settings?: Json
          start_at?: string | null
          status?: string
          submission_type?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string
          due_at?: string | null
          end_at?: string | null
          guidelines?: string
          id?: string
          institution_id?: string
          is_graded?: boolean
          module_id?: string | null
          points?: number
          publish_notified_at?: string | null
          published_at?: string | null
          reference_materials?: Json
          rubric?: Json
          scheduled_publish_at?: string | null
          section_id?: string
          settings?: Json
          start_at?: string | null
          status?: string
          submission_type?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      athena_artifacts: {
        Row: {
          archived_at: string | null
          conversation_id: string | null
          created_at: string
          id: string
          institution_id: string
          kind: string
          module_id: string
          payload: Json
          section_id: string
          state: Json
          student_id: string
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          institution_id: string
          kind: string
          module_id: string
          payload: Json
          section_id: string
          state?: Json
          student_id: string
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          institution_id?: string
          kind?: string
          module_id?: string
          payload?: Json
          section_id?: string
          state?: Json
          student_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "athena_artifacts_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "athena_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_artifacts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_artifacts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_artifacts_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_artifacts_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_artifacts_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      athena_conversations: {
        Row: {
          assignment_id: string | null
          created_at: string
          id: string
          institution_id: string
          is_archived: boolean
          mode: string
          quiz_id: string | null
          section_id: string
          studio_kind: string | null
          studio_surface: string | null
          summary: string | null
          summary_through_order: number | null
          surface: string
          title: string | null
          title_locked: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          assignment_id?: string | null
          created_at?: string
          id: string
          institution_id: string
          is_archived?: boolean
          mode?: string
          quiz_id?: string | null
          section_id: string
          studio_kind?: string | null
          studio_surface?: string | null
          summary?: string | null
          summary_through_order?: number | null
          surface?: string
          title?: string | null
          title_locked?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          assignment_id?: string | null
          created_at?: string
          id?: string
          institution_id?: string
          is_archived?: boolean
          mode?: string
          quiz_id?: string | null
          section_id?: string
          studio_kind?: string | null
          studio_surface?: string | null
          summary?: string | null
          summary_through_order?: number | null
          surface?: string
          title?: string | null
          title_locked?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "athena_conversations_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_conversations_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_conversations_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_conversations_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_conversations_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      athena_messages: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          institution_id: string
          metadata: Json
          order_index: number
          parts: Json
          role: string
          section_id: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          institution_id: string
          metadata?: Json
          order_index: number
          parts: Json
          role: string
          section_id: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          institution_id?: string
          metadata?: Json
          order_index?: number
          parts?: Json
          role?: string
          section_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "athena_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "athena_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_messages_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_messages_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_messages_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      athena_rate_limits: {
        Row: {
          created_at: string
          id: string
          institution_id: string
          model_id: string
          request_count: number
          scope: string
          updated_at: string
          user_id: string
          window_start: string
        }
        Insert: {
          created_at?: string
          id?: string
          institution_id: string
          model_id: string
          request_count?: number
          scope: string
          updated_at?: string
          user_id: string
          window_start?: string
        }
        Update: {
          created_at?: string
          id?: string
          institution_id?: string
          model_id?: string
          request_count?: number
          scope?: string
          updated_at?: string
          user_id?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "athena_rate_limits_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_rate_limits_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "athena_rate_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_rate_limits: {
        Row: {
          attempt_count: number
          key: string
          updated_at: string
          window_start: string
        }
        Insert: {
          attempt_count?: number
          key: string
          updated_at?: string
          window_start?: string
        }
        Update: {
          attempt_count?: number
          key?: string
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      background_jobs: {
        Row: {
          attempts: number
          claim_expires_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          institution_id: string
          max_attempts: number
          params: Json
          progress: Json
          result: Json | null
          section_id: string | null
          started_at: string | null
          status: string
          subject_key: string | null
          summary: string | null
          type: string
        }
        Insert: {
          attempts?: number
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          institution_id: string
          max_attempts?: number
          params?: Json
          progress?: Json
          result?: Json | null
          section_id?: string | null
          started_at?: string | null
          status?: string
          subject_key?: string | null
          summary?: string | null
          type: string
        }
        Update: {
          attempts?: number
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          institution_id?: string
          max_attempts?: number
          params?: Json
          progress?: Json
          result?: Json | null
          section_id?: string | null
          started_at?: string | null
          status?: string
          subject_key?: string | null
          summary?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "background_jobs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "background_jobs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "background_jobs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "background_jobs_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      badges: {
        Row: {
          created_at: string
          created_by: string
          description: string
          icon: string
          id: string
          name: string
          section_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string
          icon?: string
          id?: string
          name: string
          section_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string
          icon?: string
          id?: string
          name?: string
          section_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "badges_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "badges_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      blocked_times: {
        Row: {
          course_code: string | null
          course_id: string | null
          course_name: string | null
          created_at: string
          date: string
          end_time: string
          id: string
          location: string
          meeting_type: string | null
          note: string
          professor_id: string
          reason: string
          recurrence: string
          recurrence_until: string | null
          start_time: string
          zoom_link: string
        }
        Insert: {
          course_code?: string | null
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          date: string
          end_time: string
          id?: string
          location?: string
          meeting_type?: string | null
          note?: string
          professor_id: string
          reason?: string
          recurrence?: string
          recurrence_until?: string | null
          start_time: string
          zoom_link?: string
        }
        Update: {
          course_code?: string | null
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          date?: string
          end_time?: string
          id?: string
          location?: string
          meeting_type?: string | null
          note?: string
          professor_id?: string
          reason?: string
          recurrence?: string
          recurrence_until?: string | null
          start_time?: string
          zoom_link?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocked_times_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocked_times_professor_id_fkey"
            columns: ["professor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          cancellation_reason: string
          cancelled_by: string | null
          course_code: string | null
          course_id: string | null
          course_name: string | null
          created_at: string
          date: string
          end_time: string
          id: string
          location: string
          meeting_type: string
          office_hours_id: string
          professor_id: string
          professor_note: string
          purpose: string
          start_time: string
          status: string
          student_id: string
          student_note: string
          title: string
          updated_at: string
          zoom_link: string
        }
        Insert: {
          cancellation_reason?: string
          cancelled_by?: string | null
          course_code?: string | null
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          date: string
          end_time: string
          id?: string
          location?: string
          meeting_type?: string
          office_hours_id: string
          professor_id: string
          professor_note?: string
          purpose?: string
          start_time: string
          status?: string
          student_id: string
          student_note?: string
          title: string
          updated_at?: string
          zoom_link?: string
        }
        Update: {
          cancellation_reason?: string
          cancelled_by?: string | null
          course_code?: string | null
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          date?: string
          end_time?: string
          id?: string
          location?: string
          meeting_type?: string
          office_hours_id?: string
          professor_id?: string
          professor_note?: string
          purpose?: string
          start_time?: string
          status?: string
          student_id?: string
          student_note?: string
          title?: string
          updated_at?: string
          zoom_link?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_office_hours_id_fkey"
            columns: ["office_hours_id"]
            isOneToOne: false
            referencedRelation: "office_hours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_professor_id_fkey"
            columns: ["professor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_tokens: {
        Row: {
          access_count: number
          created_at: string
          id: string
          is_active: boolean
          label: string
          last_accessed_at: string | null
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_count?: number
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          last_accessed_at?: string | null
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_count?: number
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          last_accessed_at?: string | null
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      certificate_challenges: {
        Row: {
          certificate_id: string
          challenge_id: string
          created_at: string
          id: string
          institution_id: string
          section_id: string
        }
        Insert: {
          certificate_id: string
          challenge_id: string
          created_at?: string
          id?: string
          institution_id: string
          section_id: string
        }
        Update: {
          certificate_id?: string
          challenge_id?: string
          created_at?: string
          id?: string
          institution_id?: string
          section_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "certificate_challenges_certificate_id_fkey"
            columns: ["certificate_id"]
            isOneToOne: false
            referencedRelation: "certificates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificate_challenges_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificate_challenges_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificate_challenges_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificate_challenges_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      certificates: {
        Row: {
          created_at: string
          created_by: string
          description: string
          id: string
          institution_id: string
          is_active: boolean
          section_id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string
          id?: string
          institution_id: string
          is_active?: boolean
          section_id: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string
          id?: string
          institution_id?: string
          is_active?: boolean
          section_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "certificates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificates_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificates_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificates_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      challenge_claims: {
        Row: {
          challenge_id: string
          claimed_at: string
          created_at: string
          id: string
          reviewed_at: string | null
          reviewed_by: string | null
          reviewer_note: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          challenge_id: string
          claimed_at?: string
          created_at?: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_note?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          challenge_id?: string
          claimed_at?: string
          created_at?: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_note?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenge_claims_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenge_claims_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenge_claims_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      challenge_submissions: {
        Row: {
          claim_id: string
          content: string | null
          created_at: string
          file_name: string | null
          file_path: string | null
          file_size: number | null
          file_url: string | null
          id: string
          submission_type: string
          updated_at: string
          url: string | null
        }
        Insert: {
          claim_id: string
          content?: string | null
          created_at?: string
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          file_url?: string | null
          id?: string
          submission_type?: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          claim_id?: string
          content?: string | null
          created_at?: string
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          file_url?: string | null
          id?: string
          submission_type?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "challenge_submissions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "challenge_claims"
            referencedColumns: ["id"]
          },
        ]
      }
      challenges: {
        Row: {
          badge_id: string | null
          bonus_points: number
          created_at: string
          created_by: string
          description: string
          difficulty: string
          due_at: string | null
          id: string
          max_claims: number | null
          points: number
          section_id: string
          source: string
          title: string
          type: string
          updated_at: string
          visibility: string
        }
        Insert: {
          badge_id?: string | null
          bonus_points?: number
          created_at?: string
          created_by: string
          description?: string
          difficulty?: string
          due_at?: string | null
          id?: string
          max_claims?: number | null
          points?: number
          section_id: string
          source?: string
          title: string
          type?: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          badge_id?: string | null
          bonus_points?: number
          created_at?: string
          created_by?: string
          description?: string
          difficulty?: string
          due_at?: string | null
          id?: string
          max_claims?: number | null
          points?: number
          section_id?: string
          source?: string
          title?: string
          type?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenges_badge_id_fkey"
            columns: ["badge_id"]
            isOneToOne: false
            referencedRelation: "badges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenges_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenges_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      class_insight_summaries: {
        Row: {
          facts: Json
          generated_at: string
          id: string
          institution_id: string
          model: string
          section_id: string
          signal_hash: string
          summary: string
        }
        Insert: {
          facts: Json
          generated_at?: string
          id?: string
          institution_id: string
          model: string
          section_id: string
          signal_hash: string
          summary: string
        }
        Update: {
          facts?: Json
          generated_at?: string
          id?: string
          institution_id?: string
          model?: string
          section_id?: string
          signal_hash?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_insight_summaries_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_insight_summaries_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_insight_summaries_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: true
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      cohort_assignments: {
        Row: {
          assigned_at: string | null
          assigned_by: string
          cohort: string
          id: string
          section_id: string
          student_id: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_by?: string
          cohort: string
          id?: string
          section_id: string
          student_id: string
        }
        Update: {
          assigned_at?: string | null
          assigned_by?: string
          cohort?: string
          id?: string
          section_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cohort_assignments_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cohort_assignments_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      course_answer_votes: {
        Row: {
          answer_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          answer_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          answer_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_answer_votes_answer_id_fkey"
            columns: ["answer_id"]
            isOneToOne: false
            referencedRelation: "course_answers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_answer_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      course_answers: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          is_accepted: boolean
          is_anonymous: boolean
          question_id: string
          status: string
          updated_at: string
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          id?: string
          is_accepted?: boolean
          is_anonymous?: boolean
          question_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          is_accepted?: boolean
          is_anonymous?: boolean
          question_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_answers_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "course_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      course_outcome_alignments: {
        Row: {
          attainment: number | null
          created_at: string
          created_by: string | null
          evidence_source_id: string | null
          evidence_source_type: string
          evidence_text: string | null
          id: string
          indicator_id: string
          institution_id: string
          level: string
          section_id: string
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          attainment?: number | null
          created_at?: string
          created_by?: string | null
          evidence_source_id?: string | null
          evidence_source_type: string
          evidence_text?: string | null
          id?: string
          indicator_id: string
          institution_id: string
          level: string
          section_id: string
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attainment?: number | null
          created_at?: string
          created_by?: string | null
          evidence_source_id?: string | null
          evidence_source_type?: string
          evidence_text?: string | null
          id?: string
          indicator_id?: string
          institution_id?: string
          level?: string
          section_id?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_outcome_alignments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_outcome_alignments_indicator_id_fkey"
            columns: ["indicator_id"]
            isOneToOne: false
            referencedRelation: "accreditation_indicators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_outcome_alignments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_outcome_alignments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_outcome_alignments_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      course_professor_insights: {
        Row: {
          author_id: string
          course_id: string
          created_at: string
          id: string
          insight_text: string
          is_anonymous: boolean
          professor_id: string
          rating_approachability: number
          rating_clarity: number
          rating_teaching: number
          status: string
          updated_at: string
        }
        Insert: {
          author_id: string
          course_id: string
          created_at?: string
          id?: string
          insight_text?: string
          is_anonymous?: boolean
          professor_id: string
          rating_approachability: number
          rating_clarity: number
          rating_teaching: number
          status?: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          course_id?: string
          created_at?: string
          id?: string
          insight_text?: string
          is_anonymous?: boolean
          professor_id?: string
          rating_approachability?: number
          rating_clarity?: number
          rating_teaching?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_professor_insights_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_professor_insights_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_professor_insights_professor_id_fkey"
            columns: ["professor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      course_questions: {
        Row: {
          author_id: string
          body: string
          course_id: string
          created_at: string
          id: string
          is_anonymous: boolean
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          author_id: string
          body?: string
          course_id: string
          created_at?: string
          id?: string
          is_anonymous?: boolean
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          body?: string
          course_id?: string
          created_at?: string
          id?: string
          is_anonymous?: boolean
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_questions_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_questions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_resources: {
        Row: {
          author_id: string
          category: string
          course_id: string
          created_at: string
          description: string
          download_count: number
          file_name: string
          file_path: string
          file_size: number | null
          file_url: string
          id: string
          is_anonymous: boolean
          mime_type: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          author_id: string
          category?: string
          course_id: string
          created_at?: string
          description?: string
          download_count?: number
          file_name: string
          file_path: string
          file_size?: number | null
          file_url: string
          id?: string
          is_anonymous?: boolean
          mime_type?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          category?: string
          course_id?: string
          created_at?: string
          description?: string
          download_count?: number
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_url?: string
          id?: string
          is_anonymous?: boolean
          mime_type?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_resources_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_resources_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_reviews: {
        Row: {
          author_id: string
          course_id: string
          created_at: string
          grade_received: string | null
          hours_per_week: number | null
          id: string
          is_anonymous: boolean
          rating_difficulty: number
          rating_grading_fairness: number
          rating_overall: number
          rating_teaching: number
          rating_workload: number
          review_text: string
          status: string
          updated_at: string
          would_take_again: boolean
        }
        Insert: {
          author_id: string
          course_id: string
          created_at?: string
          grade_received?: string | null
          hours_per_week?: number | null
          id?: string
          is_anonymous?: boolean
          rating_difficulty: number
          rating_grading_fairness: number
          rating_overall: number
          rating_teaching: number
          rating_workload: number
          review_text?: string
          status?: string
          updated_at?: string
          would_take_again?: boolean
        }
        Update: {
          author_id?: string
          course_id?: string
          created_at?: string
          grade_received?: string | null
          hours_per_week?: number | null
          id?: string
          is_anonymous?: boolean
          rating_difficulty?: number
          rating_grading_fairness?: number
          rating_overall?: number
          rating_teaching?: number
          rating_workload?: number
          review_text?: string
          status?: string
          updated_at?: string
          would_take_again?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "course_reviews_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_reviews_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_sections: {
        Row: {
          archived_at: string | null
          course_id: string | null
          created_at: string | null
          end_date: string | null
          enrollment_end_date: string | null
          enrollment_start_date: string | null
          id: string
          institution_id: string
          location: string | null
          max_students: number | null
          modality: string | null
          professor_id: string | null
          schedule: Json | null
          section_code: string
          semester: string
          settings: Json | null
          start_date: string | null
          status: string | null
          updated_at: string | null
          year: number
        }
        Insert: {
          archived_at?: string | null
          course_id?: string | null
          created_at?: string | null
          end_date?: string | null
          enrollment_end_date?: string | null
          enrollment_start_date?: string | null
          id?: string
          institution_id: string
          location?: string | null
          max_students?: number | null
          modality?: string | null
          professor_id?: string | null
          schedule?: Json | null
          section_code: string
          semester: string
          settings?: Json | null
          start_date?: string | null
          status?: string | null
          updated_at?: string | null
          year: number
        }
        Update: {
          archived_at?: string | null
          course_id?: string | null
          created_at?: string | null
          end_date?: string | null
          enrollment_end_date?: string | null
          enrollment_start_date?: string | null
          id?: string
          institution_id?: string
          location?: string | null
          max_students?: number | null
          modality?: string | null
          professor_id?: string | null
          schedule?: Json | null
          section_code?: string
          semester?: string
          settings?: Json | null
          start_date?: string | null
          status?: string | null
          updated_at?: string | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "course_sections_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_sections_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_sections_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_sections_professor_id_fkey"
            columns: ["professor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      course_skills: {
        Row: {
          course_id: string
          created_at: string
          id: string
          info: string | null
          institution_id: string
          name: string
          parent_id: string | null
          position: number
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          info?: string | null
          institution_id: string
          name: string
          parent_id?: string | null
          position?: number
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          info?: string | null
          institution_id?: string
          name?: string
          parent_id?: string | null
          position?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_skills_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_skills_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_skills_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_skills_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "course_skills"
            referencedColumns: ["id"]
          },
        ]
      }
      course_tip_votes: {
        Row: {
          created_at: string
          id: string
          tip_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          tip_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          tip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_tip_votes_tip_id_fkey"
            columns: ["tip_id"]
            isOneToOne: false
            referencedRelation: "course_tips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_tip_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      course_tips: {
        Row: {
          author_id: string
          category: string
          content: string
          course_id: string
          created_at: string
          id: string
          is_anonymous: boolean
          status: string
          updated_at: string
        }
        Insert: {
          author_id: string
          category?: string
          content: string
          course_id: string
          created_at?: string
          id?: string
          is_anonymous?: boolean
          status?: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          category?: string
          content?: string
          course_id?: string
          created_at?: string
          id?: string
          is_anonymous?: boolean
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_tips_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_tips_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          code: string
          created_at: string | null
          credits: number | null
          department_id: string | null
          description: string | null
          id: string
          institution_id: string
          level: string | null
          prerequisites: Json | null
          status: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          code: string
          created_at?: string | null
          credits?: number | null
          department_id?: string | null
          description?: string | null
          id?: string
          institution_id: string
          level?: string | null
          prerequisites?: Json | null
          status?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          code?: string
          created_at?: string | null
          credits?: number | null
          department_id?: string | null
          description?: string | null
          id?: string
          institution_id?: string
          level?: string | null
          prerequisites?: Json | null
          status?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "courses_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courses_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courses_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
        ]
      }
      department_faculty: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          bio: string | null
          city: string | null
          country: string | null
          created_at: string | null
          department_id: string | null
          employment_type: string | null
          id: string
          is_primary_department: boolean | null
          joined_at: string | null
          linkedin_url: string | null
          office_hours: string | null
          office_location: string | null
          office_phone: string | null
          position: string | null
          professor_id: string | null
          research_interests: Json | null
          resume_url: string | null
          role: string | null
          state: string | null
          status: string | null
          title: string | null
          updated_at: string | null
          website_url: string | null
          zip_code: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          bio?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          department_id?: string | null
          employment_type?: string | null
          id?: string
          is_primary_department?: boolean | null
          joined_at?: string | null
          linkedin_url?: string | null
          office_hours?: string | null
          office_location?: string | null
          office_phone?: string | null
          position?: string | null
          professor_id?: string | null
          research_interests?: Json | null
          resume_url?: string | null
          role?: string | null
          state?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          website_url?: string | null
          zip_code?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          bio?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          department_id?: string | null
          employment_type?: string | null
          id?: string
          is_primary_department?: boolean | null
          joined_at?: string | null
          linkedin_url?: string | null
          office_hours?: string | null
          office_location?: string | null
          office_phone?: string | null
          position?: string | null
          professor_id?: string | null
          research_interests?: Json | null
          resume_url?: string | null
          role?: string | null
          state?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          website_url?: string | null
          zip_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "department_faculty_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_faculty_professor_id_fkey"
            columns: ["professor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          code: string
          contact_email: string | null
          contact_phone: string | null
          created_at: string | null
          description: string | null
          id: string
          institution_id: string
          name: string
          office_location: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          code: string
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          institution_id: string
          name: string
          office_location?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          code?: string
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          institution_id?: string
          name?: string
          office_location?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "departments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
        ]
      }
      discussion_channels: {
        Row: {
          created_at: string
          created_by: string
          id: string
          is_default: boolean
          name: string
          position: number
          scope: string
          section_id: string
          status: string
          team_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          is_default?: boolean
          name: string
          position?: number
          scope: string
          section_id: string
          status?: string
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          is_default?: boolean
          name?: string
          position?: number
          scope?: string
          section_id?: string
          status?: string
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_channels_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_channels_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_channels_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      discussion_message_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "discussion_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_message_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      discussion_messages: {
        Row: {
          attachment_name: string | null
          attachment_path: string | null
          attachment_size: number | null
          attachment_type: string | null
          attachment_url: string | null
          author_id: string
          channel_id: string
          content: string
          created_at: string
          deleted_at: string | null
          deleted_by_id: string | null
          id: string
        }
        Insert: {
          attachment_name?: string | null
          attachment_path?: string | null
          attachment_size?: number | null
          attachment_type?: string | null
          attachment_url?: string | null
          author_id: string
          channel_id: string
          content?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_id?: string | null
          id?: string
        }
        Update: {
          attachment_name?: string | null
          attachment_path?: string | null
          attachment_size?: number | null
          attachment_type?: string | null
          attachment_url?: string | null
          author_id?: string
          channel_id?: string
          content?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_id?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discussion_messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "discussion_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discussion_messages_deleted_by_id_fkey"
            columns: ["deleted_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dm_channels: {
        Row: {
          created_at: string
          id: string
          last_message_at: string | null
          updated_at: string
          user_a_id: string
          user_b_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          updated_at?: string
          user_a_id: string
          user_b_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          updated_at?: string
          user_a_id?: string
          user_b_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dm_channels_user_a_id_fkey"
            columns: ["user_a_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dm_channels_user_b_id_fkey"
            columns: ["user_b_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dm_messages: {
        Row: {
          attachment_name: string | null
          attachment_path: string | null
          attachment_size: number | null
          attachment_type: string | null
          attachment_url: string | null
          author_id: string
          channel_id: string
          content: string
          created_at: string
          deleted_at: string | null
          deleted_by_id: string | null
          id: string
        }
        Insert: {
          attachment_name?: string | null
          attachment_path?: string | null
          attachment_size?: number | null
          attachment_type?: string | null
          attachment_url?: string | null
          author_id: string
          channel_id: string
          content?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_id?: string | null
          id?: string
        }
        Update: {
          attachment_name?: string | null
          attachment_path?: string | null
          attachment_size?: number | null
          attachment_type?: string | null
          attachment_url?: string | null
          author_id?: string
          channel_id?: string
          content?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_id?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dm_messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dm_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "dm_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dm_messages_deleted_by_id_fkey"
            columns: ["deleted_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dm_read_cursors: {
        Row: {
          channel_id: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          channel_id: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          channel_id?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dm_read_cursors_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "dm_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dm_read_cursors_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      email_digest_logs: {
        Row: {
          created_at: string
          digest_date: string
          id: string
          recipient_id: string
        }
        Insert: {
          created_at?: string
          digest_date: string
          id?: string
          recipient_id: string
        }
        Update: {
          created_at?: string
          digest_date?: string
          id?: string
          recipient_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_digest_logs_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      enrollments: {
        Row: {
          dropped_at: string | null
          enrolled_at: string | null
          final_grade: string | null
          final_score: number | null
          id: string
          section_id: string | null
          source: string
          status: string | null
          student_id: string | null
        }
        Insert: {
          dropped_at?: string | null
          enrolled_at?: string | null
          final_grade?: string | null
          final_score?: number | null
          id?: string
          section_id?: string | null
          source?: string
          status?: string | null
          student_id?: string | null
        }
        Update: {
          dropped_at?: string | null
          enrolled_at?: string | null
          final_grade?: string | null
          final_score?: number | null
          id?: string
          section_id?: string | null
          source?: string
          status?: string | null
          student_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "enrollments_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string | null
          device_type: string | null
          event_category: string | null
          event_type: string
          id: string
          ip_address: unknown
          metadata: Json | null
          page_url: string | null
          section_id: string | null
          session_id: string | null
          timestamp: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          device_type?: string | null
          event_category?: string | null
          event_type: string
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          page_url?: string | null
          section_id?: string | null
          session_id?: string | null
          timestamp?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          device_type?: string | null
          event_category?: string | null
          event_type?: string
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          page_url?: string | null
          section_id?: string | null
          session_id?: string | null
          timestamp?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      external_usage_events: {
        Row: {
          cost_usd: number
          created_at: string
          dedup_key: string | null
          feature: string
          id: string
          institution_id: string | null
          metadata: Json
          provider: string
          quantity: number
          section_id: string | null
          unit: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          dedup_key?: string | null
          feature: string
          id?: string
          institution_id?: string | null
          metadata?: Json
          provider: string
          quantity?: number
          section_id?: string | null
          unit: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          cost_usd?: number
          created_at?: string
          dedup_key?: string | null
          feature?: string
          id?: string
          institution_id?: string | null
          metadata?: Json
          provider?: string
          quantity?: number
          section_id?: string | null
          unit?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "external_usage_events_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "external_usage_events_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "external_usage_events_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "external_usage_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_jobs: {
        Row: {
          attempts: number
          claim_expires_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: string
          institution_id: string | null
          kind: string
          max_attempts: number
          module_item_id: string | null
          payload: Json
          started_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          heartbeat_at?: string | null
          id?: string
          institution_id?: string | null
          kind?: string
          max_attempts?: number
          module_item_id?: string | null
          payload?: Json
          started_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          claim_expires_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          heartbeat_at?: string | null
          id?: string
          institution_id?: string | null
          kind?: string
          max_attempts?: number
          module_item_id?: string | null
          payload?: Json
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "extraction_jobs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_jobs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_jobs_module_item_id_fkey"
            columns: ["module_item_id"]
            isOneToOne: false
            referencedRelation: "module_items"
            referencedColumns: ["id"]
          },
        ]
      }
      feed_items: {
        Row: {
          actor_id: string | null
          body: string | null
          created_at: string
          dismissed_at: string | null
          done_at: string | null
          due_at: string | null
          entity_id: string | null
          entity_type: string | null
          id: string
          institution_id: string
          is_actionable: boolean
          is_done: boolean
          is_read: boolean
          link_url: string | null
          metadata: Json
          read_at: string | null
          recipient_id: string
          section_id: string | null
          title: string
          type: string
        }
        Insert: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          done_at?: string | null
          due_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          institution_id: string
          is_actionable?: boolean
          is_done?: boolean
          is_read?: boolean
          link_url?: string | null
          metadata?: Json
          read_at?: string | null
          recipient_id: string
          section_id?: string | null
          title: string
          type: string
        }
        Update: {
          actor_id?: string | null
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          done_at?: string | null
          due_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          institution_id?: string
          is_actionable?: boolean
          is_done?: boolean
          is_read?: boolean
          link_url?: string | null
          metadata?: Json
          read_at?: string | null
          recipient_id?: string
          section_id?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "feed_items_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_items_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_items_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_items_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_items_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      feedbacks: {
        Row: {
          admin_notes: string | null
          category: string
          created_at: string
          id: string
          institution_id: string
          message: string | null
          page_context: Json
          page_url: string
          rating: number
          status: string
          updated_at: string
          user_id: string
          user_role: string
        }
        Insert: {
          admin_notes?: string | null
          category: string
          created_at?: string
          id?: string
          institution_id: string
          message?: string | null
          page_context?: Json
          page_url: string
          rating: number
          status?: string
          updated_at?: string
          user_id: string
          user_role: string
        }
        Update: {
          admin_notes?: string | null
          category?: string
          created_at?: string
          id?: string
          institution_id?: string
          message?: string | null
          page_context?: Json
          page_url?: string
          rating?: number
          status?: string
          updated_at?: string
          user_id?: string
          user_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedbacks_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedbacks_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedbacks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      future_contributors: {
        Row: {
          created_at: string
          id: string
          message: string | null
          project_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message?: string | null
          project_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string | null
          project_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "future_contributors_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "future_contributors_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      github_connections: {
        Row: {
          access_token: string
          avatar_url: string | null
          connected_at: string
          created_at: string
          github_user_id: number
          github_username: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          avatar_url?: string | null
          connected_at?: string
          created_at?: string
          github_user_id: number
          github_username: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          avatar_url?: string | null
          connected_at?: string
          created_at?: string
          github_user_id?: number
          github_username?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_connections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      grade_categories: {
        Row: {
          aggregation: string
          created_at: string
          id: string
          institution_id: string
          is_extra_credit: boolean
          keep_n: number | null
          name: string
          position: number
          scheme_id: string
          score_mode: string
          section_id: string
          updated_at: string
          weight: number
        }
        Insert: {
          aggregation?: string
          created_at?: string
          id?: string
          institution_id: string
          is_extra_credit?: boolean
          keep_n?: number | null
          name: string
          position?: number
          scheme_id: string
          score_mode?: string
          section_id: string
          updated_at?: string
          weight?: number
        }
        Update: {
          aggregation?: string
          created_at?: string
          id?: string
          institution_id?: string
          is_extra_credit?: boolean
          keep_n?: number | null
          name?: string
          position?: number
          scheme_id?: string
          score_mode?: string
          section_id?: string
          updated_at?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "grade_categories_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_categories_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_categories_scheme_id_fkey"
            columns: ["scheme_id"]
            isOneToOne: false
            referencedRelation: "grading_schemes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_categories_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      grade_category_items: {
        Row: {
          category_id: string
          created_at: string
          id: string
          institution_id: string
          is_extra_credit: boolean
          item_id: string
          item_type: string
          section_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          institution_id: string
          is_extra_credit?: boolean
          item_id: string
          item_type: string
          section_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          institution_id?: string
          is_extra_credit?: boolean
          item_id?: string
          item_type?: string
          section_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "grade_category_items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "grade_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_category_items_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_category_items_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_category_items_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      grade_exceptions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          institution_id: string
          item_id: string
          item_type: string
          section_id: string
          status: string
          student_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          institution_id: string
          item_id: string
          item_type: string
          section_id: string
          status?: string
          student_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          institution_id?: string
          item_id?: string
          item_type?: string
          section_id?: string
          status?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "grade_exceptions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_exceptions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_exceptions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_exceptions_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_exceptions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      grading_schemes: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          institution_id: string
          letter_cutoffs: Json
          section_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          institution_id: string
          letter_cutoffs?: Json
          section_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          institution_id?: string
          letter_cutoffs?: Json
          section_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "grading_schemes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grading_schemes_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grading_schemes_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grading_schemes_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: true
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      institution_feature_requests: {
        Row: {
          created_at: string
          feature_key: string
          id: string
          institution_id: string
          message: string | null
          requested_by: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          feature_key: string
          id?: string
          institution_id: string
          message?: string | null
          requested_by: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          feature_key?: string
          id?: string
          institution_id?: string
          message?: string | null
          requested_by?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "institution_feature_requests_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "institution_feature_requests_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "institution_feature_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "institution_feature_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      institutions: {
        Row: {
          add_drop_deadline_days: number | null
          allow_student_drop: boolean
          created_at: string
          id: string
          name: string
          settings: Json
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          add_drop_deadline_days?: number | null
          allow_student_drop?: boolean
          created_at?: string
          id?: string
          name: string
          settings?: Json
          slug: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          add_drop_deadline_days?: number | null
          allow_student_drop?: boolean
          created_at?: string
          id?: string
          name?: string
          settings?: Json
          slug?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      invite_redirects: {
        Row: {
          action_link: string
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          purpose: string
          redeemed_at: string | null
          revoked_at: string | null
          short_id: string
        }
        Insert: {
          action_link: string
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          purpose: string
          redeemed_at?: string | null
          revoked_at?: string | null
          short_id: string
        }
        Update: {
          action_link?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          purpose?: string
          redeemed_at?: string | null
          revoked_at?: string | null
          short_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invite_redirects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_attendance: {
        Row: {
          joined_at: string
          last_seen_at: string
          room_id: string
          student_id: string
        }
        Insert: {
          joined_at?: string
          last_seen_at?: string
          room_id: string
          student_id: string
        }
        Update: {
          joined_at?: string
          last_seen_at?: string
          room_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_attendance_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_attendance_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_class_insights_student: {
        Row: {
          content: Json
          generated_at: string
          room_id: string
          status: string
        }
        Insert: {
          content: Json
          generated_at?: string
          room_id: string
          status?: string
        }
        Update: {
          content?: Json
          generated_at?: string
          room_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_class_insights_student_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_decks: {
        Row: {
          created_at: string
          current_slide: number
          deck_url: string | null
          extraction: Json | null
          id: string
          max_slide: number
          module_item_id: string | null
          page_count: number | null
          position: number
          room_id: string
          source_file_path: string | null
          title: string | null
        }
        Insert: {
          created_at?: string
          current_slide?: number
          deck_url?: string | null
          extraction?: Json | null
          id?: string
          max_slide?: number
          module_item_id?: string | null
          page_count?: number | null
          position: number
          room_id: string
          source_file_path?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string
          current_slide?: number
          deck_url?: string | null
          extraction?: Json | null
          id?: string
          max_slide?: number
          module_item_id?: string | null
          page_count?: number | null
          position?: number
          room_id?: string
          source_file_path?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lc_decks_module_item_id_fkey"
            columns: ["module_item_id"]
            isOneToOne: false
            referencedRelation: "module_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_decks_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_events: {
        Row: {
          created_at: string
          event_type: string
          payload: Json
          room_id: string
          seq: number
        }
        Insert: {
          created_at?: string
          event_type: string
          payload: Json
          room_id: string
          seq?: number
        }
        Update: {
          created_at?: string
          event_type?: string
          payload?: Json
          room_id?: string
          seq?: number
        }
        Relationships: [
          {
            foreignKeyName: "lc_events_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_interactions: {
        Row: {
          closed_at: string | null
          created_at: string
          created_by: string
          id: string
          kind: string
          last_aggregate_at: string | null
          opened_at: string | null
          payload: Json
          room_id: string
          status: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          created_by: string
          id?: string
          kind: string
          last_aggregate_at?: string | null
          opened_at?: string | null
          payload?: Json
          room_id: string
          status?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          created_by?: string
          id?: string
          kind?: string
          last_aggregate_at?: string | null
          opened_at?: string | null
          payload?: Json
          room_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_interactions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_interactions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_notes: {
        Row: {
          content: string
          created_at: string
          room_id: string
          student_id: string
          updated_at: string
        }
        Insert: {
          content?: string
          created_at?: string
          room_id: string
          student_id: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          room_id?: string
          student_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_notes_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_notes_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_recording_sessions: {
        Row: {
          chunk_count: number
          created_at: string
          duration_ms: number | null
          id: string
          path: string | null
          room_id: string
          started_at: string
        }
        Insert: {
          chunk_count?: number
          created_at?: string
          duration_ms?: number | null
          id?: string
          path?: string | null
          room_id: string
          started_at?: string
        }
        Update: {
          chunk_count?: number
          created_at?: string
          duration_ms?: number | null
          id?: string
          path?: string | null
          room_id?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_recording_sessions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_recordings: {
        Row: {
          created_at: string
          duration_ms: number | null
          ended_at: string | null
          generation_started_at: string | null
          room_id: string
          started_at: string
          status: string
          timeline: Json
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          ended_at?: string | null
          generation_started_at?: string | null
          room_id: string
          started_at?: string
          status?: string
          timeline?: Json
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          ended_at?: string | null
          generation_started_at?: string | null
          room_id?: string
          started_at?: string
          status?: string
          timeline?: Json
        }
        Relationships: [
          {
            foreignKeyName: "lc_recordings_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_responses: {
        Row: {
          id: string
          interaction_id: string
          response: Json
          student_id: string
          submitted_at: string
        }
        Insert: {
          id?: string
          interaction_id: string
          response: Json
          student_id: string
          submitted_at?: string
        }
        Update: {
          id?: string
          interaction_id?: string
          response?: Json
          student_id?: string
          submitted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_responses_interaction_id_fkey"
            columns: ["interaction_id"]
            isOneToOne: false
            referencedRelation: "lc_interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_responses_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_room_codes: {
        Row: {
          code: string
          created_at: string
          room_id: string
        }
        Insert: {
          code: string
          created_at?: string
          room_id: string
        }
        Update: {
          code?: string
          created_at?: string
          room_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_room_codes_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_rooms: {
        Row: {
          active_deck_id: string | null
          created_at: string
          current_slide: number
          deck_page_count: number | null
          deck_url: string | null
          ended_at: string | null
          id: string
          is_blanked: boolean
          lecture_summary: Json | null
          lecture_summary_enabled: boolean
          module_item_id: string | null
          name: string | null
          prof_id: string
          recurrence_group_id: string | null
          scheduled_at: string | null
          section_id: string
          setup_completed: boolean
          source_file_path: string | null
          started_at: string | null
          status: string
        }
        Insert: {
          active_deck_id?: string | null
          created_at?: string
          current_slide?: number
          deck_page_count?: number | null
          deck_url?: string | null
          ended_at?: string | null
          id?: string
          is_blanked?: boolean
          lecture_summary?: Json | null
          lecture_summary_enabled?: boolean
          module_item_id?: string | null
          name?: string | null
          prof_id: string
          recurrence_group_id?: string | null
          scheduled_at?: string | null
          section_id: string
          setup_completed?: boolean
          source_file_path?: string | null
          started_at?: string | null
          status?: string
        }
        Update: {
          active_deck_id?: string | null
          created_at?: string
          current_slide?: number
          deck_page_count?: number | null
          deck_url?: string | null
          ended_at?: string | null
          id?: string
          is_blanked?: boolean
          lecture_summary?: Json | null
          lecture_summary_enabled?: boolean
          module_item_id?: string | null
          name?: string | null
          prof_id?: string
          recurrence_group_id?: string | null
          scheduled_at?: string | null
          section_id?: string
          setup_completed?: boolean
          source_file_path?: string | null
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_rooms_active_deck_id_fkey"
            columns: ["active_deck_id"]
            isOneToOne: false
            referencedRelation: "lc_decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_rooms_module_item_id_fkey"
            columns: ["module_item_id"]
            isOneToOne: false
            referencedRelation: "module_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_rooms_prof_id_fkey"
            columns: ["prof_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_rooms_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_session_reports: {
        Row: {
          generated_at: string
          generation_started_at: string | null
          report: Json
          room_id: string
          status: string
        }
        Insert: {
          generated_at?: string
          generation_started_at?: string | null
          report: Json
          room_id: string
          status?: string
        }
        Update: {
          generated_at?: string
          generation_started_at?: string | null
          report?: Json
          room_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_session_reports_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_slide_annotations: {
        Row: {
          author_id: string
          created_at: string
          deck_id: string
          id: string
          room_id: string
          slide_index: number
          stroke: Json
        }
        Insert: {
          author_id: string
          created_at?: string
          deck_id: string
          id?: string
          room_id: string
          slide_index: number
          stroke: Json
        }
        Update: {
          author_id?: string
          created_at?: string
          deck_id?: string
          id?: string
          room_id?: string
          slide_index?: number
          stroke?: Json
        }
        Relationships: [
          {
            foreignKeyName: "lc_slide_annotations_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_slide_annotations_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "lc_decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_slide_annotations_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_transcript_insights: {
        Row: {
          generated_at: string
          insights: Json
          room_id: string
          status: string
        }
        Insert: {
          generated_at?: string
          insights: Json
          room_id: string
          status?: string
        }
        Update: {
          generated_at?: string
          insights?: Json
          room_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_transcript_insights_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      lc_transcriptions: {
        Row: {
          deck_id: string
          id: string
          page_number: number
          room_id: string
          text: string
          updated_at: string
        }
        Insert: {
          deck_id: string
          id?: string
          page_number: number
          room_id: string
          text?: string
          updated_at?: string
        }
        Update: {
          deck_id?: string
          id?: string
          page_number?: number
          room_id?: string
          text?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lc_transcriptions_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "lc_decks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lc_transcriptions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "lc_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      material_vector_chunks: {
        Row: {
          breadcrumb: string
          chunker_version: string
          content: string
          content_hash: string
          created_at: string
          embedding_dim: number
          embedding_model: string
          error: string | null
          id: string
          institution_id: string
          module_id: string
          module_item_id: string
          page_number: number
          section_id: string
          status: string
          updated_at: string
        }
        Insert: {
          breadcrumb?: string
          chunker_version: string
          content?: string
          content_hash: string
          created_at?: string
          embedding_dim: number
          embedding_model: string
          error?: string | null
          id?: string
          institution_id: string
          module_id: string
          module_item_id: string
          page_number: number
          section_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          breadcrumb?: string
          chunker_version?: string
          content?: string
          content_hash?: string
          created_at?: string
          embedding_dim?: number
          embedding_model?: string
          error?: string | null
          id?: string
          institution_id?: string
          module_id?: string
          module_item_id?: string
          page_number?: number
          section_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_vector_chunks_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_vector_chunks_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_vector_chunks_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_vector_chunks_module_item_id_fkey"
            columns: ["module_item_id"]
            isOneToOne: false
            referencedRelation: "module_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_vector_chunks_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      module_dividers: {
        Row: {
          created_at: string
          id: string
          institution_id: string
          position: number
          section_id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          institution_id: string
          position?: number
          section_id: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          institution_id?: string
          position?: number
          section_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "module_dividers_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "module_dividers_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "module_dividers_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      module_items: {
        Row: {
          content: Json
          created_at: string
          description: string
          id: string
          instructor_note: string
          is_visible: boolean
          item_type: string
          module_id: string
          node_check_pool_version: number
          node_check_state: string
          position: number
          title: string
          updated_at: string
        }
        Insert: {
          content?: Json
          created_at?: string
          description?: string
          id?: string
          instructor_note?: string
          is_visible?: boolean
          item_type: string
          module_id: string
          node_check_pool_version?: number
          node_check_state?: string
          position?: number
          title?: string
          updated_at?: string
        }
        Update: {
          content?: Json
          created_at?: string
          description?: string
          id?: string
          instructor_note?: string
          is_visible?: boolean
          item_type?: string
          module_id?: string
          node_check_pool_version?: number
          node_check_state?: string
          position?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "module_items_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
        ]
      }
      modules: {
        Row: {
          coverage_state: string
          created_at: string
          description: string
          id: string
          instructor_note: string
          is_published: boolean
          position: number
          section_id: string
          system_kind: string | null
          title: string
          unlock_date: string | null
          updated_at: string
          week_number: number | null
        }
        Insert: {
          coverage_state?: string
          created_at?: string
          description?: string
          id?: string
          instructor_note?: string
          is_published?: boolean
          position?: number
          section_id: string
          system_kind?: string | null
          title: string
          unlock_date?: string | null
          updated_at?: string
          week_number?: number | null
        }
        Update: {
          coverage_state?: string
          created_at?: string
          description?: string
          id?: string
          instructor_note?: string
          is_published?: boolean
          position?: number
          section_id?: string
          system_kind?: string | null
          title?: string
          unlock_date?: string | null
          updated_at?: string
          week_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "modules_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      node_check_attempts: {
        Row: {
          answers: Json
          created_at: string
          id: string
          institution_id: string
          module_item_id: string
          passed: boolean
          pool_version: number
          question_ids: string[]
          section_id: string
          student_id: string
          tries: number
          updated_at: string
        }
        Insert: {
          answers?: Json
          created_at?: string
          id?: string
          institution_id: string
          module_item_id: string
          passed?: boolean
          pool_version?: number
          question_ids: string[]
          section_id: string
          student_id: string
          tries?: number
          updated_at?: string
        }
        Update: {
          answers?: Json
          created_at?: string
          id?: string
          institution_id?: string
          module_item_id?: string
          passed?: boolean
          pool_version?: number
          question_ids?: string[]
          section_id?: string
          student_id?: string
          tries?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "node_check_attempts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_check_attempts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_check_attempts_module_item_id_fkey"
            columns: ["module_item_id"]
            isOneToOne: false
            referencedRelation: "module_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_check_attempts_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_check_attempts_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      node_check_questions: {
        Row: {
          answer_index: number
          choices: Json
          created_at: string
          id: string
          institution_id: string
          module_item_id: string
          pool_version: number
          prompt: string
          section_id: string
        }
        Insert: {
          answer_index: number
          choices: Json
          created_at?: string
          id?: string
          institution_id: string
          module_item_id: string
          pool_version?: number
          prompt: string
          section_id: string
        }
        Update: {
          answer_index?: number
          choices?: Json
          created_at?: string
          id?: string
          institution_id?: string
          module_item_id?: string
          pool_version?: number
          prompt?: string
          section_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "node_check_questions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_check_questions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_check_questions_module_item_id_fkey"
            columns: ["module_item_id"]
            isOneToOne: false
            referencedRelation: "module_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_check_questions_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      office_hours: {
        Row: {
          buffer_minutes: number
          course_code: string | null
          course_id: string | null
          course_name: string | null
          created_at: string
          day_of_week: string
          effective_from: string
          effective_until: string | null
          end_time: string
          id: string
          is_active: boolean
          location: string
          meeting_type: string
          professor_id: string
          slot_duration: number
          start_time: string
          title: string
          updated_at: string
          zoom_link: string
        }
        Insert: {
          buffer_minutes?: number
          course_code?: string | null
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          day_of_week: string
          effective_from: string
          effective_until?: string | null
          end_time: string
          id?: string
          is_active?: boolean
          location?: string
          meeting_type?: string
          professor_id: string
          slot_duration?: number
          start_time: string
          title: string
          updated_at?: string
          zoom_link?: string
        }
        Update: {
          buffer_minutes?: number
          course_code?: string | null
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          day_of_week?: string
          effective_from?: string
          effective_until?: string | null
          end_time?: string
          id?: string
          is_active?: boolean
          location?: string
          meeting_type?: string
          professor_id?: string
          slot_duration?: number
          start_time?: string
          title?: string
          updated_at?: string
          zoom_link?: string
        }
        Relationships: [
          {
            foreignKeyName: "office_hours_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "office_hours_professor_id_fkey"
            columns: ["professor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      outcome_alignment_map_cache: {
        Row: {
          created_at: string
          id: string
          input_hash: string
          institution_id: string
          last_used_at: string
          matches: Json
        }
        Insert: {
          created_at?: string
          id?: string
          input_hash: string
          institution_id: string
          last_used_at?: string
          matches: Json
        }
        Update: {
          created_at?: string
          id?: string
          input_hash?: string
          institution_id?: string
          last_used_at?: string
          matches?: Json
        }
        Relationships: [
          {
            foreignKeyName: "outcome_alignment_map_cache_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcome_alignment_map_cache_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_events: {
        Row: {
          all_day: boolean
          created_at: string
          date: string
          end_time: string | null
          id: string
          institution_id: string
          note: string | null
          recurrence: string
          recurrence_until: string | null
          start_time: string | null
          student_id: string
          title: string
          updated_at: string
        }
        Insert: {
          all_day?: boolean
          created_at?: string
          date: string
          end_time?: string | null
          id?: string
          institution_id: string
          note?: string | null
          recurrence?: string
          recurrence_until?: string | null
          start_time?: string | null
          student_id: string
          title: string
          updated_at?: string
        }
        Update: {
          all_day?: boolean
          created_at?: string
          date?: string
          end_time?: string | null
          id?: string
          institution_id?: string
          note?: string | null
          recurrence?: string
          recurrence_until?: string | null
          start_time?: string | null
          student_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "personal_events_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_events_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_events_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      phase_comments: {
        Row: {
          author_id: string
          content: string
          created_at: string
          id: string
          phase_id: string
        }
        Insert: {
          author_id: string
          content: string
          created_at?: string
          id?: string
          phase_id: string
        }
        Update: {
          author_id?: string
          content?: string
          created_at?: string
          id?: string
          phase_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "phase_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phase_comments_phase_id_fkey"
            columns: ["phase_id"]
            isOneToOne: false
            referencedRelation: "project_phases"
            referencedColumns: ["id"]
          },
        ]
      }
      phase_items: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string
          id: string
          is_completed: boolean
          phase_id: string
          position: number
          title: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by: string
          id?: string
          is_completed?: boolean
          phase_id: string
          position?: number
          title: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          id?: string
          is_completed?: boolean
          phase_id?: string
          position?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "phase_items_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phase_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phase_items_phase_id_fkey"
            columns: ["phase_id"]
            isOneToOne: false
            referencedRelation: "project_phases"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          id: boolean
          settings: Json
          updated_at: string
        }
        Insert: {
          id?: boolean
          settings?: Json
          updated_at?: string
        }
        Update: {
          id?: boolean
          settings?: Json
          updated_at?: string
        }
        Relationships: []
      }
      preclass_primers: {
        Row: {
          audio_path: string | null
          created_at: string
          duration_seconds: number | null
          generated_at: string
          institution_id: string
          is_available: boolean
          module_item_id: string
          script: string | null
          section_id: string
          source_hash: string | null
          status: string
        }
        Insert: {
          audio_path?: string | null
          created_at?: string
          duration_seconds?: number | null
          generated_at?: string
          institution_id: string
          is_available?: boolean
          module_item_id: string
          script?: string | null
          section_id: string
          source_hash?: string | null
          status?: string
        }
        Update: {
          audio_path?: string | null
          created_at?: string
          duration_seconds?: number | null
          generated_at?: string
          institution_id?: string
          is_available?: boolean
          module_item_id?: string
          script?: string | null
          section_id?: string
          source_hash?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "preclass_primers_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preclass_primers_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preclass_primers_module_item_id_fkey"
            columns: ["module_item_id"]
            isOneToOne: true
            referencedRelation: "module_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preclass_primers_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      proctoring_snapshots: {
        Row: {
          attempt_id: string
          created_at: string | null
          face_count: number | null
          id: string
          question_index: number | null
          quiz_id: string
          section_id: string
          snapshot_url: string
          storage_path: string
          student_id: string
          timestamp_offset: number
          violation_type: string
        }
        Insert: {
          attempt_id: string
          created_at?: string | null
          face_count?: number | null
          id?: string
          question_index?: number | null
          quiz_id: string
          section_id: string
          snapshot_url: string
          storage_path: string
          student_id: string
          timestamp_offset: number
          violation_type: string
        }
        Update: {
          attempt_id?: string
          created_at?: string | null
          face_count?: number | null
          id?: string
          question_index?: number | null
          quiz_id?: string
          section_id?: string
          snapshot_url?: string
          storage_path?: string
          student_id?: string
          timestamp_offset?: number
          violation_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "proctoring_snapshots_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "quiz_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proctoring_snapshots_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proctoring_snapshots_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proctoring_snapshots_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          cwid: string | null
          email: string
          first_name: string | null
          id: string
          institution_id: string | null
          invite_accepted_at: string | null
          invite_status: string | null
          invited_at: string | null
          invited_by: string | null
          is_platform_owner: boolean
          last_active_at: string | null
          last_login_at: string | null
          last_name: string | null
          name: string | null
          onboarding_completed: boolean | null
          phone: string | null
          role: string
          settings: Json | null
          status: string | null
          university_email: string | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          cwid?: string | null
          email: string
          first_name?: string | null
          id: string
          institution_id?: string | null
          invite_accepted_at?: string | null
          invite_status?: string | null
          invited_at?: string | null
          invited_by?: string | null
          is_platform_owner?: boolean
          last_active_at?: string | null
          last_login_at?: string | null
          last_name?: string | null
          name?: string | null
          onboarding_completed?: boolean | null
          phone?: string | null
          role: string
          settings?: Json | null
          status?: string | null
          university_email?: string | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          cwid?: string | null
          email?: string
          first_name?: string | null
          id?: string
          institution_id?: string | null
          invite_accepted_at?: string | null
          invite_status?: string | null
          invited_at?: string | null
          invited_by?: string | null
          is_platform_owner?: boolean
          last_active_at?: string | null
          last_login_at?: string | null
          last_name?: string | null
          name?: string | null
          onboarding_completed?: boolean | null
          phone?: string | null
          role?: string
          settings?: Json | null
          status?: string | null
          university_email?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      programs: {
        Row: {
          code: string
          created_at: string | null
          degree_type: string | null
          department_id: string | null
          description: string | null
          director_id: string | null
          duration_semesters: number | null
          id: string
          institution_id: string
          name: string
          status: string | null
          total_credits: number | null
          updated_at: string | null
        }
        Insert: {
          code: string
          created_at?: string | null
          degree_type?: string | null
          department_id?: string | null
          description?: string | null
          director_id?: string | null
          duration_semesters?: number | null
          id?: string
          institution_id: string
          name: string
          status?: string | null
          total_credits?: number | null
          updated_at?: string | null
        }
        Update: {
          code?: string
          created_at?: string | null
          degree_type?: string | null
          department_id?: string | null
          description?: string | null
          director_id?: string | null
          duration_semesters?: number | null
          id?: string
          institution_id?: string
          name?: string
          status?: string | null
          total_credits?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "programs_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_director_id_fkey"
            columns: ["director_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
        ]
      }
      project_chat_channels: {
        Row: {
          created_at: string
          created_by: string
          id: string
          is_default: boolean
          name: string
          position: number
          team_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          is_default?: boolean
          name: string
          position?: number
          team_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          is_default?: boolean
          name?: string
          position?: number
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_chat_channels_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_chat_channels_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      project_chat_message_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_chat_message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "project_chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_chat_message_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_chat_messages: {
        Row: {
          attachment_name: string | null
          attachment_path: string | null
          attachment_size: number | null
          attachment_type: string | null
          attachment_url: string | null
          author_id: string | null
          channel_id: string
          content: string
          created_at: string
          deleted_at: string | null
          deleted_by_id: string | null
          id: string
          kind: string
          mentioned_doc_ids: string[]
          mentioned_phase_ids: string[]
          mentioned_user_ids: string[]
          system_event: string | null
          system_payload: Json | null
        }
        Insert: {
          attachment_name?: string | null
          attachment_path?: string | null
          attachment_size?: number | null
          attachment_type?: string | null
          attachment_url?: string | null
          author_id?: string | null
          channel_id: string
          content?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_id?: string | null
          id?: string
          kind?: string
          mentioned_doc_ids?: string[]
          mentioned_phase_ids?: string[]
          mentioned_user_ids?: string[]
          system_event?: string | null
          system_payload?: Json | null
        }
        Update: {
          attachment_name?: string | null
          attachment_path?: string | null
          attachment_size?: number | null
          attachment_type?: string | null
          attachment_url?: string | null
          author_id?: string | null
          channel_id?: string
          content?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by_id?: string | null
          id?: string
          kind?: string
          mentioned_doc_ids?: string[]
          mentioned_phase_ids?: string[]
          mentioned_user_ids?: string[]
          system_event?: string | null
          system_payload?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "project_chat_messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_chat_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "project_chat_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_chat_messages_deleted_by_id_fkey"
            columns: ["deleted_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_commits: {
        Row: {
          additions: number | null
          author_github_username: string | null
          author_user_id: string | null
          commit_sha: string
          committed_at: string
          created_at: string
          deletions: number | null
          files_changed: number | null
          id: string
          message: string
          project_id: string
          repository_id: string
        }
        Insert: {
          additions?: number | null
          author_github_username?: string | null
          author_user_id?: string | null
          commit_sha: string
          committed_at: string
          created_at?: string
          deletions?: number | null
          files_changed?: number | null
          id?: string
          message: string
          project_id: string
          repository_id: string
        }
        Update: {
          additions?: number | null
          author_github_username?: string | null
          author_user_id?: string | null
          commit_sha?: string
          committed_at?: string
          created_at?: string
          deletions?: number | null
          files_changed?: number | null
          id?: string
          message?: string
          project_id?: string
          repository_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_commits_author_user_id_fkey"
            columns: ["author_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_commits_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_commits_repository_id_fkey"
            columns: ["repository_id"]
            isOneToOne: false
            referencedRelation: "project_repositories"
            referencedColumns: ["id"]
          },
        ]
      }
      project_docs: {
        Row: {
          content: Json
          created_at: string
          created_by: string
          id: string
          is_pinned: boolean
          position: number
          team_id: string
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content?: Json
          created_at?: string
          created_by: string
          id?: string
          is_pinned?: boolean
          position?: number
          team_id: string
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content?: Json
          created_at?: string
          created_by?: string
          id?: string
          is_pinned?: boolean
          position?: number
          team_id?: string
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_docs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_docs_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_docs_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_grade_releases: {
        Row: {
          institution_id: string
          project_id: string
          released_at: string
          released_by: string | null
        }
        Insert: {
          institution_id: string
          project_id: string
          released_at?: string
          released_by?: string | null
        }
        Update: {
          institution_id?: string
          project_id?: string
          released_at?: string
          released_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_grade_releases_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_grade_releases_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_grade_releases_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_grade_releases_released_by_fkey"
            columns: ["released_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_grades: {
        Row: {
          created_at: string | null
          feedback: string
          graded_at: string | null
          graded_by: string
          id: string
          project_id: string
          score: number
          team_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          feedback?: string
          graded_at?: string | null
          graded_by: string
          id?: string
          project_id: string
          score: number
          team_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          feedback?: string
          graded_at?: string | null
          graded_by?: string
          id?: string
          project_id?: string
          score?: number
          team_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_grades_graded_by_fkey"
            columns: ["graded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_grades_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_grades_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: true
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      project_item_scores: {
        Row: {
          created_at: string
          earned: number | null
          graded_at: string
          graded_by: string | null
          id: string
          institution_id: string
          level_id: string | null
          phase_item_id: string
          project_id: string
          student_id: string | null
          team_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          earned?: number | null
          graded_at?: string
          graded_by?: string | null
          id?: string
          institution_id: string
          level_id?: string | null
          phase_item_id: string
          project_id: string
          student_id?: string | null
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          earned?: number | null
          graded_at?: string
          graded_by?: string | null
          id?: string
          institution_id?: string
          level_id?: string | null
          phase_item_id?: string
          project_id?: string
          student_id?: string | null
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_item_scores_graded_by_fkey"
            columns: ["graded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_item_scores_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_item_scores_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_item_scores_phase_item_id_fkey"
            columns: ["phase_item_id"]
            isOneToOne: false
            referencedRelation: "project_phase_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_item_scores_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_item_scores_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_item_scores_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      project_master_phases: {
        Row: {
          created_at: string
          end_date: string | null
          id: string
          institution_id: string
          name: string
          position: number
          project_id: string
          start_date: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          end_date?: string | null
          id?: string
          institution_id: string
          name: string
          position?: number
          project_id: string
          start_date?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          end_date?: string | null
          id?: string
          institution_id?: string
          name?: string
          position?: number
          project_id?: string
          start_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_master_phases_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_master_phases_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_master_phases_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          contribution_summary: string | null
          created_at: string
          id: string
          joined_at: string
          project_id: string
          role: string
          team_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          contribution_summary?: string | null
          created_at?: string
          id?: string
          joined_at?: string
          project_id: string
          role?: string
          team_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          contribution_summary?: string | null
          created_at?: string
          id?: string
          joined_at?: string
          project_id?: string
          role?: string
          team_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_phase_items: {
        Row: {
          assignment_id: string | null
          created_at: string
          grain: string
          id: string
          institution_id: string
          item_type: string
          levels: Json
          manual_max: number | null
          manual_title: string | null
          phase_id: string
          position: number
          project_id: string
          quiz_id: string | null
          scoring_mode: string
          weight: number
        }
        Insert: {
          assignment_id?: string | null
          created_at?: string
          grain?: string
          id?: string
          institution_id: string
          item_type: string
          levels?: Json
          manual_max?: number | null
          manual_title?: string | null
          phase_id: string
          position?: number
          project_id: string
          quiz_id?: string | null
          scoring_mode?: string
          weight?: number
        }
        Update: {
          assignment_id?: string | null
          created_at?: string
          grain?: string
          id?: string
          institution_id?: string
          item_type?: string
          levels?: Json
          manual_max?: number | null
          manual_title?: string | null
          phase_id?: string
          position?: number
          project_id?: string
          quiz_id?: string | null
          scoring_mode?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_phase_items_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_phase_items_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_phase_items_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_phase_items_phase_id_fkey"
            columns: ["phase_id"]
            isOneToOne: false
            referencedRelation: "project_master_phases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_phase_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_phase_items_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      project_phases: {
        Row: {
          assigned_to: Json
          assignment_id: string | null
          completed_at: string | null
          created_at: string
          description: string
          due_date: string | null
          id: string
          position: number
          project_id: string
          start_date: string | null
          status: string
          team_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: Json
          assignment_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string
          due_date?: string | null
          id?: string
          position?: number
          project_id: string
          start_date?: string | null
          status?: string
          team_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: Json
          assignment_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string
          due_date?: string | null
          id?: string
          position?: number
          project_id?: string
          start_date?: string | null
          status?: string
          team_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_phases_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_phases_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_phases_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      project_repositories: {
        Row: {
          created_at: string
          default_branch: string
          github_repo_id: number
          id: string
          is_primary: boolean
          last_synced_at: string | null
          project_id: string
          repo_full_name: string
          repo_url: string
          updated_at: string
          webhook_secret: string | null
        }
        Insert: {
          created_at?: string
          default_branch?: string
          github_repo_id: number
          id?: string
          is_primary?: boolean
          last_synced_at?: string | null
          project_id: string
          repo_full_name: string
          repo_url: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Update: {
          created_at?: string
          default_branch?: string
          github_repo_id?: number
          id?: string
          is_primary?: boolean
          last_synced_at?: string | null
          project_id?: string
          repo_full_name?: string
          repo_url?: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_repositories_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_showcase: {
        Row: {
          created_at: string
          external_url: string | null
          id: string
          is_featured: boolean
          project_id: string
          published_at: string
          published_by: string
          tagline: string
          team_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_url?: string | null
          id?: string
          is_featured?: boolean
          project_id: string
          published_at?: string
          published_by: string
          tagline?: string
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_url?: string | null
          id?: string
          is_featured?: boolean
          project_id?: string
          published_at?: string
          published_by?: string
          tagline?: string
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_showcase_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_showcase_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_showcase_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      project_teams: {
        Row: {
          created_at: string | null
          created_by: string
          description: string
          id: string
          name: string
          planning_doc: string
          project_id: string
          status: string
          submission: Json | null
          updated_at: string | null
          workspace_enabled: boolean
        }
        Insert: {
          created_at?: string | null
          created_by: string
          description?: string
          id?: string
          name: string
          planning_doc?: string
          project_id: string
          status?: string
          submission?: Json | null
          updated_at?: string | null
          workspace_enabled?: boolean
        }
        Update: {
          created_at?: string | null
          created_by?: string
          description?: string
          id?: string
          name?: string
          planning_doc?: string
          project_id?: string
          status?: string
          submission?: Json | null
          updated_at?: string | null
          workspace_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "project_teams_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_teams_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_videos: {
        Row: {
          created_at: string
          description: string
          file_size: number | null
          id: string
          is_primary: boolean
          project_id: string
          team_id: string | null
          title: string
          updated_at: string
          uploaded_by: string
          video_path: string
          video_url: string
        }
        Insert: {
          created_at?: string
          description?: string
          file_size?: number | null
          id?: string
          is_primary?: boolean
          project_id: string
          team_id?: string | null
          title?: string
          updated_at?: string
          uploaded_by: string
          video_path: string
          video_url: string
        }
        Update: {
          created_at?: string
          description?: string
          file_size?: number | null
          id?: string
          is_primary?: boolean
          project_id?: string
          team_id?: string | null
          title?: string
          updated_at?: string
          uploaded_by?: string
          video_path?: string
          video_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_videos_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_videos_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_videos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          allow_team_workspace: boolean
          created_at: string
          created_by: string
          description: string
          due_date: string | null
          guidelines: string
          id: string
          max_team_size: number
          section_id: string
          settings: Json
          showcase_description: string | null
          showcase_enabled: boolean
          status: string
          tags: Json
          thumbnail_url: string | null
          title: string
          updated_at: string
          visibility: string
        }
        Insert: {
          allow_team_workspace?: boolean
          created_at?: string
          created_by: string
          description?: string
          due_date?: string | null
          guidelines?: string
          id?: string
          max_team_size?: number
          section_id: string
          settings?: Json
          showcase_description?: string | null
          showcase_enabled?: boolean
          status?: string
          tags?: Json
          thumbnail_url?: string | null
          title: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          allow_team_workspace?: boolean
          created_at?: string
          created_by?: string
          description?: string
          due_date?: string | null
          guidelines?: string
          id?: string
          max_team_size?: number
          section_id?: string
          settings?: Json
          showcase_description?: string | null
          showcase_enabled?: boolean
          status?: string
          tags?: Json
          thumbnail_url?: string | null
          title?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_bill_snapshots: {
        Row: {
          amount_usd: number
          as_of: string
          id: string
          metadata: Json
          month: string
          provider: string
          source: string
        }
        Insert: {
          amount_usd?: number
          as_of?: string
          id?: string
          metadata?: Json
          month: string
          provider: string
          source: string
        }
        Update: {
          amount_usd?: number
          as_of?: string
          id?: string
          metadata?: Json
          month?: string
          provider?: string
          source?: string
        }
        Relationships: []
      }
      quiz_answers: {
        Row: {
          attempt_id: string
          blank_answers: Json | null
          boolean_answer: boolean | null
          confidence: string | null
          copy_attempts: number | null
          earned_points: number | null
          grader_mode: string | null
          id: string
          is_correct: boolean | null
          is_flagged: boolean | null
          is_formative: boolean | null
          misconception_node: string | null
          nodes: Json | null
          option_changes: number | null
          override_points: number | null
          override_reason: string | null
          question_id: string
          rationale: string | null
          se_after: number | null
          selected_choice_ids: string[] | null
          soft_score: number | null
          tab_switches: number | null
          text_answer: string | null
          theta_after: number | null
          theta_before: number | null
          time_spent_seconds: number | null
        }
        Insert: {
          attempt_id: string
          blank_answers?: Json | null
          boolean_answer?: boolean | null
          confidence?: string | null
          copy_attempts?: number | null
          earned_points?: number | null
          grader_mode?: string | null
          id?: string
          is_correct?: boolean | null
          is_flagged?: boolean | null
          is_formative?: boolean | null
          misconception_node?: string | null
          nodes?: Json | null
          option_changes?: number | null
          override_points?: number | null
          override_reason?: string | null
          question_id: string
          rationale?: string | null
          se_after?: number | null
          selected_choice_ids?: string[] | null
          soft_score?: number | null
          tab_switches?: number | null
          text_answer?: string | null
          theta_after?: number | null
          theta_before?: number | null
          time_spent_seconds?: number | null
        }
        Update: {
          attempt_id?: string
          blank_answers?: Json | null
          boolean_answer?: boolean | null
          confidence?: string | null
          copy_attempts?: number | null
          earned_points?: number | null
          grader_mode?: string | null
          id?: string
          is_correct?: boolean | null
          is_flagged?: boolean | null
          is_formative?: boolean | null
          misconception_node?: string | null
          nodes?: Json | null
          option_changes?: number | null
          override_points?: number | null
          override_reason?: string | null
          question_id?: string
          rationale?: string | null
          se_after?: number | null
          selected_choice_ids?: string[] | null
          soft_score?: number | null
          tab_switches?: number | null
          text_answer?: string | null
          theta_after?: number | null
          theta_before?: number | null
          time_spent_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_answers_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "quiz_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "quiz_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_attempts: {
        Row: {
          adaptive_question_index: number | null
          cohort: string | null
          current_rating: number | null
          earned_points: number | null
          final_rating: number | null
          id: string
          is_late: boolean
          late_by_seconds: number
          mode: string | null
          overtime_seconds: number
          proctoring_summary: Json | null
          quiz_id: string
          resolved_question_ids: string[] | null
          score: number | null
          se: number | null
          section_id: string
          start_rating: number | null
          started_at: string | null
          status: string | null
          stop_reason: string | null
          student_id: string
          submitted_at: string | null
          theta: number | null
          time_limit_exceeded: boolean
          time_spent_seconds: number | null
          total_points: number | null
          walkthrough_transcripts: Json
        }
        Insert: {
          adaptive_question_index?: number | null
          cohort?: string | null
          current_rating?: number | null
          earned_points?: number | null
          final_rating?: number | null
          id?: string
          is_late?: boolean
          late_by_seconds?: number
          mode?: string | null
          overtime_seconds?: number
          proctoring_summary?: Json | null
          quiz_id: string
          resolved_question_ids?: string[] | null
          score?: number | null
          se?: number | null
          section_id: string
          start_rating?: number | null
          started_at?: string | null
          status?: string | null
          stop_reason?: string | null
          student_id: string
          submitted_at?: string | null
          theta?: number | null
          time_limit_exceeded?: boolean
          time_spent_seconds?: number | null
          total_points?: number | null
          walkthrough_transcripts?: Json
        }
        Update: {
          adaptive_question_index?: number | null
          cohort?: string | null
          current_rating?: number | null
          earned_points?: number | null
          final_rating?: number | null
          id?: string
          is_late?: boolean
          late_by_seconds?: number
          mode?: string | null
          overtime_seconds?: number
          proctoring_summary?: Json | null
          quiz_id?: string
          resolved_question_ids?: string[] | null
          score?: number | null
          se?: number | null
          section_id?: string
          start_rating?: number | null
          started_at?: string | null
          status?: string | null
          stop_reason?: string | null
          student_id?: string
          submitted_at?: string | null
          theta?: number | null
          time_limit_exceeded?: boolean
          time_spent_seconds?: number | null
          total_points?: number | null
          walkthrough_transcripts?: Json
        }
        Relationships: [
          {
            foreignKeyName: "quiz_attempts_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_attempts_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_attempts_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_item_stats: {
        Row: {
          computed_at: string
          difficulty: number | null
          discrimination: number | null
          n_attempts: number
          question_id: string
          quiz_id: string
          section_id: string
        }
        Insert: {
          computed_at?: string
          difficulty?: number | null
          discrimination?: number | null
          n_attempts?: number
          question_id: string
          quiz_id: string
          section_id: string
        }
        Update: {
          computed_at?: string
          difficulty?: number | null
          discrimination?: number | null
          n_attempts?: number
          question_id?: string
          quiz_id?: string
          section_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_item_stats_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "quiz_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_item_stats_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_item_stats_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_proctoring_logs: {
        Row: {
          attempt_id: string
          batch_index: number
          created_at: string | null
          events: Json
          id: string
          keystroke_count: number
          quiz_id: string
          section_id: string
          student_id: string
        }
        Insert: {
          attempt_id: string
          batch_index?: number
          created_at?: string | null
          events?: Json
          id?: string
          keystroke_count?: number
          quiz_id: string
          section_id: string
          student_id: string
        }
        Update: {
          attempt_id?: string
          batch_index?: number
          created_at?: string | null
          events?: Json
          id?: string
          keystroke_count?: number
          quiz_id?: string
          section_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_proctoring_logs_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "quiz_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_proctoring_logs_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_proctoring_logs_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_proctoring_logs_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_question_assignments: {
        Row: {
          id: string
          position: number
          question_id: string
          quiz_id: string
        }
        Insert: {
          id?: string
          position?: number
          question_id: string
          quiz_id: string
        }
        Update: {
          id?: string
          position?: number
          question_id?: string
          quiz_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_question_assignments_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "quiz_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_question_assignments_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_questions: {
        Row: {
          blooms_level: string | null
          calibrated_at: string | null
          code_snippet: Json | null
          content: Json
          created_at: string | null
          difficulty: string
          elo_rating: number | null
          expected_time_seconds: number | null
          explanation: string | null
          id: string
          image_path: string | null
          image_url: string | null
          irt_a: number | null
          irt_b: number | null
          irt_c: number | null
          is_bonus: boolean | null
          is_complete: boolean
          is_extra_credit: boolean | null
          points: number
          question_text: string
          question_type: string
          rubric: Json | null
          section_id: string
          source_citation: Json | null
          tags: string[] | null
          updated_at: string | null
        }
        Insert: {
          blooms_level?: string | null
          calibrated_at?: string | null
          code_snippet?: Json | null
          content: Json
          created_at?: string | null
          difficulty?: string
          elo_rating?: number | null
          expected_time_seconds?: number | null
          explanation?: string | null
          id?: string
          image_path?: string | null
          image_url?: string | null
          irt_a?: number | null
          irt_b?: number | null
          irt_c?: number | null
          is_bonus?: boolean | null
          is_complete?: boolean
          is_extra_credit?: boolean | null
          points?: number
          question_text: string
          question_type: string
          rubric?: Json | null
          section_id: string
          source_citation?: Json | null
          tags?: string[] | null
          updated_at?: string | null
        }
        Update: {
          blooms_level?: string | null
          calibrated_at?: string | null
          code_snippet?: Json | null
          content?: Json
          created_at?: string | null
          difficulty?: string
          elo_rating?: number | null
          expected_time_seconds?: number | null
          explanation?: string | null
          id?: string
          image_path?: string | null
          image_url?: string | null
          irt_a?: number | null
          irt_b?: number | null
          irt_c?: number | null
          is_bonus?: boolean | null
          is_complete?: boolean
          is_extra_credit?: boolean | null
          points?: number
          question_text?: string
          question_type?: string
          rubric?: Json | null
          section_id?: string
          source_citation?: Json | null
          tags?: string[] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_questions_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      quizzes: {
        Row: {
          adaptive_mode: boolean | null
          adaptive_question_count: number | null
          adaptive_ratio: number | null
          allow_calculator: boolean | null
          allow_formula_sheet: boolean | null
          control_distribution: Json | null
          created_at: string | null
          created_by: string
          description: string | null
          difficulty_distribution: Json | null
          due_date: string | null
          formula_sheet_path: string | null
          formula_sheet_url: string | null
          generation_notice: Json | null
          generation_started_at: string | null
          generation_total: number | null
          id: string
          max_attempts: number | null
          negative_marking: boolean | null
          negative_marking_penalty: number | null
          pass_threshold: number | null
          proctoring_enabled: boolean | null
          publish_notified_at: string | null
          question_pools: Json | null
          scheduled_publish_at: string | null
          section_id: string
          select_lambda: number | null
          show_explanations: string | null
          show_leaderboard: boolean | null
          show_rating_to_students: boolean | null
          shuffle_answers: boolean | null
          shuffle_questions: boolean | null
          status: string
          stop_mode: string | null
          target_se: number | null
          time_limit_minutes: number | null
          title: string
          updated_at: string | null
          video_proctoring_enabled: boolean | null
        }
        Insert: {
          adaptive_mode?: boolean | null
          adaptive_question_count?: number | null
          adaptive_ratio?: number | null
          allow_calculator?: boolean | null
          allow_formula_sheet?: boolean | null
          control_distribution?: Json | null
          created_at?: string | null
          created_by: string
          description?: string | null
          difficulty_distribution?: Json | null
          due_date?: string | null
          formula_sheet_path?: string | null
          formula_sheet_url?: string | null
          generation_notice?: Json | null
          generation_started_at?: string | null
          generation_total?: number | null
          id?: string
          max_attempts?: number | null
          negative_marking?: boolean | null
          negative_marking_penalty?: number | null
          pass_threshold?: number | null
          proctoring_enabled?: boolean | null
          publish_notified_at?: string | null
          question_pools?: Json | null
          scheduled_publish_at?: string | null
          section_id: string
          select_lambda?: number | null
          show_explanations?: string | null
          show_leaderboard?: boolean | null
          show_rating_to_students?: boolean | null
          shuffle_answers?: boolean | null
          shuffle_questions?: boolean | null
          status?: string
          stop_mode?: string | null
          target_se?: number | null
          time_limit_minutes?: number | null
          title: string
          updated_at?: string | null
          video_proctoring_enabled?: boolean | null
        }
        Update: {
          adaptive_mode?: boolean | null
          adaptive_question_count?: number | null
          adaptive_ratio?: number | null
          allow_calculator?: boolean | null
          allow_formula_sheet?: boolean | null
          control_distribution?: Json | null
          created_at?: string | null
          created_by?: string
          description?: string | null
          difficulty_distribution?: Json | null
          due_date?: string | null
          formula_sheet_path?: string | null
          formula_sheet_url?: string | null
          generation_notice?: Json | null
          generation_started_at?: string | null
          generation_total?: number | null
          id?: string
          max_attempts?: number | null
          negative_marking?: boolean | null
          negative_marking_penalty?: number | null
          pass_threshold?: number | null
          proctoring_enabled?: boolean | null
          publish_notified_at?: string | null
          question_pools?: Json | null
          scheduled_publish_at?: string | null
          section_id?: string
          select_lambda?: number | null
          show_explanations?: string | null
          show_leaderboard?: boolean | null
          show_rating_to_students?: boolean | null
          shuffle_answers?: boolean | null
          shuffle_questions?: boolean | null
          status?: string
          stop_mode?: string | null
          target_se?: number | null
          time_limit_minutes?: number | null
          title?: string
          updated_at?: string | null
          video_proctoring_enabled?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "quizzes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quizzes_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      reengagement_logs: {
        Row: {
          id: string
          recipient_id: string
          sent_at: string
          tier: number
        }
        Insert: {
          id?: string
          recipient_id: string
          sent_at?: string
          tier: number
        }
        Update: {
          id?: string
          recipient_id?: string
          sent_at?: string
          tier?: number
        }
        Relationships: [
          {
            foreignKeyName: "reengagement_logs_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      roadmap_edges: {
        Row: {
          created_at: string
          edge_type: string
          from_node_id: string
          from_node_type: string
          id: string
          position: number | null
          section_id: string
          to_node_id: string
          to_node_type: string
        }
        Insert: {
          created_at?: string
          edge_type?: string
          from_node_id: string
          from_node_type: string
          id?: string
          position?: number | null
          section_id: string
          to_node_id: string
          to_node_type: string
        }
        Update: {
          created_at?: string
          edge_type?: string
          from_node_id?: string
          from_node_type?: string
          id?: string
          position?: number | null
          section_id?: string
          to_node_id?: string
          to_node_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "roadmap_edges_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      roadmap_progress: {
        Row: {
          created_at: string
          id: string
          progress: Json
          section_id: string
          student_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          progress?: Json
          section_id: string
          student_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          progress?: Json
          section_id?: string
          student_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "roadmap_progress_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roadmap_progress_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_templates: {
        Row: {
          created_at: string
          id: string
          institution_id: string
          template_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          institution_id: string
          template_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          institution_id?: string
          template_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_templates_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_templates_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_templates_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      section_staff: {
        Row: {
          approved_by: string | null
          created_at: string
          ends_at: string
          id: string
          role: string
          section_id: string
          staff_id: string
          starts_at: string
          status: string
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          created_at?: string
          ends_at: string
          id?: string
          role: string
          section_id: string
          staff_id: string
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          created_at?: string
          ends_at?: string
          id?: string
          role?: string
          section_id?: string
          staff_id?: string
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "section_staff_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      section_staff_requests: {
        Row: {
          candidate_email: string
          candidate_first_name: string
          candidate_last_name: string
          created_at: string
          ends_at: string
          id: string
          message: string | null
          requested_by: string
          requested_role: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          section_id: string
          section_staff_id: string | null
          starts_at: string
          status: string
          updated_at: string
        }
        Insert: {
          candidate_email: string
          candidate_first_name: string
          candidate_last_name: string
          created_at?: string
          ends_at: string
          id?: string
          message?: string | null
          requested_by: string
          requested_role: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          section_id: string
          section_staff_id?: string | null
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          candidate_email?: string
          candidate_first_name?: string
          candidate_last_name?: string
          created_at?: string
          ends_at?: string
          id?: string
          message?: string | null
          requested_by?: string
          requested_role?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          section_id?: string
          section_staff_id?: string | null
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "section_staff_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_requests_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_requests_section_staff_id_fkey"
            columns: ["section_staff_id"]
            isOneToOne: false
            referencedRelation: "section_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_requests_section_staff_id_fkey"
            columns: ["section_staff_id"]
            isOneToOne: false
            referencedRelation: "section_staff_with_institution"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_mastery: {
        Row: {
          id: string
          institution_id: string
          score: number | null
          section_id: string
          skill_id: string
          state: Json
          student_id: string
          updated_at: string
        }
        Insert: {
          id?: string
          institution_id: string
          score?: number | null
          section_id: string
          skill_id: string
          state?: Json
          student_id: string
          updated_at?: string
        }
        Update: {
          id?: string
          institution_id?: string
          score?: number | null
          section_id?: string
          skill_id?: string
          state?: Json
          student_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "skill_mastery_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_mastery_snapshots: {
        Row: {
          captured_on: string
          estimate: number | null
          institution_id: string
          score: number | null
          section_id: string
          skill_id: string
          student_id: string
        }
        Insert: {
          captured_on?: string
          estimate?: number | null
          institution_id: string
          score?: number | null
          section_id: string
          skill_id: string
          student_id: string
        }
        Update: {
          captured_on?: string
          estimate?: number | null
          institution_id?: string
          score?: number | null
          section_id?: string
          skill_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "skill_mastery_snapshots_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_snapshots_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_snapshots_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_snapshots_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_mastery_snapshots_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      skills: {
        Row: {
          created_at: string
          excluded: boolean
          id: string
          info: string | null
          institution_id: string
          library_skill_id: string | null
          name: string
          parent_id: string | null
          placement_pinned: boolean
          position: number
          section_id: string
          source: string
          suppressed: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          excluded?: boolean
          id?: string
          info?: string | null
          institution_id: string
          library_skill_id?: string | null
          name: string
          parent_id?: string | null
          placement_pinned?: boolean
          position?: number
          section_id: string
          source?: string
          suppressed?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          excluded?: boolean
          id?: string
          info?: string | null
          institution_id?: string
          library_skill_id?: string | null
          name?: string
          parent_id?: string | null
          placement_pinned?: boolean
          position?: number
          section_id?: string
          source?: string
          suppressed?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "skills_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skills_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skills_library_skill_id_fkey"
            columns: ["library_skill_id"]
            isOneToOne: false
            referencedRelation: "course_skills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skills_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skills_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      student_ability: {
        Row: {
          attempts: number
          id: string
          se: number
          section_id: string
          student_id: string
          theta: number
          updated_at: string | null
        }
        Insert: {
          attempts?: number
          id?: string
          se?: number
          section_id: string
          student_id: string
          theta?: number
          updated_at?: string | null
        }
        Update: {
          attempts?: number
          id?: string
          se?: number
          section_id?: string
          student_id?: string
          theta?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "student_ability_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_ability_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      student_certificates: {
        Row: {
          certificate_id: string
          description: string
          id: string
          institution_id: string
          issued_at: string
          public_id: string
          revoked_at: string | null
          section_id: string
          seen_at: string | null
          skills_snapshot: Json
          student_id: string
          title: string
        }
        Insert: {
          certificate_id: string
          description?: string
          id?: string
          institution_id: string
          issued_at?: string
          public_id: string
          revoked_at?: string | null
          section_id: string
          seen_at?: string | null
          skills_snapshot?: Json
          student_id: string
          title: string
        }
        Update: {
          certificate_id?: string
          description?: string
          id?: string
          institution_id?: string
          issued_at?: string
          public_id?: string
          revoked_at?: string | null
          section_id?: string
          seen_at?: string | null
          skills_snapshot?: Json
          student_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_certificates_certificate_id_fkey"
            columns: ["certificate_id"]
            isOneToOne: false
            referencedRelation: "certificates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_certificates_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_certificates_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_certificates_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_certificates_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      student_insight_summaries: {
        Row: {
          facts: Json
          generated_at: string
          id: string
          institution_id: string
          model: string
          section_id: string
          signal_hash: string
          student_id: string
          summary: string
        }
        Insert: {
          facts: Json
          generated_at?: string
          id?: string
          institution_id: string
          model: string
          section_id: string
          signal_hash: string
          student_id: string
          summary: string
        }
        Update: {
          facts?: Json
          generated_at?: string
          id?: string
          institution_id?: string
          model?: string
          section_id?: string
          signal_hash?: string
          student_id?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_insight_summaries_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_insight_summaries_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_insight_summaries_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_insight_summaries_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      student_ratings: {
        Row: {
          id: string
          quizzes_taken: number
          rating: number
          section_id: string
          student_id: string
          updated_at: string | null
        }
        Insert: {
          id?: string
          quizzes_taken?: number
          rating?: number
          section_id: string
          student_id: string
          updated_at?: string | null
        }
        Update: {
          id?: string
          quizzes_taken?: number
          rating?: number
          section_id?: string
          student_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "student_ratings_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_ratings_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_summary_logs: {
        Row: {
          created_at: string
          id: string
          institution_id: string
          professor_id: string
          section_id: string
          summary_date: string
        }
        Insert: {
          created_at?: string
          id?: string
          institution_id: string
          professor_id: string
          section_id: string
          summary_date: string
        }
        Update: {
          created_at?: string
          id?: string
          institution_id?: string
          professor_id?: string
          section_id?: string
          summary_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_summary_logs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_summary_logs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_summary_logs_professor_id_fkey"
            columns: ["professor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_summary_logs_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      team_availability: {
        Row: {
          created_at: string
          id: string
          slot_start: string
          team_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          slot_start: string
          team_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          slot_start?: string
          team_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_availability_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_availability_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_invitations: {
        Row: {
          created_at: string
          id: string
          invited_by: string
          invited_user_id: string
          message: string | null
          project_id: string
          responded_at: string | null
          section_id: string
          status: string
          team_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_by: string
          invited_user_id: string
          message?: string | null
          project_id: string
          responded_at?: string | null
          section_id: string
          status?: string
          team_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_by?: string
          invited_user_id?: string
          message?: string | null
          project_id?: string
          responded_at?: string | null
          section_id?: string
          status?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_invitations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invitations_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invitations_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      team_join_requests: {
        Row: {
          created_at: string
          id: string
          message: string
          project_id: string
          responded_at: string | null
          responded_by: string | null
          section_id: string
          status: string
          team_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message?: string
          project_id: string
          responded_at?: string | null
          responded_by?: string | null
          section_id: string
          status?: string
          team_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          project_id?: string
          responded_at?: string | null
          responded_by?: string | null
          section_id?: string
          status?: string
          team_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_join_requests_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_join_requests_responded_by_fkey"
            columns: ["responded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_join_requests_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_join_requests_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_join_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_meeting_rooms: {
        Row: {
          created_at: string
          meet_url: string
          team_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          meet_url: string
          team_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          meet_url?: string
          team_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "team_meeting_rooms_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: true
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_meeting_rooms_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_meetings: {
        Row: {
          created_at: string
          created_by: string
          id: string
          meet_url: string | null
          notes_label: string | null
          notes_url: string | null
          project_id: string
          reminded_at: string | null
          scheduled_start: string | null
          section_id: string
          team_id: string
          title: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          meet_url?: string | null
          notes_label?: string | null
          notes_url?: string | null
          project_id: string
          reminded_at?: string | null
          scheduled_start?: string | null
          section_id: string
          team_id: string
          title?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          meet_url?: string | null
          notes_label?: string | null
          notes_url?: string | null
          project_id?: string
          reminded_at?: string | null
          scheduled_start?: string | null
          section_id?: string
          team_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_meetings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_meetings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_meetings_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_meetings_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "project_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      user_badges: {
        Row: {
          awarded_at: string
          awarded_by: string
          badge_id: string
          created_at: string
          id: string
          reason: string
          section_id: string
          user_id: string
        }
        Insert: {
          awarded_at?: string
          awarded_by: string
          badge_id: string
          created_at?: string
          id?: string
          reason?: string
          section_id: string
          user_id: string
        }
        Update: {
          awarded_at?: string
          awarded_by?: string
          badge_id?: string
          created_at?: string
          id?: string
          reason?: string
          section_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_badges_awarded_by_fkey"
            columns: ["awarded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_badges_badge_id_fkey"
            columns: ["badge_id"]
            isOneToOne: false
            referencedRelation: "badges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_badges_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_badges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_memory: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          institution_id: string
          kind: string
          observed_at: string
          section_id: string | null
          source: string
          text: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          institution_id: string
          kind: string
          observed_at?: string
          section_id?: string | null
          source?: string
          text: string
          updated_at?: string
          user_id: string
          value?: Json
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          institution_id?: string
          kind?: string
          observed_at?: string
          section_id?: string | null
          source?: string
          text?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "user_memory_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_memory_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_memory_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_memory_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      audit_log_with_actor: {
        Row: {
          actor_email: string | null
          actor_id: string | null
          actor_name: string | null
          event_type: string | null
          id: string | null
          metadata: Json | null
          timestamp: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_user_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      institutions_with_counts: {
        Row: {
          admin_count: number | null
          created_at: string | null
          id: string | null
          name: string | null
          slug: string | null
          status: string | null
          total_users: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      section_staff_with_institution: {
        Row: {
          approved_by: string | null
          created_at: string | null
          ends_at: string | null
          id: string | null
          institution_id: string | null
          role: string | null
          section_id: string | null
          staff_id: string | null
          starts_at: string | null
          status: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "course_sections_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_sections_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions_with_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "course_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_staff_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _upsert_skill_node: {
        Args: {
          p_institution_id: string
          p_node: Json
          p_parent_id: string
          p_position: number
          p_section_id: string
        }
        Returns: string
      }
      append_job_progress: {
        Args: { p_entry: Json; p_job_id: string }
        Returns: undefined
      }
      assignment_settings_merge: {
        Args: { p_assignment_id: string; p_key: string; p_value?: Json }
        Returns: undefined
      }
      athena_append_message: {
        Args: {
          p_conversation_id: string
          p_institution_id: string
          p_metadata?: Json
          p_parts: Json
          p_role: string
          p_section_id: string
          p_user_id: string
        }
        Returns: number
      }
      athena_increment_rate_limit: {
        Args: {
          p_cap: number
          p_institution_id: string
          p_model_id: string
          p_scope: string
          p_user_id: string
          p_window_hours: number
        }
        Returns: {
          accepted: boolean
          request_count: number
          window_start: string
        }[]
      }
      can_access_phase: {
        Args: { p_phase_id: string; p_user_id: string }
        Returns: boolean
      }
      can_author_in_section: {
        Args: { p_section_id: string; p_user_id: string }
        Returns: boolean
      }
      cancel_pending_extraction_jobs: {
        Args: { p_module_item_id: string }
        Returns: number
      }
      claim_challenge: {
        Args: { p_challenge_id: string; p_user_id: string }
        Returns: {
          claim_id: string
          revived: boolean
        }[]
      }
      claim_next_extraction_job: {
        Args: { p_claim_ttl_seconds?: number; p_worker_id: string }
        Returns: {
          attempts: number
          claim_expires_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: string
          institution_id: string | null
          kind: string
          max_attempts: number
          module_item_id: string | null
          payload: Json
          started_at: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "extraction_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_next_job: {
        Args: {
          p_claim_ttl_seconds?: number
          p_types?: string[]
          p_worker_id: string
        }
        Returns: {
          attempts: number
          claim_expires_at: string | null
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          institution_id: string
          max_attempts: number
          params: Json
          progress: Json
          result: Json | null
          section_id: string | null
          started_at: string | null
          status: string
          subject_key: string | null
          summary: string | null
          type: string
        }
        SetofOptions: {
          from: "*"
          to: "background_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      clear_auth_rate_limit: { Args: { p_key: string }; Returns: undefined }
      confirm_skill_review: {
        Args: { p_institution_id: string; p_section_id: string; p_skills: Json }
        Returns: number
      }
      cost_daily_series: {
        Args: { p_from: string; p_institution_id?: string; p_to: string }
        Returns: {
          category: string
          cost_usd: number
          day: string
        }[]
      }
      cost_summary_by_institution: {
        Args: { p_from: string; p_to: string }
        Returns: {
          calls: number
          category: string
          cost_usd: number
          feature: string
          institution_id: string
          quantity: number
          tokens: number
        }[]
      }
      delete_office_hours_if_unbooked: {
        Args: { p_office_hours_id: string }
        Returns: boolean
      }
      get_dm_unread_counts: {
        Args: { p_user_id: string }
        Returns: {
          last_message_at: string
          other_user_id: string
          unread_count: number
        }[]
      }
      get_teammate_ids: { Args: { p_user_id: string }; Returns: string[] }
      get_visible_profile_ids: {
        Args: { p_user_id: string }
        Returns: string[]
      }
      increment_auth_rate_limit: {
        Args: { p_cap: number; p_key: string; p_window_minutes: number }
        Returns: {
          accepted: boolean
          resets_at: string
        }[]
      }
      increment_student_quizzes_taken: {
        Args: {
          p_new_rating: number
          p_section_id: string
          p_student_id: string
        }
        Returns: undefined
      }
      insert_project_phase: {
        Args: {
          p_anchor_phase_id: string
          p_description: string
          p_due_date: string
          p_insert_mode: string
          p_project_id: string
          p_start_date: string
          p_status: string
          p_team_id: string
          p_title: string
        }
        Returns: string
      }
      is_admin: { Args: never; Returns: boolean }
      is_admin_of: { Args: { p_institution_id: string }; Returns: boolean }
      is_course_member: { Args: { p_course_id: string }; Returns: boolean }
      is_dm_participant: {
        Args: { p_channel_id: string; p_user_id: string }
        Returns: boolean
      }
      is_enrolled_in_section: { Args: { s_id: string }; Returns: boolean }
      is_enrolled_or_professor: {
        Args: { p_section_id: string; p_user_id: string }
        Returns: boolean
      }
      is_professor_of_section: { Args: { s_id: string }; Returns: boolean }
      is_project_member: {
        Args: { p_project_id: string; p_user_id: string }
        Returns: boolean
      }
      is_project_owner: {
        Args: { p_project_id: string; p_user_id: string }
        Returns: boolean
      }
      is_section_admin: { Args: { p_section_id: string }; Returns: boolean }
      is_section_member: { Args: { p_section_id: string }; Returns: boolean }
      is_section_owner_or_staff: {
        Args: { p_section_id: string }
        Returns: boolean
      }
      is_section_staff: {
        Args: { p_role?: string; p_section_id: string }
        Returns: boolean
      }
      is_staff_of_section: { Args: { s_id: string }; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      is_team_member: {
        Args: { p_team_id: string; p_user_id: string }
        Returns: boolean
      }
      issue_certificates_for_challenge: {
        Args: {
          p_challenge_id: string
          p_section_id: string
          p_student_id: string
        }
        Returns: {
          id: string
          public_id: string
          title: string
        }[]
      }
      join_project_team_atomic: {
        Args: {
          p_project_id: string
          p_role?: string
          p_team_id: string
          p_user_id: string
        }
        Returns: Json
      }
      lc_add_upvote: {
        Args: { p_interaction_id: string; p_user_id: string }
        Returns: Json
      }
      lc_append_transcription: {
        Args: {
          p_deck_id: string
          p_page_number: number
          p_room_id: string
          p_text: string
        }
        Returns: undefined
      }
      lc_auto_end_stale_rooms: { Args: never; Returns: undefined }
      lc_orphan_deck_paths: {
        Args: { p_keep_after?: string; p_limit?: number }
        Returns: string[]
      }
      lc_send_event: {
        Args: {
          p_broadcast?: boolean
          p_data: Json
          p_event_type: string
          p_persist?: boolean
          p_room_id: string
        }
        Returns: number
      }
      lc_toggle_upvote: {
        Args: { p_interaction_id: string; p_user_id: string }
        Returns: Json
      }
      lc_try_drawings_lock: {
        Args: { p_room_id: string; p_user_id: string }
        Returns: boolean
      }
      lc_user_can_access_room: {
        Args: { p_room_id: string; p_user_id: string }
        Returns: boolean
      }
      leave_project_team: {
        Args: { p_team_id: string; p_user_id: string }
        Returns: string
      }
      merge_assignment_settings: {
        Args: {
          p_assignment_id: string
          p_cols?: Json
          p_patch?: Json
          p_remove?: string[]
          p_section_id: string
        }
        Returns: undefined
      }
      merge_section_skill_mastery_config: {
        Args: { p_config: Json; p_section_id: string }
        Returns: undefined
      }
      persist_ai_outcome_alignments: {
        Args: {
          p_created_by: string
          p_institution_id: string
          p_rows: Json
          p_section_id: string
        }
        Returns: number
      }
      place_roadmap_edge: {
        Args: {
          p_kind: string
          p_module_id: string
          p_position: number
          p_resource_id: string
          p_section_id: string
        }
        Returns: undefined
      }
      professor_busy_times: {
        Args: { p_professor_id: string }
        Returns: {
          date: string
          end_time: string
          recurrence: string
          recurrence_until: string
          start_time: string
        }[]
      }
      publish_scheduled_assignments: { Args: never; Returns: undefined }
      reorder_skills: {
        Args: { p_ordered_ids: string[]; p_section_id: string }
        Returns: undefined
      }
      replace_section_skill_mastery: {
        Args: { p_institution_id: string; p_rows: Json; p_section_id: string }
        Returns: undefined
      }
      revoke_staff_assignment: {
        Args: { p_staff_id: string }
        Returns: {
          id: string
        }[]
      }
      roadmap_assessment_counts: {
        Args: { p_section_id: string }
        Returns: {
          activity_id: string
          finished_students: number
          kind: string
          started_students: number
        }[]
      }
      roadmap_set_node_checkoff: {
        Args: {
          p_checked_off: boolean
          p_node_id: string
          p_section_id: string
          p_student_id: string
        }
        Returns: undefined
      }
      safe_cast_uuid: { Args: { p_val: string }; Returns: string }
      sections_with_mastery_evidence: {
        Args: never
        Returns: {
          section_id: string
        }[]
      }
      set_institution_ai_policy: {
        Args: {
          p_expected_version: number
          p_institution_id: string
          p_layer: string
          p_policy: Json
        }
        Returns: number
      }
      set_institution_entitlements: {
        Args: {
          p_config: Json
          p_expected_version: number
          p_institution_id: string
        }
        Returns: number
      }
      set_quiz_question_assignments: {
        Args: {
          p_question_ids: string[]
          p_quiz_id: string
          p_section_id: string
        }
        Returns: string[]
      }
      upsert_ai_grade_suggestion_if_current: {
        Args: {
          p_expected_rubric_version: string
          p_expected_version: string
          p_row: Json
          p_submission_id: string
        }
        Returns: string
      }
      upsert_student_ability: {
        Args: {
          p_se: number
          p_section_id: string
          p_student_id: string
          p_theta: number
        }
        Returns: undefined
      }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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


export type TableRow<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']

// Helper types for common tables
export type Profile = TableRow<'profiles'>
export type Department = TableRow<'departments'>
export type DepartmentFaculty = TableRow<'department_faculty'>
export type Program = TableRow<'programs'>
export type Course = TableRow<'courses'>
export type CourseSection = TableRow<'course_sections'>
export type Enrollment = TableRow<'enrollments'>
export type Announcement = TableRow<'announcements'>
export type Module = TableRow<'modules'>
export type ModuleItem = TableRow<'module_items'>
export type Event = TableRow<'events'>
export type Project = TableRow<'projects'>
export type ProjectMember = TableRow<'project_members'>
export type ProjectPhase = TableRow<'project_phases'>
export type PhaseItem = TableRow<'phase_items'>
export type ProjectVideo = TableRow<'project_videos'>
export type ProjectShowcase = TableRow<'project_showcase'>
export type ProjectTeam = TableRow<'project_teams'>
export type ProjectGrade = TableRow<'project_grades'>
export type FutureContributor = TableRow<'future_contributors'>
export type GithubConnection = TableRow<'github_connections'>
export type ProjectRepository = TableRow<'project_repositories'>
export type ProjectCommit = TableRow<'project_commits'>
export type CourseReview = TableRow<'course_reviews'>
export type CourseQuestion = TableRow<'course_questions'>
export type CourseAnswer = TableRow<'course_answers'>
export type CourseAnswerVote = TableRow<'course_answer_votes'>
export type CourseTip = TableRow<'course_tips'>
export type CourseTipVote = TableRow<'course_tip_votes'>
export type CourseResource = TableRow<'course_resources'>
export type CourseProfessorInsight = TableRow<'course_professor_insights'>
export type AnnouncementRead = TableRow<'announcement_reads'>
export type AnnouncementReaction = TableRow<'announcement_reactions'>
export type AnnouncementComment = TableRow<'announcement_comments'>
export type AnnouncementMention = TableRow<'announcement_mentions'>
export type DbQuizQuestion = TableRow<'quiz_questions'>
export type DbQuiz = TableRow<'quizzes'>
export type DbQuizQuestionAssignment = TableRow<'quiz_question_assignments'>
export type DbQuizAttempt = TableRow<'quiz_attempts'>
export type DbQuizAnswer = TableRow<'quiz_answers'>
export type DbStudentAbility = TableRow<'student_ability'>
export type DbBadge = TableRow<'badges'>
export type Challenge = TableRow<'challenges'>
export type ChallengeClaim = TableRow<'challenge_claims'>
export type ChallengeSubmission = TableRow<'challenge_submissions'>
export type UserBadge = TableRow<'user_badges'>
export type DbOfficeHours = TableRow<'office_hours'>
export type DbBooking = TableRow<'bookings'>
export type DbBlockedTime = TableRow<'blocked_times'>
export type CalendarToken = TableRow<'calendar_tokens'>
export type ProjectChatChannel = TableRow<'project_chat_channels'>
export type ProjectChatMessage = TableRow<'project_chat_messages'>
export type DiscussionChannel = TableRow<'discussion_channels'>
export type DiscussionMessage = TableRow<'discussion_messages'>
export type DmChannel = TableRow<'dm_channels'>
export type DmMessage = TableRow<'dm_messages'>

export type AssignmentAiGradeSuggestion = TableRow<'assignment_ai_grade_suggestions'>
