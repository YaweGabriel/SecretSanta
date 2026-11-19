alter table public.baskets add column public_code text;

update public.baskets
set public_code = lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

update public.baskets b
set capacity = greatest(2, (select count(*) from public.people p where p.basket_id = b.id))
where b.legacy;

alter table public.baskets alter column public_code set not null;
create unique index baskets_public_code_unique_idx on public.baskets (public_code);

create or replace function public.create_basket(
  p_host_name text,
  p_capacity integer,
  p_host_secret text,
  p_session_hash text,
  p_public_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare bid uuid;
begin
  if p_host_name is null or length(trim(p_host_name)) not between 1 and 80
    or p_capacity not between 2 and 50
    or p_host_secret is null or length(p_host_secret) < 20
    or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_public_code is null or p_public_code !~ '^[A-Za-z0-9_-]{10}$' then
    raise exception 'BAD_BASKET';
  end if;

  insert into public.baskets(host_name, capacity, host_secret_hash, public_code)
  values(trim(p_host_name), p_capacity, extensions.crypt(p_host_secret, extensions.gen_salt('bf')), p_public_code)
  returning id into bid;

  return jsonb_build_object(
    'id', bid,
    'publicCode', p_public_code,
    'hostName', trim(p_host_name),
    'capacity', p_capacity,
    'total', 0
  );
end $$;
revoke all on function public.create_basket(text,integer,text,text) from public, anon, authenticated;
revoke all on function public.create_basket(text,integer,text,text,text) from public;
grant execute on function public.create_basket(text,integer,text,text,text) to anon, authenticated;

create or replace function public.launch_basket(p_basket_id uuid, p_host_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.baskets%rowtype; n integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_basket_id::text));
  select * into b from public.baskets where id=p_basket_id for update;
  if not found then raise exception 'BASKET_NOT_FOUND'; end if;
  if p_host_secret is null or b.host_secret_hash <> extensions.crypt(p_host_secret,b.host_secret_hash) then raise exception 'BAD_SECRET'; end if;
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
    'capacity',b.capacity,'launched',b.launched,'drawn',b.drawn
  ) from public.baskets b where b.id=p_basket_id
$$;

create or replace function public.basket_status_by_code(p_public_code text)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'id',b.id,'publicCode',b.public_code,'hostName',b.host_name,
    'capacity',b.capacity,'launched',b.launched,'drawn',b.drawn
  ) from public.baskets b where b.public_code=p_public_code
$$;
revoke all on function public.basket_status_by_code(text) from public;
grant execute on function public.basket_status_by_code(text) to anon, authenticated;
