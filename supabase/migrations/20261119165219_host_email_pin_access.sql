alter table public.baskets
  add column host_email text,
  add column host_pin_hash text,
  add column stored_link text;

alter table public.baskets alter column host_secret_hash drop not null;

update public.baskets
set stored_link = '/b/' || public_code
where stored_link is null;

alter table public.baskets alter column stored_link set not null;

create table public.basket_host_sessions (
  basket_id uuid not null references public.baskets(id) on delete cascade,
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (basket_id, session_hash)
);
alter table public.basket_host_sessions enable row level security;
revoke all on public.basket_host_sessions from public, anon, authenticated;

create table public.basket_host_pin_attempts (
  basket_id uuid not null references public.baskets(id) on delete cascade,
  attempt_count integer not null check (attempt_count >= 0),
  window_started_at timestamptz not null,
  primary key (basket_id)
);
alter table public.basket_host_pin_attempts enable row level security;
revoke all on public.basket_host_pin_attempts from public, anon, authenticated;

create or replace function public.create_basket(
  p_host_name text,
  p_capacity integer,
  p_session_hash text,
  p_public_code text,
  p_host_email text,
  p_host_pin text,
  p_stored_link text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare bid uuid;
begin
  if p_host_name is null or length(trim(p_host_name)) not between 1 and 80
    or p_capacity not between 2 and 50
    or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_public_code is null or p_public_code !~ '^[a-z0-9]{10}$'
    or p_host_email is null or length(trim(p_host_email)) > 254
    or p_host_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_host_pin is null or p_host_pin !~ '^[0-9]{4}$'
    or p_stored_link is null or length(p_stored_link) > 500
    or p_stored_link !~ '^https?://' then
    raise exception 'BAD_BASKET';
  end if;

  insert into public.baskets(host_name, capacity, public_code, host_email, host_pin_hash, stored_link)
  values(
    trim(p_host_name),
    p_capacity,
    p_public_code,
    lower(trim(p_host_email)),
    extensions.crypt(p_host_pin, extensions.gen_salt('bf', 6)),
    p_stored_link
  ) returning id into bid;

  insert into public.basket_host_sessions(basket_id, session_hash)
  values (bid, p_session_hash);

  return jsonb_build_object(
    'id', bid,
    'publicCode', p_public_code,
    'storedLink', p_stored_link,
    'hostName', trim(p_host_name),
    'capacity', p_capacity,
    'total', 0
  );
end $$;
revoke all on function public.create_basket(text,integer,text,text,text,text,text) from public;
grant execute on function public.create_basket(text,integer,text,text,text,text,text) to anon, authenticated;
revoke all on function public.create_basket(text,integer,text,text,text) from public, anon, authenticated;

create or replace function public.verify_basket_host(
  p_public_code text,
  p_host_email text,
  p_host_pin text,
  p_session_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.baskets%rowtype; attempts integer;
begin
  if p_public_code is null or p_public_code !~ '^[a-z0-9]{10}$'
    or p_host_email is null or p_host_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_host_pin is null or p_host_pin !~ '^[0-9]{4}$'
    or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_HOST_CREDENTIALS';
  end if;

  select * into b from public.baskets where public_code = p_public_code;
  if not found then raise exception 'BASKET_NOT_FOUND'; end if;

  insert into public.basket_host_pin_attempts as a(basket_id, attempt_count, window_started_at)
  values (b.id, 1, now())
  on conflict (basket_id) do update
  set attempt_count = case
        when a.window_started_at < now() - interval '15 minutes' then 1
        when a.attempt_count >= 6 then 6
        else a.attempt_count + 1
      end,
      window_started_at = case
        when a.window_started_at < now() - interval '15 minutes' then now()
        else a.window_started_at
      end
  returning attempt_count into attempts;

  if attempts > 5 then return jsonb_build_object('error', 'PIN_RATE_LIMITED'); end if;

  if b.host_email is null or b.host_pin_hash is null
    or lower(trim(p_host_email)) is distinct from b.host_email
    or b.host_pin_hash <> extensions.crypt(p_host_pin, b.host_pin_hash) then
    return jsonb_build_object('error', 'BAD_HOST_CREDENTIALS');
  end if;

  delete from public.basket_host_pin_attempts where basket_id = b.id;
  insert into public.basket_host_sessions(basket_id, session_hash)
  values (b.id, p_session_hash)
  on conflict (basket_id, session_hash) do update set created_at = now();

  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.verify_basket_host(text,text,text,text) from public;
grant execute on function public.verify_basket_host(text,text,text,text) to anon, authenticated;

create or replace function public.launch_basket(p_basket_id uuid, p_host_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.baskets%rowtype; n integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_basket_id::text));
  select * into b from public.baskets where id=p_basket_id for update;
  if not found then raise exception 'BASKET_NOT_FOUND'; end if;

  if b.host_email is not null then
    if not exists (
      select 1 from public.basket_host_sessions s
      where s.basket_id = p_basket_id and s.session_hash = p_host_secret
        and s.created_at > now() - interval '365 days'
    ) then raise exception 'BAD_SECRET'; end if;
  elsif b.host_secret_hash is null or b.host_secret_hash <> extensions.crypt(p_host_secret,b.host_secret_hash) then
    raise exception 'BAD_SECRET';
  end if;

  select count(*) into n from public.people where basket_id=p_basket_id;
  if n <> b.capacity then raise exception 'DRAW_NOT_FULL'; end if;
  update public.baskets set launched=true where id=p_basket_id;
  return jsonb_build_object('ok',true,'total',n);
end $$;
revoke all on function public.launch_basket(uuid,text) from public;
grant execute on function public.launch_basket(uuid,text) to anon, authenticated;

create or replace function public.basket_status(p_basket_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'id',b.id,'publicCode',b.public_code,'hostName',b.host_name,
    'capacity',b.capacity,'launched',b.launched,'drawn',b.drawn,'legacy',b.legacy,
    'hasHostPin',b.host_pin_hash is not null
  ) from public.baskets b where b.id=p_basket_id
$$;

drop function public.basket_status_by_code(text);
create or replace function public.basket_status_by_code(p_public_code text, p_session_hash text)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'id',b.id,'publicCode',b.public_code,'hostName',b.host_name,
    'capacity',b.capacity,'launched',b.launched,'drawn',b.drawn,'legacy',b.legacy,
    'hasHostPin',b.host_pin_hash is not null,
    'hostAccess',exists (
      select 1 from public.basket_host_sessions s
      where s.basket_id=b.id and s.session_hash=p_session_hash
        and s.created_at > now() - interval '365 days'
    )
  ) from public.baskets b where b.public_code=p_public_code
$$;
revoke all on function public.basket_status_by_code(text,text) from public;
grant execute on function public.basket_status_by_code(text,text) to anon, authenticated;
