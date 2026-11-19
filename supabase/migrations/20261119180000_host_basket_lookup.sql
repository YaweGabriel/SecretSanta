create table public.basket_host_lookup_attempts (
  email_hash text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  attempt_count integer not null check (attempt_count >= 0),
  window_started_at timestamptz not null
);
alter table public.basket_host_lookup_attempts enable row level security;
revoke all on public.basket_host_lookup_attempts from public, anon, authenticated;

create or replace function public.list_host_baskets(
  p_host_email text,
  p_host_pin text,
  p_session_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  email_key text;
  attempts integer;
  b public.baskets%rowtype;
  found_baskets jsonb := '[]'::jsonb;
begin
  if p_host_email is null or p_host_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(p_host_email) > 254 or p_host_pin is null or p_host_pin !~ '^[0-9]{4}$'
    or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_HOST_CREDENTIALS';
  end if;

  email_key := encode(extensions.digest(lower(trim(p_host_email)), 'sha256'), 'hex');
  insert into public.basket_host_lookup_attempts as a(email_hash, attempt_count, window_started_at)
  values (email_key, 1, now())
  on conflict (email_hash) do update
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

  for b in
    select * from public.baskets
    where host_email = lower(trim(p_host_email)) and host_pin_hash is not null
  loop
    if b.host_pin_hash = extensions.crypt(p_host_pin, b.host_pin_hash) then
      insert into public.basket_host_sessions(basket_id, session_hash)
      values (b.id, p_session_hash)
      on conflict (basket_id, session_hash) do update set created_at = now();

      found_baskets := found_baskets || jsonb_build_array(jsonb_build_object(
        'publicCode', b.public_code,
        'hostName', b.host_name,
        'capacity', b.capacity,
        'total', (select count(*) from public.people p where p.basket_id = b.id),
        'storedLink', b.stored_link
      ));
    end if;
  end loop;

  if found_baskets <> '[]'::jsonb then
    delete from public.basket_host_lookup_attempts where email_hash = email_key;
  end if;
  return found_baskets;
end $$;
revoke all on function public.list_host_baskets(text,text,text) from public;
grant execute on function public.list_host_baskets(text,text,text) to anon, authenticated;
