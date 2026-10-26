alter function public.people_before_insert() set search_path = public;
alter function public.check_host_secret(text) set search_path = public;

revoke select on table public.draw from anon, authenticated;
grant select (id, drawn, drawn_at) on table public.draw to anon, authenticated;
