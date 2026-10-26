create table public.draw (
  id smallint primary key default 1 check (id = 1),
  drawn boolean not null default false,
  drawn_at timestamptz
);

insert into public.draw (id, drawn) values (1, false);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,
  pin_hash text not null,
  pin_salt text not null,
  match_id uuid references public.people (id),
  created_at timestamptz not null default now()
);

create index people_match_id_idx on public.people (match_id);

create or replace function public.people_before_insert()
returns trigger
language plpgsql
as $$
begin
  if (select drawn from public.draw where id = 1) then
    raise exception 'DRAW_CLOSED';
  end if;
  if (select count(*) from public.people) >= 30 then
    raise exception 'DRAW_FULL';
  end if;
  return new;
end;
$$;

create trigger people_before_insert
before insert on public.people
for each row
execute procedure public.people_before_insert();

alter table public.draw enable row level security;
alter table public.people enable row level security;

revoke all on table public.draw from anon, authenticated;
revoke all on table public.people from anon, authenticated;
revoke all on function public.people_before_insert() from public, anon, authenticated;
