create or replace function public.list_draw_roster()
returns table (id uuid, name text)
language sql
security definer
set search_path = ''
as $$
  select person.id, person.name
  from public.people as person
  order by person.created_at;
$$;

revoke all on function public.list_draw_roster() from public, anon, authenticated;
grant execute on function public.list_draw_roster() to anon, authenticated;
