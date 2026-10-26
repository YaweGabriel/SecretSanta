create extension if not exists pgcrypto;

create table public.draw (
  id smallint primary key default 1 check (id = 1),
  drawn boolean not null default false,
  drawn_at timestamptz,
  host_secret_hash text
);

insert into public.draw (id, drawn) values (1, false);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null unique,
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

create or replace function public.check_host_secret(p_secret text)
returns void
language plpgsql
as $$
declare
  stored text;
begin
  if p_secret is null or length(trim(p_secret)) = 0 then
    raise exception 'BAD_SECRET';
  end if;
  select host_secret_hash into stored from public.draw where id = 1;
  if stored is null then
    update public.draw
      set host_secret_hash = crypt(p_secret, gen_salt('bf'))
      where id = 1;
  elsif stored <> crypt(p_secret, stored) then
    raise exception 'BAD_SECRET';
  end if;
end;
$$;

create or replace function public.perform_draw(p_secret text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
  ids uuid[];
  i integer;
begin
  perform pg_advisory_xact_lock(1);
  perform public.check_host_secret(p_secret);
  if (select drawn from public.draw where id = 1) then
    raise exception 'ALREADY_DRAWN';
  end if;
  select count(*) into n from public.people;
  if n < 2 then
    raise exception 'NEED_TWO';
  end if;
  select array_agg(id) into ids from (
    select id from public.people order by random()
  ) shuffled;
  for i in 1..n loop
    update public.people
      set match_id = ids[case when i = n then 1 else i + 1 end]
      where id = ids[i];
  end loop;
  update public.draw set drawn = true, drawn_at = now() where id = 1;
  return n;
end;
$$;

create or replace function public.reset_draw(p_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(1);
  perform public.check_host_secret(p_secret);
  update public.people set match_id = null;
  delete from public.people;
  update public.draw
    set drawn = false, drawn_at = null
    where id = 1;
end;
$$;

alter table public.draw enable row level security;
alter table public.people enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert on table public.people to anon, authenticated;
grant select on table public.draw to anon, authenticated;

create policy people_select on public.people
  for select to anon, authenticated
  using (true);

create policy people_insert on public.people
  for insert to anon, authenticated
  with check (true);

create policy draw_select on public.draw
  for select to anon, authenticated
  using (true);

revoke all on function public.check_host_secret(text) from public, anon, authenticated;
grant execute on function public.perform_draw(text) to anon, authenticated;
grant execute on function public.reset_draw(text) to anon, authenticated;
