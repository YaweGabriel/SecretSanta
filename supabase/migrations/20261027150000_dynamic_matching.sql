-- Participants are managed by the host in the database; there is no public signup.
revoke all on table public.people from public, anon, authenticated;
revoke all on table public.draw from public, anon, authenticated;
grant select (id, drawn, drawn_at) on table public.draw to anon, authenticated;
drop function if exists public.lookup_match(text);
alter table public.people drop column if exists private_token_hash;
alter table public.people add column browser_session_hash text;
alter table public.people
  add constraint people_no_self_match check (match_id is null or match_id <> id);
create unique index people_match_id_unique_idx
  on public.people (match_id)
  where match_id is not null;
create unique index people_browser_session_hash_idx
  on public.people (browser_session_hash)
  where browser_session_hash is not null;

create table public.match_ip_rate_limits (
  ip_hash text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0)
);
alter table public.match_ip_rate_limits enable row level security;
revoke all on table public.match_ip_rate_limits from public, anon, authenticated;

-- Expose only people who have not yet drawn, without exposing match_id.
create or replace function public.list_available_people()
returns table (id uuid, name text)
language sql
security definer
set search_path = ''
as $$
  select person.id, person.name
  from public.people as person
  where person.match_id is null
  order by person.created_at;
$$;

revoke all on function public.list_available_people() from public, anon, authenticated;
grant execute on function public.list_available_people() to anon, authenticated;

create or replace function public.get_session_match(p_session_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_SESSION';
  end if;

  select jsonb_build_object(
    'matched', true,
    'personName', person.name,
    'matchName', matched.name
  )
  into result
  from public.people as person
  join public.people as matched on matched.id = person.match_id
  where person.browser_session_hash = p_session_hash;

  return coalesce(result, jsonb_build_object('matched', false));
end;
$$;

revoke all on function public.get_session_match(text) from public, anon, authenticated;
grant execute on function public.get_session_match(text) to anon, authenticated;

-- Once matching starts, enrollment through privileged database clients is closed too.
create or replace function public.people_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(1);
  if (select draw.drawn from public.draw as draw where draw.id = 1)
    or exists (select 1 from public.people as person where person.match_id is not null) then
    raise exception 'DRAW_CLOSED';
  end if;
  if (select count(*) from public.people) >= 30 then
    raise exception 'DRAW_FULL';
  end if;
  return new;
end;
$$;

create or replace function public.match_one(
  p_person_id uuid,
  p_session_hash text,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_id uuid;
  recipient_name text;
  existing_match jsonb;
  rate_window timestamptz;
  ip_requests integer;
begin
  perform pg_advisory_xact_lock(1);

  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_SESSION';
  end if;

  select jsonb_build_object(
    'matchName', matched.name,
    'personName', person.name,
    'alreadyMatched', true
  )
  into existing_match
  from public.people as person
  join public.people as matched on matched.id = person.match_id
  where person.browser_session_hash = p_session_hash;
  if existing_match is not null then
    return existing_match;
  end if;

  if (select draw.drawn from public.draw as draw where draw.id = 1) then
    raise exception 'ALREADY_DRAWN';
  end if;

  if not exists (
    select 1 from public.people as person
    where person.id = p_person_id and person.match_id is null
  ) then
    raise exception 'ALREADY_MATCHED';
  end if;

  if (select count(*) from public.people as person) < 2 then
    raise exception 'NEED_TWO';
  end if;

  rate_window := date_trunc('hour', now());
  delete from public.match_ip_rate_limits as limits
  where limits.window_started_at < rate_window - interval '24 hours';
  insert into public.match_ip_rate_limits as limits (ip_hash, window_started_at, request_count)
  values (p_ip_hash, rate_window, 1)
  on conflict (ip_hash) do update
  set request_count = case
        when limits.window_started_at = excluded.window_started_at then limits.request_count + 1
        else 1
      end,
      window_started_at = excluded.window_started_at
  returning request_count into ip_requests;

  if ip_requests > 30 then
    return jsonb_build_object('error', 'RATE_LIMITED');
  end if;

  select recipient.id, recipient.name
  into recipient_id, recipient_name
  from public.people as recipient
  where recipient.id <> p_person_id
    and not exists (
      select 1 from public.people as assigned
      where assigned.match_id = recipient.id
    )
    -- Preserve a valid final assignment when only two people remain.
    and not exists (
      select 1
      from public.people as last_giver
      where last_giver.match_id is null
        and last_giver.id <> p_person_id
        and (select count(*) from public.people as pending
             where pending.match_id is null and pending.id <> p_person_id) = 1
        and exists (
          select 1 from public.people as last_recipient
          where last_recipient.id = last_giver.id
            and last_recipient.id <> recipient.id
            and not exists (
              select 1 from public.people as assigned_last
              where assigned_last.match_id = last_recipient.id
            )
        )
    )
  order by random()
  limit 1;

  if recipient_id is null then
    raise exception 'NO_MATCH_CANDIDATE';
  end if;

  update public.people as person
  set match_id = recipient_id,
      browser_session_hash = p_session_hash
  where person.id = p_person_id;

  update public.draw as draw
  set drawn = true, drawn_at = now()
  where draw.id = 1
    and not exists (
      select 1 from public.people as pending
      where pending.match_id is null
    );

  return jsonb_build_object('matchName', recipient_name);
end;
$$;

revoke all on function public.match_one(uuid, text, text) from public, anon, authenticated;
grant execute on function public.match_one(uuid, text, text) to anon, authenticated;

-- Disable the old all-at-once draw entry point.
revoke all on function public.perform_draw(text) from public, anon, authenticated;
