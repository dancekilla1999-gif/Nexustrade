-- Ограничение частоты запросов. Выполнить один раз в Supabase → SQL Editor.
--
-- Без этой миграции /api/_ratelimit.js работает в открытом режиме отказа
-- (rate_limit_hit ещё не существует → RPC вернёт ошибку → запрос пропускается),
-- то есть приложение не сломается, но и лимитов не будет, пока миграция не
-- выполнена.

create table if not exists rate_limits (
  bucket_key   text primary key,
  window_start timestamptz not null,
  count        int not null default 0
);

-- Инкремент атомарный за счёт ON CONFLICT DO UPDATE — Postgres берёт блокировку
-- на строку внутри одного upsert, поэтому два параллельных запроса с одним
-- ключом не могут оба прочитать "count=0" и оба записать "count=1".
create or replace function rate_limit_hit(p_key text, p_window_seconds int, p_max int)
returns table(allowed boolean, remaining int, reset_in int)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_row rate_limits;
begin
  insert into rate_limits (bucket_key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (bucket_key) do update
    set count = case
          when rate_limits.window_start <= v_now - make_interval(secs => p_window_seconds)
            then 1
          else rate_limits.count + 1
        end,
        window_start = case
          when rate_limits.window_start <= v_now - make_interval(secs => p_window_seconds)
            then v_now
          else rate_limits.window_start
        end
  returning * into v_row;

  return query select
    v_row.count <= p_max,
    greatest(0, p_max - v_row.count),
    greatest(0, p_window_seconds - extract(epoch from (v_now - v_row.window_start))::int);
end;
$$;

-- Доступ идёт только через service key на стороне сервера (rate_limit_hit
-- вызывается из api/_ratelimit.js), поэтому анонимной роли здесь делать нечего.
alter table rate_limits enable row level security;

-- Периодическая уборка старых строк — не обязательна (таблица растёт медленно:
-- по одной строке на уникальный IP/пользователя), но не помешает, если решите
-- поставить её по расписанию в Supabase → Database → Cron:
--   delete from rate_limits where window_start < now() - interval '1 day';
