-- Supabase SQL for NEXUS ledger
create table if not exists nexus_balances (
  user_id text primary key,
  balance numeric not null default 0,
  updated_at timestamptz default now()
);
create table if not exists nexus_txs (
  id bigserial primary key,
  user_id text not null,
  user_name text,
  kind text not null, -- deposit | withdraw | credit | burn
  amount numeric not null default 0,
  tx_sig text,
  to_address text,
  status text not null default 'pending', -- pending | done | rejected
  meta jsonb,
  created_at timestamptz default now(),
  reviewed_at timestamptz
);
create index if not exists nexus_txs_user on nexus_txs(user_id);
create index if not exists nexus_txs_status on nexus_txs(status);
