create table public.baskets (
  id uuid primary key default gen_random_uuid(),
  host_name text not null check (char_length(host_name) between 1 and 80),
  capacity integer not null check (capacity between 2 and 50),
  host_secret_hash text not null,
  legacy boolean not null default false,
  launched boolean not null default false,
  drawn boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.baskets (host_name, capacity, host_secret_hash, launched, drawn, legacy)
select 'Host', 50, coalesce(host_secret_hash, extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf'))), true, drawn, true
from public.draw where id = 1;

alter table public.people add column basket_id uuid references public.baskets(id);
update public.people set basket_id = (select id from public.baskets order by created_at limit 1);
alter table public.people alter column basket_id set not null;
alter table public.people drop constraint if exists people_name_key_key;
create unique index people_basket_name_unique on public.people(basket_id, name_key);
create index people_basket_idx on public.people(basket_id, created_at);
drop index if exists public.people_browser_session_hash_idx;
create unique index people_basket_session_hash_idx on public.people(basket_id, browser_session_hash) where browser_session_hash is not null;

alter table public.baskets enable row level security;
revoke all on public.baskets from public, anon, authenticated;
revoke all on public.people from public, anon, authenticated;
revoke all on function public.perform_draw(text), public.reset_draw(text), public.check_host_secret(text) from public, anon, authenticated;

create or replace function public.people_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.basket_id::text));
  if (select b.launched from public.baskets b where b.id=new.basket_id) then raise exception 'DRAW_CLOSED'; end if;
  if (select count(*) from public.people p where p.basket_id=new.basket_id) >= (select b.capacity from public.baskets b where b.id=new.basket_id) then raise exception 'DRAW_FULL'; end if;
  return new;
end $$;

create or replace function public.create_basket(p_host_name text, p_capacity integer, p_host_secret text, p_session_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare bid uuid;
begin
  if p_host_name is null or length(trim(p_host_name)) not between 1 and 80 or p_capacity not between 2 and 50
    or p_host_secret is null or length(p_host_secret) < 20 or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then raise exception 'BAD_BASKET'; end if;
  perform pg_advisory_xact_lock(1);
  insert into public.baskets(host_name, capacity, host_secret_hash) values(trim(p_host_name), p_capacity, extensions.crypt(p_host_secret, extensions.gen_salt('bf'))) returning id into bid;
  insert into public.people(basket_id, name, name_key, browser_session_hash) values(bid, trim(p_host_name), lower(trim(p_host_name)), p_session_hash);
  return jsonb_build_object('id', bid, 'hostName', trim(p_host_name), 'capacity', p_capacity, 'total', 1);
end $$;
revoke all on function public.create_basket(text,integer,text,text) from public;
grant execute on function public.create_basket(text,integer,text,text) to anon, authenticated;

create or replace function public.join_basket(p_basket_id uuid, p_name text, p_session_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.baskets%rowtype; pid uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_basket_id::text));
  select * into b from public.baskets where id=p_basket_id for update;
  if not found then raise exception 'BASKET_NOT_FOUND'; end if;
  if b.launched then raise exception 'DRAW_CLOSED'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 80 or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then raise exception 'BAD_NAME'; end if;
  if (select count(*) from public.people where basket_id=p_basket_id) >= b.capacity then raise exception 'DRAW_FULL'; end if;
  insert into public.people(basket_id,name,name_key,browser_session_hash) values(p_basket_id,trim(p_name),lower(trim(p_name)),p_session_hash) returning id into pid;
  return jsonb_build_object('id',pid,'name',trim(p_name));
end $$;
revoke all on function public.join_basket(uuid,text,text) from public;
grant execute on function public.join_basket(uuid,text,text) to anon, authenticated;

create or replace function public.launch_basket(p_basket_id uuid, p_host_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.baskets%rowtype; n integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_basket_id::text));
  select * into b from public.baskets where id=p_basket_id for update;
  if not found then raise exception 'BASKET_NOT_FOUND'; end if;
  if p_host_secret is null or b.host_secret_hash <> extensions.crypt(p_host_secret,b.host_secret_hash) then raise exception 'BAD_SECRET'; end if;
  select count(*) into n from public.people where basket_id=p_basket_id;
  if n < 2 then raise exception 'NEED_TWO'; end if;
  update public.baskets set launched=true where id=p_basket_id;
  return jsonb_build_object('ok',true,'total',n);
end $$;
revoke all on function public.launch_basket(uuid,text) from public;
grant execute on function public.launch_basket(uuid,text) to anon, authenticated;

