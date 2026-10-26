-- Audio prompts for call queue redirects (Set-CsCallQueue -<X>Redirect<Person|Voicemail>AudioFilePrompt). Kept in the database
-- (they are small: Teams takes up to 5 MB) so the worker, which has no access to the API's file volume, can read them and run
-- Import-CsOnlineAudioFile in the same live run that uses them - Teams deletes an imported file within 48-72 hours unless a
-- queue uses it. teams_audio_file_id is the id Teams gave the last import that a queue then used.
CREATE TABLE {{SCHEMA}}.voice_audio_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename            text NOT NULL,
  content_type        text NOT NULL,
  byte_size           integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  content             bytea NOT NULL,
  teams_audio_file_id text,
  imported_at         timestamptz,
  uploaded_by         uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
