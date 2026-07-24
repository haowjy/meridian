ALTER TABLE "change_trail_document_details" ADD COLUMN "words_added" integer;--> statement-breakpoint
ALTER TABLE "change_trail_document_details" ADD COLUMN "words_removed" integer;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD COLUMN "documents" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD COLUMN "words_added" integer;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD COLUMN "words_removed" integer;