create or replace function public.basket_status(p_basket_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('id',b.id,'hostName',b.host_name,'capacity',b.capacity,'launched',b.launched,'drawn',b.drawn)
  from public.baskets b where b.id=p_basket_id
$$;
revoke all on function public.basket_status(uuid) from public;
grant execute on function public.basket_status(uuid) to anon, authenticated;

create or replace function public.list_draw_roster(p_basket_id uuid)
returns table(id uuid,name text) language sql security definer set search_path = '' as $$
  select p.id,p.name from public.people p where p.basket_id=p_basket_id order by p.created_at
$$;
create or replace function public.list_available_people(p_basket_id uuid,p_session_hash text)
returns table(id uuid,name text) language sql security definer set search_path = '' as $$
  select p.id,p.name from public.people p join public.baskets b on b.id=p.basket_id where p.basket_id=p_basket_id and b.launched and not b.drawn and p.match_id is null and (b.legacy or p.browser_session_hash=p_session_hash) order by p.created_at
$$;
revoke all on function public.list_draw_roster(uuid), public.list_available_people(uuid,text) from public;
grant execute on function public.list_draw_roster(uuid), public.list_available_people(uuid,text) to anon, authenticated;

create or replace function public.get_session_match(p_basket_id uuid,p_session_hash text)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('matched',true,'personName',p.name,'matchName',r.matched_to_name)
    from public.people p join public.people r on r.id=p.match_id where p.basket_id=p_basket_id and p.browser_session_hash=p_session_hash),jsonb_build_object('matched',false))
$$;
revoke all on function public.get_session_match(uuid,text) from public;
grant execute on function public.get_session_match(uuid,text) to anon, authenticated;

create or replace function public.match_one(p_basket_id uuid,p_person_id uuid,p_session_hash text,p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare recipient public.people%rowtype; who public.people%rowtype; b public.baskets%rowtype;
  existing_match jsonb; rate_window timestamptz; ip_requests integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_basket_id::text));
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then raise exception 'BAD_SESSION'; end if;
  select * into b from public.baskets where id=p_basket_id for update;
  if not found or not b.launched then raise exception 'DRAW_CLOSED'; end if;
  select jsonb_build_object('matchName',r.matched_to_name,'personName',p.name,'alreadyMatched',true)
    into existing_match from public.people p join public.people r on r.id=p.match_id
    where p.basket_id=p_basket_id and p.browser_session_hash=p_session_hash;
  if existing_match is not null then return existing_match; end if;
  select p.* into who from public.people p where p.id=p_person_id and p.basket_id=p_basket_id and p.match_id is null and (b.legacy or p.browser_session_hash=p_session_hash);
  if not found then raise exception 'ALREADY_MATCHED'; end if;
  if (select count(*) from public.people p where p.basket_id=p_basket_id)<2 then raise exception 'NEED_TWO'; end if;
  rate_window := date_trunc('hour', now());
  delete from public.match_ip_rate_limits l where l.window_started_at < rate_window - interval '24 hours';
  insert into public.match_ip_rate_limits as l(ip_hash,window_started_at,request_count) values(p_ip_hash,rate_window,1)
  on conflict(ip_hash) do update set request_count=case when l.window_started_at=excluded.window_started_at then l.request_count+1 else 1 end, window_started_at=excluded.window_started_at
  returning request_count into ip_requests;
  if ip_requests > 30 then return jsonb_build_object('error','RATE_LIMITED'); end if;
  select p.* into recipient from public.people p
  where p.basket_id=p_basket_id and p.id<>p_person_id
    and not exists(select 1 from public.people x where x.basket_id=p_basket_id and x.match_id=p.id)
    and not exists (
      select 1 from public.people last_giver
      where last_giver.basket_id=p_basket_id and last_giver.match_id is null and last_giver.id<>p_person_id
        and (select count(*) from public.people pending where pending.basket_id=p_basket_id and pending.match_id is null and pending.id<>p_person_id)=1
        and last_giver.id<>p.id
    )
  order by random() limit 1;
  if not found then raise exception 'NO_MATCH_CANDIDATE'; end if;
  update public.people set match_id=recipient.id,browser_session_hash=p_session_hash where id=p_person_id;
  update public.baskets set drawn=true where id=p_basket_id and not exists(select 1 from public.people p where p.basket_id=p_basket_id and p.match_id is null);
  return jsonb_build_object('matchName',recipient.name);
end $$;
revoke all on function public.match_one(uuid,uuid,text,text) from public;
grant execute on function public.match_one(uuid,uuid,text,text) to anon, authenticated;

drop function if exists public.list_draw_roster();
drop function if exists public.list_available_people();
drop function if exists public.list_available_people(uuid);
drop function if exists public.get_session_match(text);
drop function if exists public.match_one(uuid,text,text);
