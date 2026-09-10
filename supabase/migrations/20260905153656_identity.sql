-- Backend-only foundation. API access stays denied until a reviewed tenant policy exists.
create table public.principals (
  id uuid primary key, kind text not null check (kind in ('HUMAN','SERVICE')),
  created_at timestamptz not null default now()
);
create table public.tenants (id uuid primary key, name text not null, created_at timestamptz not null default now());
create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants,
  principal_id uuid not null references public.principals, role text not null,
  created_at timestamptz not null default now(), unique (tenant_id, principal_id)
);
create table public.channels (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants,
  source text not null, created_at timestamptz not null default now(), unique (tenant_id, source)
);
do $$ declare t text; begin
  foreach t in array array['principals','tenants','tenant_memberships','channels'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
