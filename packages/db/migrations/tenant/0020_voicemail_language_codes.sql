-- Voicemail language was free text ("English"), but it deploys straight into
-- Set-CsOnlineVoicemailUserSettings -PromptLanguage, which only accepts a
-- culture code (en-US, en-GB, ...) - so every row with a plain name would have
-- failed on execute. The field is now a picker of Teams-supported codes
-- (VOICEMAIL_PROMPT_LANGUAGES in packages/shared/src/domain.ts) and the API
-- rejects anything else. This converts what's already stored, in all three
-- places a language lives: discovery_users.voicemail_language (Data
-- Collection) and the voicemail->>'language' jsonb key on build_users /
-- build_caps (Design & Build).
--
--   1. common English names -> code (same map as normalizeVoicemailLanguage)
--   2. values that are already a code -> canonical case (en-us -> en-US)
--   3. anything still unrecognised -> NULL. It could never have deployed,
--      and a NULL just means the cmdlet omits -PromptLanguage (tenant default)
--      rather than blocking the whole row on validation.

CREATE TEMP TABLE vm_lang_map (name text PRIMARY KEY, code text NOT NULL) ON COMMIT DROP;
INSERT INTO vm_lang_map (name, code) VALUES
  ('english', 'en-US'), ('english (us)', 'en-US'), ('english (united states)', 'en-US'),
  ('us english', 'en-US'), ('american english', 'en-US'),
  ('english (uk)', 'en-GB'), ('english (united kingdom)', 'en-GB'), ('uk english', 'en-GB'),
  ('british english', 'en-GB'),
  ('english (australia)', 'en-AU'), ('english (canada)', 'en-CA'), ('english (india)', 'en-IN'),
  ('french', 'fr-FR'), ('french (france)', 'fr-FR'), ('french (canada)', 'fr-CA'),
  ('german', 'de-DE'),
  ('spanish', 'es-ES'), ('spanish (spain)', 'es-ES'), ('spanish (mexico)', 'es-MX'),
  ('italian', 'it-IT'),
  ('portuguese', 'pt-PT'), ('portuguese (brazil)', 'pt-BR'), ('portuguese (portugal)', 'pt-PT'),
  ('dutch', 'nl-NL'), ('swedish', 'sv-SE'), ('danish', 'da-DK'), ('norwegian', 'nb-NO'),
  ('finnish', 'fi-FI'), ('polish', 'pl-PL'), ('czech', 'cs-CZ'), ('turkish', 'tr-TR'),
  ('russian', 'ru-RU'), ('japanese', 'ja-JP'), ('korean', 'ko-KR'),
  ('chinese', 'zh-CN'), ('chinese (simplified)', 'zh-CN'), ('chinese (traditional)', 'zh-TW');

CREATE TEMP TABLE vm_lang_codes (code text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO vm_lang_codes (code) VALUES
  ('en-US'), ('en-GB'), ('en-AU'), ('en-CA'), ('en-IN'), ('fr-FR'), ('fr-CA'), ('de-DE'),
  ('es-ES'), ('es-MX'), ('it-IT'), ('pt-BR'), ('pt-PT'), ('nl-NL'), ('nl-BE'), ('sv-SE'),
  ('da-DK'), ('nb-NO'), ('fi-FI'), ('pl-PL'), ('cs-CZ'), ('sk-SK'), ('hu-HU'), ('ro-RO'),
  ('el-GR'), ('tr-TR'), ('ru-RU'), ('he-IL'), ('ar-EG'), ('hi-IN'), ('th-TH'), ('vi-VN'),
  ('id-ID'), ('ja-JP'), ('ko-KR'), ('zh-CN'), ('zh-TW'), ('zh-HK');

-- ---- discovery_users.voicemail_language (plain text column) ----
UPDATE {{SCHEMA}}.discovery_users du
  SET voicemail_language = m.code
  FROM vm_lang_map m
  WHERE lower(trim(du.voicemail_language)) = m.name;
UPDATE {{SCHEMA}}.discovery_users
  SET voicemail_language = lower(substr(trim(voicemail_language), 1, 2)) || '-' || upper(substr(trim(voicemail_language), 4, 2))
  WHERE trim(voicemail_language) ~* '^[a-z]{2}[-_][a-z]{2}$';
UPDATE {{SCHEMA}}.discovery_users
  SET voicemail_language = NULL
  WHERE voicemail_language IS NOT NULL
    AND voicemail_language NOT IN (SELECT code FROM vm_lang_codes);

-- ---- build_users.voicemail->>'language' (jsonb) ----
UPDATE {{SCHEMA}}.build_users bu
  SET voicemail = jsonb_set(bu.voicemail, '{language}', to_jsonb(m.code))
  FROM vm_lang_map m
  WHERE lower(trim(bu.voicemail->>'language')) = m.name;
UPDATE {{SCHEMA}}.build_users
  SET voicemail = jsonb_set(voicemail, '{language}',
        to_jsonb(lower(substr(trim(voicemail->>'language'), 1, 2)) || '-' || upper(substr(trim(voicemail->>'language'), 4, 2))))
  WHERE trim(voicemail->>'language') ~* '^[a-z]{2}[-_][a-z]{2}$';
UPDATE {{SCHEMA}}.build_users
  SET voicemail = voicemail - 'language'
  WHERE voicemail ? 'language'
    AND voicemail->>'language' IS NOT NULL
    AND voicemail->>'language' NOT IN (SELECT code FROM vm_lang_codes);

-- ---- build_caps.voicemail->>'language' (jsonb) ----
UPDATE {{SCHEMA}}.build_caps bc
  SET voicemail = jsonb_set(bc.voicemail, '{language}', to_jsonb(m.code))
  FROM vm_lang_map m
  WHERE lower(trim(bc.voicemail->>'language')) = m.name;
UPDATE {{SCHEMA}}.build_caps
  SET voicemail = jsonb_set(voicemail, '{language}',
        to_jsonb(lower(substr(trim(voicemail->>'language'), 1, 2)) || '-' || upper(substr(trim(voicemail->>'language'), 4, 2))))
  WHERE trim(voicemail->>'language') ~* '^[a-z]{2}[-_][a-z]{2}$';
UPDATE {{SCHEMA}}.build_caps
  SET voicemail = voicemail - 'language'
  WHERE voicemail ? 'language'
    AND voicemail->>'language' IS NOT NULL
    AND voicemail->>'language' NOT IN (SELECT code FROM vm_lang_codes);
