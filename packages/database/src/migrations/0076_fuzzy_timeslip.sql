ALTER TABLE "project_user_preferences" DROP CONSTRAINT "project_user_preferences_new_chat_fallback_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "new_chat_fallback_work_id";