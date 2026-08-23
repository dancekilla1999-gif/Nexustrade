-- Таблица глобальных настроек приложения (режим технического обслуживания).
-- Выполнить один раз в Supabase → SQL Editor.
--
-- Без неё /api/config не может сохранить настройки: переключатель в админке
-- будет возвращать ошибку «таблица app_settings не создана».

create table if not exists app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- Стартовая запись: оба контура работают в обычном режиме.
insert into app_settings (key, value)
values ('main', '{
  "prop": { "maintenance": false, "message": "", "until": "" },
  "bot":  { "maintenance": false, "message": "", "until": "" }
}'::jsonb)
on conflict (key) do nothing;

-- Доступ к таблице идёт только через service key на стороне сервера
-- (/api/config), поэтому анонимной роли здесь делать нечего.
alter table app_settings enable row level security;
