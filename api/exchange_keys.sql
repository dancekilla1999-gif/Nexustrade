-- НЕОБЯЗАТЕЛЬНО. Отдельная таблица для биржевых API-ключей.
--
-- Сейчас api/exchange.js хранит зашифрованные ключи в уже существующей
-- таблице app_settings (строки key = "exkeys:<user>:<exchange>", value jsonb),
-- поэтому для работы раздела «Своя биржа» выполнять этот файл НЕ нужно.
-- Он оставлен как описание «чистой» схемы на случай, если захочется вынести
-- ключи в отдельную таблицу: для этого достаточно переписать пять функций
-- хранилища в api/exchange.js (readRows/readOne/writeRow/deleteRow/touch).
--
-- Секреты в любом случае лежат ЗАШИФРОВАННЫМИ (AES-256-GCM, мастер-ключ в env,
-- AAD = user_id). Даже с полным дампом этой таблицы без мастер-ключа
-- расшифровать нечего, а перенести чужую строку себе не получится: AAD
-- привязывает шифротекст к владельцу.
--
-- RLS включён и политик НЕТ намеренно: к таблице ходит только серверная
-- функция под service-ключом (он обходит RLS). Любой доступ с anon-ключа
-- из браузера должен получать пустоту, а не данные.

create table if not exists public.exchange_keys (
  user_id        text        not null,
  exchange       text        not null,
  api_key_enc    text        not null,
  api_secret_enc text        not null,
  passphrase_enc text,
  key_mask       text        not null,
  label          text,
  can_trade      boolean     not null default false,
  can_futures    boolean     not null default false,
  -- null = биржа не сообщает, ограничен ли ключ по IP (так у OKX)
  ip_restricted  boolean,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  primary key (user_id, exchange)
);

create index if not exists exchange_keys_user_idx on public.exchange_keys (user_id);

alter table public.exchange_keys enable row level security;

-- Никаких политик: таблица недоступна ни с anon, ни с authenticated ключа.
-- Единственный путь к ней — серверные функции с SUPABASE_SERVICE_KEY.
revoke all on public.exchange_keys from anon, authenticated;
