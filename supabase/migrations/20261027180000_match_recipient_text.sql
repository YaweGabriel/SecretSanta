alter table public.people
  add column matched_to_name text;

update public.people as giver
set matched_to_name = recipient.name
from public.people as recipient
where giver.match_id = recipient.id;

create or replace function public.set_matched_to_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.match_id is null then
    new.matched_to_name := null;
  else
    select recipient.name
    into new.matched_to_name
    from public.people as recipient
    where recipient.id = new.match_id;

    if new.matched_to_name is null then
      raise exception 'MATCH_RECIPIENT_NOT_FOUND';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.set_matched_to_name() from public, anon, authenticated;

create trigger people_match_name_on_insert
before insert on public.people
for each row
execute function public.set_matched_to_name();

create trigger people_match_name_on_update
before update of match_id on public.people
for each row
execute function public.set_matched_to_name();
